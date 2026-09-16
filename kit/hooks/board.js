'use strict';

const fs = require('fs');
const path = require('path');

const IN_WORK = ['approved', 'in_progress', 'review', 'acceptance'];
const WAITING = ['discuss', 'blocked'];
const BACKLOG = ['backlog'];
const DONE = ['done'];
const DONE_LIMIT = 20;
const KNOWN_STATUSES = new Set([].concat(IN_WORK, WAITING, BACKLOG, DONE));
const TASK_FILE_RE = /^VC-.+\.md$/i;
const TASK_ID_FILE_RE = /^VC-(\d+)\.md$/i;
const HOOKS_DIR_RE = /[\\/]\.claude[\\/]hooks$/;
const GENERATED_NOTE = '<!-- файл генерируется: node .claude/hooks/board.js — руками не править -->';

function tasksDir(root) {
  return path.join(root, 'tasks');
}

function resolveRoot(argv) {
  const positional = (argv || []).filter((a) => a.indexOf('--') !== 0);
  if (positional.length > 0) return path.resolve(positional[0]);
  if (HOOKS_DIR_RE.test(__dirname)) return path.resolve(__dirname, '..', '..');
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return process.cwd();
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseFrontmatter(text) {
  const lines = stripBom(text).split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { error: 'нет frontmatter' };
  }
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return { data: data };
    if (!line.trim()) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value.charAt(0);
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.charAt(value.length - 1) === quote) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt >= 0) value = value.slice(0, commentAt).trim();
    }
    data[m[1]] = value;
  }
  return { error: 'frontmatter не закрыт' };
}

function scanTasks(root, options) {
  const quiet = !!(options && options.quiet);
  const warn = (message) => {
    if (!quiet) process.stderr.write('board.js: ' + message + '\n');
  };
  const dir = tasksDir(root);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { tasks: [], unknown: [], names: [] };
  }

  const files = names.filter((n) => TASK_FILE_RE.test(n)).sort();
  const tasks = [];
  const unknown = [];
  const note = (name, reason) => {
    unknown.push({ file: name, reason: reason });
  };
  const skip = (name, reason) => {
    warn('пропущен tasks/' + name + ' — ' + reason);
    note(name, reason);
  };

  for (const name of files) {
    const file = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      skip(name, 'не читается: ' + e.message);
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (parsed.error) {
      skip(name, parsed.error);
      continue;
    }
    if (!parsed.data.id) {
      skip(name, 'нет поля id');
      continue;
    }

    const fileId = name.replace(/\.md$/i, '');
    if (parsed.data.id.trim() !== fileId) {
      const reason = 'id во frontmatter (' + parsed.data.id.trim() + ') не совпадает с именем файла';
      warn('tasks/' + name + ' — ' + reason + ', задача показана как ' + fileId);
      note(name, reason);
    }

    let status = (parsed.data.status || '').toLowerCase();
    if (!KNOWN_STATUSES.has(status)) {
      warn('tasks/' + name + ' — неизвестный статус «' + (parsed.data.status || '') + '», задача ушла в бэклог');
      status = 'backlog';
    }

    tasks.push({
      id: fileId,
      title: parsed.data.title || fileId,
      size: parsed.data.size || '—',
      status: status,
      updated: parsed.data.updated || '',
      file: name,
    });
  }
  return { tasks: tasks, unknown: unknown, names: files };
}

function collectTasks(root, options) {
  return scanTasks(root, options).tasks;
}

function groupTasks(tasks) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byUpdatedDesc = (a, b) => {
    if (a.updated === b.updated) return byId(a, b);
    return a.updated < b.updated ? 1 : -1;
  };

  const done = tasks.filter((t) => DONE.indexOf(t.status) >= 0).sort(byUpdatedDesc);

  return {
    inWork: tasks.filter((t) => IN_WORK.indexOf(t.status) >= 0).sort(byId),
    waiting: tasks.filter((t) => WAITING.indexOf(t.status) >= 0).sort(byId),
    backlog: tasks.filter((t) => BACKLOG.indexOf(t.status) >= 0).sort(byId),
    done: done.slice(0, DONE_LIMIT),
  };
}

function nextId(names) {
  let max = 0;
  for (const name of names || []) {
    const m = TASK_ID_FILE_RE.exec(name);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return 'VC-' + String(max + 1).padStart(3, '0');
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function renderSection(title, rows) {
  const out = ['## ' + title];
  if (rows.length === 0) {
    out.push('_нет задач_');
    out.push('');
    return out;
  }
  out.push('| ID | Задача | Размер | Статус | Обновлено |');
  out.push('|---|---|---|---|---|');
  for (const task of rows) {
    out.push(
      '| [' +
        escapeCell(task.id) +
        '](' +
        task.file +
        ') | ' +
        escapeCell(task.title) +
        ' | ' +
        escapeCell(task.size) +
        ' | ' +
        escapeCell(task.status) +
        ' | ' +
        escapeCell(task.updated) +
        ' |'
    );
  }
  out.push('');
  return out;
}

function renderUnknown(rows) {
  const out = ['## Не распознано'];
  out.push('| Файл | Причина |');
  out.push('|---|---|');
  for (const row of rows) {
    out.push('| [' + escapeCell(row.file) + '](' + row.file + ') | ' + escapeCell(row.reason) + ' |');
  }
  out.push('');
  return out;
}

function renderBoard(root, options) {
  const scan = scanTasks(root, options);
  const groups = groupTasks(scan.tasks);

  const out = ['# Доска задач', GENERATED_NOTE, '', 'Следующий ID: ' + nextId(scan.names), ''];
  out.push.apply(out, renderSection('В работе', groups.inWork));
  out.push.apply(out, renderSection('Ждёт CEO', groups.waiting));
  out.push.apply(out, renderSection('Бэклог', groups.backlog));
  out.push.apply(out, renderSection('Готово (последние ' + DONE_LIMIT + ')', groups.done));
  if (scan.unknown.length > 0) out.push.apply(out, renderUnknown(scan.unknown));

  return out.join('\n').replace(/\n+$/, '\n');
}

function writeBoard(root, options) {
  const dir = tasksDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '_index.md');
  const content = renderBoard(root, options);
  let previous = null;
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch (e) {}
  if (previous === content) return { file: file, changed: false, content: content };
  fs.writeFileSync(file, content, 'utf8');
  return { file: file, changed: true, content: content };
}

function main() {
  const args = process.argv.slice(2);
  const printOnly = args.indexOf('--print') >= 0;
  const root = resolveRoot(args);

  if (printOnly) {
    process.stdout.write(renderBoard(root));
    process.exit(0);
  }

  try {
    const result = writeBoard(root);
    process.stdout.write((result.changed ? 'обновлён ' : 'без изменений ') + result.file + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write('board.js: ' + e.message + '\n');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectTasks,
  scanTasks,
  groupTasks,
  parseFrontmatter,
  nextId,
  renderBoard,
  writeBoard,
  tasksDir,
  resolveRoot,
};
