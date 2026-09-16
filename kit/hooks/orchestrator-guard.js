'use strict';

// Хук Claude Code, следит за дисциплиной оркестратора.
// Режимы (process.argv[2]): remind (UserPromptSubmit), stop (Stop), report <transcript_path>, selftest.
// Регистрация remind/stop в settings.json делается отдельно, этот файл её не трогает.

const fs = require('fs');
const os = require('os');
const path = require('path');

const READ_LIMIT = 5;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const SPAWN_REGEX = /заспавнил\s*:/i;

const REMIND_TEXT = '[orchestrator-guard] Режим: техлид-оркестратор (правила: секция claude-workflow-kit в CLAUDE.md проекта). Поиск, код, тесты, ревью, критика постановки и дизайн — агентам: explore-opus, impl-sonnet, impl-opus, review-opus, product-critic, arch-critic, ui-designer; запуск только в фоне (run_in_background: true) с немедленным завершением хода. Себе: проектирование, бриф, 2–3 вызова codegraph, короткие git-проверки, приёмка. В финальном сообщении хода на каждого запущенного агента строка «Заспавнил: <тип> · <модель> · <effort> — <задача>». Файл задачи tasks/<ID>.md обновлять после каждого шага.';

const LOG_PATH = path.join(os.tmpdir(), 'orchestrator-guard.log');

const TEMP_FILES = [];

function debugLog(...args) {
  if (process.env.ORCHESTRATOR_GUARD_DEBUG !== '1') return;
  try {
    const line = `[${new Date().toISOString()}] ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`;
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {}
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch (e) {
    return '';
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRealUserMessage(entry) {
  if (entry.type !== 'user') return false;
  if (entry.isSidechain === true) return false;
  if (entry.isMeta === true) return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    let hasText = false;
    let hasToolResult = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') hasText = true;
      if (block.type === 'tool_result') hasToolResult = true;
    }
    return hasText && !hasToolResult;
  }
  return false;
}

function getUserMessageText(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join(' ');
  }
  return '';
}

function collapseWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function parseTranscript(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (e) {}
  }
  return entries;
}

function buildTurns(entries) {
  const userIndices = [];
  for (let i = 0; i < entries.length; i++) {
    if (isRealUserMessage(entries[i])) userIndices.push(i);
  }

  if (userIndices.length === 0) {
    return [{ userText: '', entries: entries.slice() }];
  }

  const turns = [];
  for (let i = 0; i < userIndices.length; i++) {
    const start = userIndices[i];
    const end = i + 1 < userIndices.length ? userIndices[i + 1] : entries.length;
    turns.push({
      userText: collapseWhitespace(getUserMessageText(entries[start])).slice(0, 80),
      entries: entries.slice(start + 1, end),
    });
  }
  return turns;
}

function evaluateTurn(turnEntries) {
  const spawnGlobalRegex = new RegExp(SPAWN_REGEX.source, 'gi');

  let textAll = '';
  let readCount = 0;
  let agentCount = 0;
  const agentCalls = [];
  const foregroundAgents = [];

  for (const entry of turnEntries) {
    if (entry.isSidechain === true) continue;
    if (entry.isMeta === true) continue;
    if (entry.type !== 'assistant') continue;

    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text') {
        textAll += block.text || '';
        continue;
      }

      if (block.type === 'tool_use') {
        const name = block.name;

        if (AGENT_TOOLS.has(name)) {
          agentCount++;
          const input = block.input || {};
          const call = { subagent_type: input.subagent_type, description: input.description };
          agentCalls.push(call);
          if (input.run_in_background === false) {
            foregroundAgents.push(call);
          }
        } else if (READ_TOOLS.has(name)) {
          readCount++;
        }
      }
    }
  }

  const spawnCount = (textAll.match(spawnGlobalRegex) || []).length;

  const violations = [];
  if (agentCount > 0 && spawnCount < agentCount) violations.push('A');
  if (agentCount === 0 && readCount > READ_LIMIT) violations.push('B');
  if (foregroundAgents.length > 0) violations.push('C');

  return { violations, readCount, agentCount, spawnCount, agentCalls, foregroundAgents };
}

