'use strict';

const fs = require('fs');

const board = require('./board.js');

const MAX_IN_WORK = 5;
const MAX_TITLE = 40;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function shortTitle(title) {
  if (title.length <= MAX_TITLE) return title;
  return title.slice(0, MAX_TITLE - 1).trimEnd() + '…';
}

function main() {
  readStdin();

  const root = board.resolveRoot(process.argv.slice(2));
  if (!fs.existsSync(board.tasksDir(root))) process.exit(0);

  let tasks;
  try {
    tasks = board.collectTasks(root, { quiet: true });
  } catch (e) {
    process.exit(0);
    return;
  }
  if (tasks.length === 0) process.exit(0);

  const groups = board.groupTasks(tasks);

  const inWork = groups.inWork
    .slice(0, MAX_IN_WORK)
    .map((t) => t.id + ' «' + shortTitle(t.title) + '» (' + t.status + ')')
    .join(', ');
  const rest = groups.inWork.length > MAX_IN_WORK ? ' и ещё ' + (groups.inWork.length - MAX_IN_WORK) : '';

  const parts = [
    'В работе: ' + (groups.inWork.length > 0 ? inWork + rest : 'нет'),
    'Ждёт CEO: ' + groups.waiting.length,
    'Бэклог: ' + groups.backlog.length,
  ];

  process.stdout.write('[tasks] ' + parts.join(' · ') + '\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}
