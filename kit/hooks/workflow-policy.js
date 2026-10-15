'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const board = require('./board.js');
const spec = require('./spec.js');
const PREFIX = '[workflow-kit] ';

function stateFile(root, input) {
  const key = crypto.createHash('sha256').update(root + '\0' + (input.session_id || 'unknown')).digest('hex');
  return path.join(os.tmpdir(), 'ai-workflow-kit', key + '.json');
}

function saved(root, input) {
  if (!input.session_id) return [];
  try {
    const ids = JSON.parse(fs.readFileSync(stateFile(root, input), 'utf8'));
    return Array.isArray(ids) && ids.every(id => typeof id === 'string' && /^VC-\d+$/.test(id)) ? ids : [];
  } catch (_) { return []; }
}

function save(root, input, ids) {
  if (!input.session_id) return;
  const file = stateFile(root, input);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ids));
}

function task(root, id) {
  const file = path.join(root, 'tasks', id + '.md');
  if (!/^VC-\d+$/.test(id) || !inside(root, file)) return { id, error: 'небезопасный путь задачи' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = board.parseFrontmatter(text);
    if (parsed.error) return { id, error: parsed.error };
    if (parsed.data.id !== id) return { id, error: 'id не совпадает с именем файла' };
    return { id, text, data: parsed.data };
  } catch (_) { return { id, error: 'файл задачи не найден или не читается' }; }
}

function selection(root, input) {
  const ids = saved(root, input);
  if (ids.length) return ids.map(id => task(root, id));
  const dir = path.join(root, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^VC-\d+\.md$/.test(name))
    .map(name => task(root, name.slice(0, -3)))
    .filter(t => t.error || !['done', 'backlog'].includes(t.data.status));
}

function specIssue(root, t) {
  if (t.error) return t.id + ': ' + t.error;
  if (!['S', 'M', 'L'].includes(t.data.size)) return t.id + ': неизвестный size';
  if (t.data.size === 'S') return null;
  const ref = (t.data.spec || '').replace(/\\/g, '/');
  if (!ref || !/^docs\/specs\/[^/]+\.md$/.test(ref)) return t.id + ': нужен spec: docs/specs/<ID>-<slug>.md';
  if (!inside(root, path.resolve(root, ref))) return t.id + ': путь спеки выходит из проекта или содержит ссылку';
  const checked = spec.checkSpec(root, ref);
  if (checked.info.status !== 'approved') return t.id + ': спека не утверждена (status: ' + (checked.info.status || 'отсутствует') + ')';
  if (!checked.info.data || checked.info.data.id !== t.id) return t.id + ': спека относится к другой задаче';
  if (!checked.info.data.approved) return t.id + ': отсутствует запись approved';
  if (checked.findings.length) return t.id + ': спека невалидна: ' + checked.findings.slice(0, 3).join('; ');
  return null;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return false;
  }
  return true;
}

function planningFile(root, cwd, file) {
  if (typeof file !== 'string' || !file) return false;
  const absolute = path.resolve(cwd || root, file);
  if (!inside(root, absolute)) return false;
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  return /^tasks\/(?:VC-\d+|_index|_template|README)\.md$/.test(relative) ||
    /^docs\/specs\/[^/]+\.md$/.test(relative) || relative === 'docs/decisions.md' ||
    /^docs\/memory\/[a-z0-9-]+\.md$/.test(relative);
}