function evaluateTranscript(text) {
  const entries = parseTranscript(text);
  const turns = buildTurns(entries);
  const lastTurn = turns[turns.length - 1];
  const result = evaluateTurn(lastTurn.entries);

  return Object.assign(result, {
    entriesCount: entries.length,
    turnsCount: turns.length,
    lastTurnEntriesCount: lastTurn.entries.length,
  });
}

function buildReason(evalResult) {
  const reasons = [];

  if (evalResult.violations.includes('A')) {
    const list = evalResult.agentCalls
      .map((v) => `${v.subagent_type || '?'} — ${v.description || '?'}`)
      .join('; ');
    reasons.push(
      `[orchestrator-guard] В этом ходе запущено агентов: ${evalResult.agentCount}, а строк «Заспавнил: <тип> · <модель> · <effort> — <задача>» в тексте хода: ${evalResult.spawnCount} (нужно не меньше числа агентов). Запущены: ${list}. Сейчас: допиши строку для каждого агента в финальном сообщении хода и заверши ход.`
    );
  }

  if (evalResult.violations.includes('B')) {
    reasons.push(
      `[orchestrator-guard] За этот ход ${evalResult.readCount} вызовов Read/Grep/Glob и ни одного агента. Ты оркестратор: поиск и чтение кода делают агенты (explore-opus и другие). Если это была приёмка диффа или короткая проверка — скажи это пользователю одной фразой и заверши ход. Если нет — напиши бриф и запусти агента.`
    );
  }

  if (evalResult.violations.includes('C')) {
    const list = evalResult.foregroundAgents
      .map((v) => `${v.subagent_type || '?'} — ${v.description || '?'}`)
      .join('; ');
    reasons.push(
      `[orchestrator-guard] Agent запущен в foreground: ${list}. Пользователь не видит текст между вызовами инструментов, поэтому агентов запускай в фоне (run_in_background: true) и сразу завершай ход финальным сообщением со строкой «Заспавнил: …». Уведомление о завершении агента придёт само.`
    );
  }

  return reasons.join('\n\n');
}

function runStop(input) {
  try {
    if (input && input.stop_hook_active === true) {
      debugLog('runStop: stop_hook_active=true, skip');
      return { block: false, reason: '' };
    }

    const transcriptPath = input && input.transcript_path;
    if (!transcriptPath) {
      debugLog('runStop: no transcript_path');
      return { block: false, reason: '' };
    }

    let text;
    try {
      text = stripBom(fs.readFileSync(transcriptPath, 'utf8'));
    } catch (e) {
      debugLog('runStop: cannot read transcript_path', transcriptPath, String(e));
      return { block: false, reason: '' };
    }

    const evalResult = evaluateTranscript(text);
    debugLog('runStop: evaluated', {
      readCount: evalResult.readCount,
      agentCount: evalResult.agentCount,
      spawnCount: evalResult.spawnCount,
      violations: evalResult.violations,
      turnsCount: evalResult.turnsCount,
      lastTurnEntriesCount: evalResult.lastTurnEntriesCount,
      entriesCount: evalResult.entriesCount,
    });

    if (evalResult.violations.length === 0) {
      return { block: false, reason: '' };
    }

    return { block: true, reason: buildReason(evalResult) };
  } catch (e) {
    debugLog('runStop: exception', String(e && e.stack ? e.stack : e));
    return { block: false, reason: '' };
  }
}

function modeRemind() {
  readStdin();
  process.stdout.write(REMIND_TEXT + '\n');
  process.exit(0);
}

function modeStop() {
  let raw = '';
  try {
    raw = readStdin();
  } catch (e) {
    process.exit(0);
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    process.exit(0);
    return;
  }

  const result = runStop(input);
  if (result.block) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }) + '\n');
  }
  process.exit(0);
}

