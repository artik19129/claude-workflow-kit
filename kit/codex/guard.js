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
  try { return JSON.parse(fs.readFileSync(stateFile(root, input), 'utf8')); } catch (_) { return []; }
}

function save(root, input, ids) {
  const file = stateFile(root, input);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ids));
}

function task(root, id) {
  const file = path.join(root, 'tasks', id + '.md');
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
  const checked = spec.checkSpec(root, ref);
  if (checked.info.status !== 'approved') return t.id + ': спека не утверждена (status: ' + (checked.info.status || 'отсутствует') + ')';
  if (!checked.info.data || checked.info.data.id !== t.id) return t.id + ': спека относится к другой задаче';
  if (!checked.info.data.approved) return t.id + ': отсутствует запись approved';
  if (checked.findings.length) return t.id + ': спека невалидна: ' + checked.findings.slice(0, 3).join('; ');
  return null;
}

function planningPatch(root, cwd, command) {
  const paths = [...String(command || '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1].trim());
  return paths.length > 0 && paths.every(file => {
    const relative = path.relative(root, path.resolve(cwd || root, file)).split(path.sep).join('/');
    return /^tasks\/(?:VC-\d+|_index|_template|README)\.md$/.test(relative) ||
      /^docs\/specs\/[^/]+\.md$/.test(relative) || relative === 'docs/decisions.md';
  });
}

function safeShell(command) {
  const text = String(command || '').trim();
  if (!text || /[;&|<>`\r\n$(){}]/.test(text)) return false;
  if (/^(?:pwd|Get-Location)\s*$/i.test(text)) return true;
  if (/^(?:Get-Content|Get-ChildItem|Test-Path|Select-String|cat|head|tail|ls|rg)\s/i.test(text)) {
    return !/(?:--pre(?:=|\s)|--hostname-bin(?:=|\s)|-exec\b)/i.test(text);
  }
  if (/^git\s+(?:status|diff|log|show|ls-files|rev-parse)\b/i.test(text)) return !/(?:--output|--ext-diff|--textconv)/i.test(text);
  if (/^node\s+(?:--version|-v)\s*$/.test(text)) return true;
  return /^node\s+["']?(?:\.\/)?\.codex\/workflow\/(?:board\.js(?:["']?\s+--print)?|spec\.js["']?\s+(?:new|check|approve)\s+VC-\d+(?:\s+[a-z0-9-]+)?)['"]?\s*$/i.test(text);
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
    const ids = [...new Set((input.prompt || '').match(/\bVC-\d+\b/g) || [])];
    if (ids.length) save(root, input, ids);
    else if (/\$(?:task)\s+new\b/.test(input.prompt || '')) save(root, input, []);
  }
  const tasks = selection(root, input);
  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    const summary = tasks.slice(0, 8).map(t => t.id + ': ' + (t.error || t.data.status + ', ' + t.data.size)).join('; ');
    return context(event, (summary || 'Нет активных задач.') + ' Перед правками M/L нужна валидная approved-спека. Для выбора задачи укажите её ID в запросе. Плановые документы редактируйте через apply_patch; до апрува запускайте простые команды чтения по одной. Перед done запишите приёмку и отметьте критерии.');
  }
  if (event === 'PreToolUse') {
    if (tasks.length === 1) save(root, input, [tasks[0].id]);
    const tool = input.tool_name;
    const command = typeof input.tool_input === 'string' ? input.tool_input : (input.tool_input || {}).command;
    if (!['Bash', 'exec_command', 'shell', 'shell_command', 'apply_patch', 'Edit', 'Write', 'spawn_agent', 'Agent'].includes(tool)) return {};
    const pending = tasks.map(t => specIssue(root, t)).filter(Boolean);
    if (!pending.length) return {};
    if (tool === 'spawn_agent' && ['explore-opus', 'product-critic', 'arch-critic', 'ui-designer'].includes((input.tool_input || {}).agent_type)) return {};
    if (['apply_patch', 'Edit', 'Write'].includes(tool) && planningPatch(root, input.cwd, command)) return {};
    if (['Bash', 'exec_command', 'shell', 'shell_command'].includes(tool) && safeShell(command)) return {};
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
module.exports = { handle, main, planningPatch, safeShell, specIssue, acceptanceIssue };