function planningPatch(root, cwd, command) {
  const paths = [...String(command || '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1].trim());
  return paths.length > 0 && paths.every(file => planningFile(root, cwd, file));
}

function safeShell(command) {
  const text = String(command || '').trim();
  if (!text || /[;&|<>`\r\n$(){}]/.test(text)) return false;
  if (/^(?:pwd|Get-Location)\s*$/i.test(text)) return true;
  if (/^(?:Get-Content|Get-ChildItem|Test-Path|Select-String|cat|head|tail|ls|rg)\s/i.test(text)) {
    return !/(?:--pre(?:=|\s)|--hostname-bin(?:=|\s)|-exec\b|-o(?:utfile|utvariable|v)(?:\s|:)|--output)/i.test(text);
  }
  if (/^git\s+(?:status|diff|log|show|ls-files|rev-parse)\b/i.test(text)) return !/(?:--output|--ext-diff|--textconv)/i.test(text);
  if (/^node\s+(?:--version|-v)\s*$/.test(text)) return true;
  return /^node\s+["']?(?:\.\/)?(?:\.codex\/workflow|\.claude\/hooks)\/(?:board\.js(?:["']?\s+--print)?|spec\.js["']?\s+(?:new|check|approve)\s+VC-\d+(?:\s+[a-z0-9-]+)?)['"]?\s*$/i.test(text);
}

function explicitIds(text) {
  const match = /^Workflow-Task:\s*(VC-\d+(?:\s*,\s*VC-\d+)*)\s*$/im.exec(String(text || ''));
  if (match) return match[1].toUpperCase().split(/\s*,\s*/);
  const command = /(?:\$|\/)(?:task|spec|debug)\s+(VC-\d+)\b/i.exec(String(text || ''));
  return command ? [command[1].toUpperCase()] : [];
}

function context(event, message) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: PREFIX + message } };
}

function deny(message) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PREFIX + message } };
}

function acceptanceIssue(root, t) {
  const problem = specIssue(root, t);
  if (problem) return problem;
  const sections = spec.splitBody(t.text);
  const evidence = sections.find(s => /^Приёмка/.test(s.name));
  const body = evidence ? evidence.lines.join('\n') : '';
  if (!/(?:\b(?:node|npm|pnpm|yarn|pytest|python|cargo|go|dotnet|make)\b|ручн[а-я]* провер)/i.test(body) ||
      !/(?:код(?: выхода)?\s*[:=→—-]?\s*0|exit\s*[:=]?\s*0|\bPASS\b|успешн|пройден)/i.test(body)) {
    return t.id + ': в «Приёмка» нет команды/ручной проверки и результата';
  }
  const criteriaText = t.data.size === 'S' ? t.text : spec.readSpec(root, t.data.spec).text;
  const criteria = spec.splitBody(criteriaText).find(s => s.name === 'Критерии приёмки');
  if (!criteria || !criteria.lines.some(line => /^-\s+\[[xX]\]\s+\S/.test(line)) || criteria.lines.some(line => /^-\s+\[ \]/.test(line))) {
    return t.id + ': критерии приёмки не отмечены';
  }
  return null;
}

function handle(root, input) {
  const event = input.hook_event_name;
  if (event === 'UserPromptSubmit') {
    const chosen = explicitIds(input.prompt);
    const ids = chosen.length ? chosen : [...new Set((input.prompt || '').match(/\bVC-\d+\b/g) || [])];
    if (ids.length) save(root, input, ids);
    else if (/(?:\$|\/)task\s+new\b/.test(input.prompt || '')) save(root, input, []);
  }
  const tasks = selection(root, input);
  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    const summary = tasks.slice(0, 8).map(t => t.id + ': ' + (t.error || t.data.status + ', ' + t.data.size)).join('; ');
    return context(event, (summary || 'Нет активных задач.') + ' M/L: утверждённая спека до реализации. Бриф: Workflow-Task: VC-NNN. Done: проверка и критерии. Память: только релевантные домены workflow-memory и docs/memory.');
  }
  if (event === 'PreToolUse') {
    const tool = String(input.tool_name || '').split('.').pop();
    const args = input.tool_input || {};
    const command = typeof args === 'string' ? args : args.command || args.cmd;
    const paths = tool === 'apply_patch' ? [...String(command || '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1].trim()) :
      ['Edit', 'Write', 'MultiEdit'].includes(tool) && args.file_path ? [args.file_path] : [];
    const writtenTasks = paths.map(file => path.relative(root, path.resolve(input.cwd || root, file)).split(path.sep).join('/'))
      .map(file => /^tasks\/(VC-\d+)\.md$/.exec(file)?.[1]).filter(Boolean);
    if (tasks.length || writtenTasks.length) save(root, input, [...new Set([...tasks.map(t => t.id), ...writtenTasks])]);
    const spawn = ['spawn_agent', 'Agent', 'Task'].includes(tool);
    const continuation = ['followup_task', 'send_message', 'SendMessage'].includes(tool);
    const shell = ['Bash', 'PowerShell', 'exec_command', 'shell', 'shell_command', 'write_stdin'].includes(tool);
    if (!spawn && !continuation && !shell && !['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return {};
    const brief = args.prompt || args.message || args.content || '';
    const ids = (spawn || continuation) ? explicitIds(brief) : [];
    const targets = ids.length ? ids.map(id => task(root, id)) : tasks;
    const pending = targets.map(t => specIssue(root, t)).filter(Boolean);
    const planningRole = spawn && ['explore-opus', 'product-critic', 'arch-critic', 'ui-designer'].includes(args.agent_type || args.subagent_type);
    if (spawn && !planningRole && targets.some(t => t.data && ['M', 'L'].includes(t.data.size))) {
      if (!ids.length) pending.push('Бриф M/L должен содержать отдельную строку Workflow-Task: VC-NNN');
      for (const t of targets) {
        if (t.data && ['M', 'L'].includes(t.data.size) && t.data.spec && !String(brief).replace(/\\/g, '/').includes(t.data.spec.replace(/\\/g, '/'))) {
          pending.push(t.id + ': в брифе нет пути к спеке');
        }
      }
    }
    if (!pending.length) return {};
    if (planningRole) return {};
    if (tool === 'apply_patch' && planningPatch(root, input.cwd, command)) return {};
    if (['Edit', 'Write', 'MultiEdit'].includes(tool) && planningFile(root, input.cwd, args.file_path)) return {};
    if (shell && tool !== 'write_stdin' && safeShell(command)) {
      const helper = /^node\s/i.test(command) && !/^node\s+(?:--version|-v)\s*$/i.test(command);
      if (!helper || path.resolve(input.cwd || root) === path.resolve(root)) return {};
    }
    if (tool === 'write_stdin' && (!args.chars || args.chars === '\u0003')) return {};
    return deny(pending.join('; ') + '. Реализация/делегирование заблокированы. Заполните и согласуйте спеку; spec.js check, затем approve только после согласия пользователя. Не обходите блокировку другим инструментом.');
  }
  if (event === 'Stop' && !input.stop_hook_active) {
    const issues = tasks.filter(t => t.data && t.data.status === 'done').map(t => acceptanceIssue(root, t)).filter(Boolean);
    if (issues.length) return { decision: 'block', reason: PREFIX + issues.join('; ') + '. Запишите реальные результаты и критерии либо верните задачу в acceptance и сообщите, что осталось. Не выдумывайте свидетельства.' };
  }
  return {};
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    const root = path.resolve(__dirname, '..', '..');
    process.stdout.write(JSON.stringify(handle(root, input)));
  } catch (error) {
    process.stderr.write(PREFIX + 'ошибка проверки: ' + error.message + '\n');
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { handle, main, planningPatch, planningFile, safeShell, specIssue, acceptanceIssue, explicitIds };