function modeReport(transcriptPath) {
  if (!transcriptPath) {
    process.exit(0);
    return;
  }

  let text;
  try {
    text = stripBom(fs.readFileSync(transcriptPath, 'utf8'));
  } catch (e) {
    process.exit(0);
    return;
  }

  const entries = parseTranscript(text);
  const turns = buildTurns(entries);

  turns.forEach((turn, idx) => {
    const evalResult = evaluateTurn(turn.entries);
    const violationsStr = evalResult.violations.length > 0 ? evalResult.violations.join(',') : '-';
    let line = `#${idx + 1} | "${turn.userText}" | reads=${evalResult.readCount} agents=${evalResult.agentCount} spawn=${evalResult.spawnCount} violations=${violationsStr}`;
    if (evalResult.violations.includes('A')) {
      const types = evalResult.agentCalls.map((v) => v.subagent_type || '?').join(',');
      line += ` | A:[${types}]`;
    }
    if (evalResult.violations.includes('C')) {
      const types = evalResult.foregroundAgents.map((v) => v.subagent_type || '?').join(',');
      line += ` | C:[${types}]`;
    }
    process.stdout.write(line + '\n');
  });

  process.exit(0);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function makeEntry(overrides) {
  return Object.assign(
    {
      type: 'assistant',
      isSidechain: false,
      isMeta: false,
      message: { role: 'assistant', content: [] },
    },
    overrides
  );
}

function userTextEntry(text) {
  return {
    type: 'user',
    isSidechain: false,
    isMeta: false,
    message: { role: 'user', content: text },
  };
}

function assistantTextEntry(text) {
  return makeEntry({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

function assistantThinkingEntry(text) {
  return makeEntry({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } });
}

function assistantToolUseEntry(name, input) {
  return makeEntry({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: input || {} }] },
  });
}

function toJsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function writeTempTranscript(name, entries) {
  const filePath = path.join(os.tmpdir(), `orchestrator-guard-selftest-${name}-${process.pid}.jsonl`);
  fs.writeFileSync(filePath, toJsonl(entries), 'utf8');
  TEMP_FILES.push(filePath);
  return filePath;
}

function modeSelftest() {
  const cases = [];

  cases.push({
    name: 'case1_agent_with_spawn_line_before',
    run: () => {
      const entries = [
        userTextEntry('сделай задачу'),
        assistantTextEntry('Заспавнил: explore-opus · opus · high — найти X'),
        assistantToolUseEntry('Agent', { subagent_type: 'explore-opus', description: 'найти X' }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case1', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block');
    },
  });

  cases.push({
    name: 'case2_agent_without_spawn_line',
    run: () => {
      const entries = [
        userTextEntry('сделай задачу'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'починить баг' }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case2', entries), stop_hook_active: false });
      assert(r.block === true, 'expected block A');
      assert(r.reason.includes('impl-sonnet'), 'reason should include subagent_type');
    },
  });

  cases.push({
    name: 'case3_seven_reads_no_agent',
    run: () => {
      const entries = [userTextEntry('поищи в коде')];
      for (let i = 0; i < 7; i++) entries.push(assistantToolUseEntry('Read', { file_path: `f${i}.js` }));
      const r = runStop({ transcript_path: writeTempTranscript('case3', entries), stop_hook_active: false });
      assert(r.block === true, 'expected block B');
      assert(r.reason.includes('7 вызовов'), 'reason should mention 7 calls');
    },
  });

  cases.push({
    name: 'case4_seven_reads_plus_agent_with_line',
    run: () => {
      const entries = [userTextEntry('поищи и запусти агента')];
      for (let i = 0; i < 7; i++) entries.push(assistantToolUseEntry('Read', { file_path: `f${i}.js` }));
      entries.push(assistantTextEntry('Заспавнил: impl-opus · opus · high — реализовать'));
      entries.push(assistantToolUseEntry('Agent', { subagent_type: 'impl-opus', description: 'реализовать' }));
      const r = runStop({ transcript_path: writeTempTranscript('case4', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block');
    },
  });

  cases.push({
    name: 'case5_stop_hook_active_true',
    run: () => {
      const entries = [
        userTextEntry('сделай задачу'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'починить баг' }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case5', entries), stop_hook_active: true });
      assert(r.block === false, 'expected no block due to stop_hook_active');
    },
  });

  cases.push({
    name: 'case6_violation_in_previous_turn_only',
    run: () => {
      const entries = [
        userTextEntry('первый ход'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'без строки' }),
        userTextEntry('второй ход, чистый'),
        assistantTextEntry('просто текст, без агентов и без чтения'),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case6', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block, violation is in previous turn');
    },
  });

  cases.push({
    name: 'case7_sidechain_ignored',
    run: () => {
      const entries = [
        userTextEntry('сделай задачу'),
        Object.assign(assistantToolUseEntry('Agent', { subagent_type: 'sub-agent', description: 'внутри субагента' }), {
          isSidechain: true,
        }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case7', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block, sidechain entries ignored');
    },
  });

  cases.push({
    name: 'case8_spawn_line_after_agent_call',
    run: () => {
      const entries = [
        userTextEntry('сделай задачу'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'починить баг' }),
        assistantTextEntry('Заспавнил: impl-sonnet · sonnet · medium — починить баг'),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case8', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block, order within the turn no longer matters');
    },
  });

  cases.push({
    name: 'case9_tool_result_not_new_turn',
    run: () => {
      const entries = [
        userTextEntry('первый ход'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'без строки' }),
        {
          type: 'user',
          isSidechain: false,
          isMeta: false,
          message: { role: 'user', content: [{ type: 'tool_result', content: 'результат инструмента' }] },
        },
        assistantTextEntry('продолжение того же хода, без новой строки заспавнил'),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case9', entries), stop_hook_active: false });
      assert(r.block === true, 'expected block A, tool_result entry must not start a new turn');
    },
  });

  cases.push({
    name: 'case10_two_agents_one_spawn_line',
    run: () => {
      const entries = [
        userTextEntry('сделай две задачи'),
        assistantTextEntry('Заспавнил: impl-sonnet · sonnet · medium — таск1'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'таск1' }),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-opus', description: 'таск2' }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case10', entries), stop_hook_active: false });
      assert(r.block === true, 'expected block A, spawnCount 1 < agentCount 2');
      assert(r.reason.includes('impl-sonnet'), 'reason should include first subagent_type');
      assert(r.reason.includes('impl-opus'), 'reason should include second subagent_type');
    },
  });

  cases.push({
    name: 'case11_two_agents_two_spawn_lines',
    run: () => {
      const entries = [
        userTextEntry('сделай две задачи'),
        assistantTextEntry('Заспавнил: impl-sonnet · sonnet · medium — таск1'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'таск1' }),
        assistantTextEntry('Заспавнил: impl-opus · opus · high — таск2'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-opus', description: 'таск2' }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case11', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block, spawnCount 2 >= agentCount 2');
    },
  });

  cases.push({
    name: 'case12_foreground_agent',
    run: () => {
      const entries = [
        userTextEntry('запусти агента'),
        assistantTextEntry('Заспавнил: impl-sonnet · sonnet · medium — таск'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'таск', run_in_background: false }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case12', entries), stop_hook_active: false });
      assert(r.block === true, 'expected block C, run_in_background is explicitly false');
      assert(r.reason.includes('impl-sonnet'), 'reason should include subagent_type');
      assert(r.reason.includes('foreground'), 'reason should mention foreground');
    },
  });

  cases.push({
    name: 'case13_background_agent_spawn_line_after',
    run: () => {
      const entries = [
        userTextEntry('запусти агента в фоне'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'таск', run_in_background: true }),
        assistantTextEntry('Заспавнил: impl-sonnet · sonnet · medium — таск'),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case13', entries), stop_hook_active: false });
      assert(r.block === false, 'expected no block, background agent with spawn line in the turn text');
    },
  });

  cases.push({
    name: 'case14_spawn_line_only_in_thinking',
    run: () => {
      const entries = [
        userTextEntry('запусти агента'),
        assistantThinkingEntry('Заспавнил: impl-sonnet · sonnet · medium — таск'),
        assistantToolUseEntry('Agent', { subagent_type: 'impl-sonnet', description: 'таск', run_in_background: true }),
      ];
      const r = runStop({ transcript_path: writeTempTranscript('case14', entries), stop_hook_active: false });
      assert(r.block === true, 'expected block A, thinking blocks must not count as spawn line');
    },
  });

  let failed = 0;
  try {
    for (const c of cases) {
      try {
        c.run();
        process.stdout.write(`PASS ${c.name}\n`);
      } catch (e) {
        failed++;
        process.stdout.write(`FAIL ${c.name}: ${e.message}\n`);
      }
    }
  } finally {
    for (const filePath of TEMP_FILES) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {}
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

function main() {
  const mode = process.argv[2];
  if (mode === 'remind') return modeRemind();
  if (mode === 'stop') return modeStop();
  if (mode === 'report') return modeReport(process.argv[3]);
  if (mode === 'selftest') return modeSelftest();
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { evaluateTranscript, evaluateTurn, buildTurns, runStop };
