'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const KIT = path.resolve(__dirname, '..');
const INSTALL = path.join(KIT, 'install.js');
const BOARD = path.join(KIT, 'kit', 'hooks', 'board.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-test-'));
const results = [];

function check(name, cond, detail) {
  results.push((cond ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + String(detail).replace(/\s+$/, '')));
}

function safe(name, fn) {
  try {
    fn();
  } catch (e) {
    check(name + ' — исключение', false, String(e && e.stack).split('\n').slice(0, 2).join(' '));
  }
}

function mk(name) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir, rel, text) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

function read(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch (e) {
    return null;
  }
}

function json(dir, rel) {
  const t = read(dir, rel);
  if (t === null) return null;
  try {
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch (e) {
    return null;
  }
}

// nvm4w иногда подсовывает node его собственный exe как скрипт: в stderr «node.exe:1 … SyntaxError». Это не результат теста — повторяем запуск.
const NODE_SHIM_GLITCH_RE = /node\.exe:1\r?\n[\s\S]*SyntaxError: Invalid or unexpected token/;

function spawnNode(args) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', cwd: KIT });
    if (!r.error && r.status !== null && !NODE_SHIM_GLITCH_RE.test(r.stderr || '')) {
      return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
    }
    results.push('NOTE повтор spawn (' + (r.error ? r.error.message : r.status === null ? 'status null' : 'глюк шима node') + ')');
  }
  return { status: null, out: '', err: 'spawn не удался' };
}

function run(args) {
  return spawnNode([INSTALL].concat(args));
}

function git(dir, args) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = cp.spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8' });
    if (!r.error && r.status !== null) return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
    results.push('NOTE повтор spawn git (' + (r.error ? r.error.message : 'status null') + ')');
  }
  return { status: null, out: '', err: 'spawn git не удался' };
}

function listAll(dir) {
  const out = [];
  const walk = (d, pre) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      out.push(pre + e.name);
      if (e.isDirectory()) walk(path.join(d, e.name), pre + e.name + '/');
    }
  };
  walk(dir, '');
  return out.sort();
}

function lines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

function count(ls, value) {
  return ls.filter((l) => l.trim() === value).length;
}

const BLOCK = fs.readFileSync(path.join(KIT, 'kit', 'gitignore.block'), 'utf8').replace(/\n+$/, '');

// T1 — B1
safe('T1', function () {
  const d = mk('fix2-t1');
  write(d, '.gitignore', ['node_modules/', '.claude', 'dist/', '/.claude/', '.claude/*', '**/.claude/', '# claude-workflow-kit: заметка', ''].join('\n'));
  git(d, ['init', '-q']);
  const r1 = run(['install', d]);
  check('T1 install exit 0', r1.status === 0, 'exit ' + r1.status + ' ' + r1.err);
  const ls = lines(read(d, '.gitignore'));
  check('T1 одна секция кита', count(ls, '# claude-workflow-kit:start') === 1, ls.join(' | '));
  const idx = ls.indexOf('# claude-workflow-kit:start');
  check('T1 секция на месте первой .claude', idx === 1 && ls[0] === 'node_modules/', 'idx=' + idx);
  check(
    'T1 лишних .claude-строк нет',
    count(ls, '.claude') === 0 && count(ls, '/.claude/') === 0 && count(ls, '**/.claude/') === 0 && count(ls, '.claude/*') === 1,
    ls.join(' | ')
  );
  check('T1 dist/ и чужой комментарий целы', count(ls, 'dist/') === 1 && count(ls, '# claude-workflow-kit: заметка') === 1, ls.join(' | '));
  check('T1 ui-ux-pro-max SKILL.md установлен', fs.existsSync(path.join(d, '.claude', 'skills', 'ui-ux-pro-max', 'SKILL.md')));
  check('T1 ui-ux-pro-max search.py установлен', fs.existsSync(path.join(d, '.claude', 'skills', 'ui-ux-pro-max', 'scripts', 'search.py')));
  check('T1 ui-ux-pro-max styles.csv установлен', fs.existsSync(path.join(d, '.claude', 'skills', 'ui-ux-pro-max', 'data', 'styles.csv')));
  check('T1 ui-ux-pro-max LICENSE установлен', fs.existsSync(path.join(d, '.claude', 'skills', 'ui-ux-pro-max', 'LICENSE')));
  const ci1 = git(d, ['check-ignore', '-v', '.claude/agents/impl-opus.md']);
  check('T1 агент не игнорируется', ci1.status === 1 && ci1.out.trim() === '', 'exit ' + ci1.status + ' out=' + ci1.out.trim());
  const ci2 = git(d, ['check-ignore', '-v', '.claude/settings.local.json']);
  check('T1 settings.local.json игнорируется', ci2.status === 0, 'exit ' + ci2.status + ' ' + ci2.out.trim());
  const r2 = run(['install', d]);
  const total = (r2.out.match(/итого изменений: \d+ из \d+/) || [''])[0];
  check('T1 повторный install без изменений', /итого изменений: 0 /.test(r2.out), total);
  const s1 = run(['status', d]);
  check('T1 status exit 0', s1.status === 0, 'exit ' + s1.status + '\n' + s1.out);
  fs.appendFileSync(path.join(d, '.gitignore'), '.claude/\n');
  const s2 = run(['status', d]);
  check('T1 status видит дописанную .claude/', s2.status === 1 && /отличается\s+\.gitignore/.test(s2.out), 'exit ' + s2.status + ' ' + (s2.out.match(/.*\.gitignore.*/) || [''])[0]);
  const r3 = run(['update', d]);
  const s3 = run(['status', d]);
  check('T1 update чинит', r3.status === 0 && s3.status === 0 && count(lines(read(d, '.gitignore')), '.claude/') === 0, 'update ' + r3.status + ' status ' + s3.status);
});

// T2 — B2
safe('T2', function () {
  const d = mk('fix2-t2');
  write(d, '.claude/settings.json', '{"hooks":{"UserPromptSubmit":"oops"}}\n');
  const before = listAll(d);
  const r = run(['install', d]);
  const after = listAll(d);
  check('T2 install exit 1', r.status === 1, 'exit ' + r.status);
  check('T2 сообщение про hooks.UserPromptSubmit', /hooks\.UserPromptSubmit не массив/.test(r.err), r.err.trim());
  check('T2 ни одного нового файла', before.join(',') === after.join(','), after.join(','));
  check('T2 settings.json не тронут', read(d, '.claude/settings.json') === '{"hooks":{"UserPromptSubmit":"oops"}}\n');
});

// T3 — N1 BOM
safe('T3', function () {
  const d = mk('fix2-t3');
  const settings = { permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }] } };
  write(d, '.claude/settings.json', '\ufeff' + JSON.stringify(settings, null, 2) + '\n');
  const r = run(['install', d]);
  check('T3 install с BOM exit 0', r.status === 0, 'exit ' + r.status + ' ' + r.err);
  const buf = fs.readFileSync(path.join(d, '.claude', 'settings.json'));
  check('T3 файл записан без BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), 'bytes ' + buf.slice(0, 3).join(','));
  const data = json(d, '.claude/settings.json');
  const foreign = data && data.hooks.PreToolUse[0].hooks[0].command === 'echo foreign';
  check('T3 чужой хук цел', foreign, JSON.stringify(data && data.hooks.PreToolUse));
  const kit = data && data.hooks.UserPromptSubmit;
  check('T3 хуки кита добавлены', !!kit && kit[0].hooks.length === 2, JSON.stringify(kit && kit[0].hooks.map((h) => h.args[0])));
});

// T4 — N2 + N3 node
safe('T4', function () {
  const d = mk('fix2-t4');
  const r1 = run(['install', d, '--node', './node']);
  check('T4 битый --node exit 1', r1.status === 1, 'exit ' + r1.status + ' ' + r1.err.trim());
  check('T4 ничего не записано', listAll(d).length === 0, listAll(d).join(','));
  const r2 = run(['install', d, '--node', process.execPath]);
  check('T4 install с валидным --node', r2.status === 0, 'exit ' + r2.status + ' ' + r2.err);
  const cmd1 = json(d, '.claude/settings.json').hooks.UserPromptSubmit[0].hooks[0].command;
  check('T4 command = указанный node', cmd1 === process.execPath, cmd1);
  check('T4 kit.json помнит node', json(d, '.claude/kit.json').node === process.execPath, JSON.stringify(json(d, '.claude/kit.json')));
  const r3 = run(['update', d]);
  const cmd2 = json(d, '.claude/settings.json').hooks.UserPromptSubmit[0].hooks[0].command;
  check('T4 update без флага не сбрасывает node', r3.status === 0 && cmd2 === process.execPath, 'exit ' + r3.status + ' command=' + cmd2);
  const s = run(['status', d]);
  check('T4 status exit 0', s.status === 0, 'exit ' + s.status + '\n' + s.out);
});

// T5 — N3 design_skill
safe('T5', function () {
  const d = mk('fix2-t5');
  const r1 = run(['install', d, '--no-design-skill']);
  check('T5 install --no-design-skill', r1.status === 0, 'exit ' + r1.status + ' ' + r1.err);
  check('T5 kit.json design_skill=false', json(d, '.claude/kit.json').design_skill === false, JSON.stringify(json(d, '.claude/kit.json')));
  const s = run(['status', d]);
  check('T5 status без флага exit 0', s.status === 0, 'exit ' + s.status + '\n' + s.out);
  check('T5 status не требует скилла', !/(отсутствует|нет в ките).*emil-design-eng/.test(s.out), (s.out.match(/.*emil-design-eng.*/g) || []).join(' / '));
  const r2 = run(['update', d]);
  check('T5 update без флага не ставит скилл', r2.status === 0 && !fs.existsSync(path.join(d, '.claude', 'skills', 'emil-design-eng')), 'exit ' + r2.status);
  const r3 = run(['update', d, '--design-skill']);
  check('T5 update --design-skill ставит скилл', r3.status === 0 && fs.existsSync(path.join(d, '.claude', 'skills', 'emil-design-eng', 'SKILL.md')), 'exit ' + r3.status);
  check('T5 kit.json design_skill=true', json(d, '.claude/kit.json').design_skill === true, JSON.stringify(json(d, '.claude/kit.json')));
});

// T6 — N4 чужой хук с похожим хвостом
safe('T6', function () {
  const d = mk('fix2-t6');
  const foreign = { type: 'command', command: 'node', args: ['C:/other/vendor/.claude/hooks/board.js'] };
  write(d, '.claude/settings.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [foreign] }] } }, null, 2) + '\n');
  const r1 = run(['install', d]);
  const hasForeign = (data) =>
    JSON.stringify(data).indexOf('C:/other/vendor/.claude/hooks/board.js') >= 0;
  check('T6 install exit 0', r1.status === 0, 'exit ' + r1.status + ' ' + r1.err);
  check('T6 чужой хук на месте после install', hasForeign(json(d, '.claude/settings.json')), JSON.stringify(json(d, '.claude/settings.json')));
  const r2 = run(['uninstall', d]);
  check('T6 uninstall exit 0', r2.status === 0, 'exit ' + r2.status + ' ' + r2.err);
  check('T6 чужой хук на месте после uninstall', hasForeign(json(d, '.claude/settings.json')), JSON.stringify(json(d, '.claude/settings.json')));
});

// T7 — N5 board id
safe('T7', function () {
  const d = mk('fix2-t7');
  write(d, 'tasks/VC-001.md', '---\nid: VC-042\ntitle: Проверка ID\nstatus: in_progress\nsize: S\nupdated: 2026-09-16\n---\n\nтело\n');
  const r = spawnNode([BOARD, d, '--print']);
  const out = r.out;
  check('T7 задача под ID из имени файла', out.indexOf('[VC-001](VC-001.md)') >= 0, (out.match(/.*VC-001.*/g) || []).join(' / '));
  check('T7 секция «Не распознано»', out.indexOf('## Не распознано') >= 0 && /VC-001\.md.*id во frontmatter \(VC-042\) не совпадает с именем файла/.test(out), (out.match(/.*не совпадает.*/g) || []).join(' / '));
  check('T7 следующий ID от имени файла', out.indexOf('Следующий ID: VC-002') >= 0, (out.match(/Следующий ID.*/) || [''])[0]);
  check('T7 предупреждение в stderr', /не совпадает с именем файла/.test(r.err), r.err.trim());
});

// T8 — N6 косметика и удаление пустых файлов
safe('T8', function () {
  const a = mk('fix2-t8-empty');
  write(a, '.gitignore', '');
  const r1 = run(['install', a]);
  const gi = read(a, '.gitignore');
  check('T8a пустой .gitignore без ведущей пустой строки', r1.status === 0 && gi.indexOf('# claude-workflow-kit:start') === 0, JSON.stringify(gi.slice(0, 40)));

  const b = mk('fix2-t8-own');
  run(['install', b]);
  const r2 = run(['uninstall', b]);
  check('T8b uninstall exit 0', r2.status === 0, 'exit ' + r2.status + ' ' + r2.err);
  check('T8b CLAUDE.md кита удалён', !fs.existsSync(path.join(b, 'CLAUDE.md')), listAll(b).join(','));
  check('T8b settings.json кита удалён', !fs.existsSync(path.join(b, '.claude', 'settings.json')), listAll(b).join(','));

  const c = mk('fix2-t8-foreign');
  write(c, 'CLAUDE.md', '# Мой проект\n\nсвои правила\n');
  write(c, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2) + '\n');
  run(['install', c]);
  const r3 = run(['uninstall', c]);
  const claude = read(c, 'CLAUDE.md');
  const st = json(c, '.claude/settings.json');
  check('T8c чужой CLAUDE.md остался', r3.status === 0 && claude !== null && claude.indexOf('# Мой проект') === 0 && claude.indexOf('claude-workflow-kit') < 0, JSON.stringify(claude));
  check('T8c чужой settings.json остался', st !== null && st.permissions.allow[0] === 'Bash' && st.hooks === undefined, JSON.stringify(st));

  const e = mk('fix2-t8-tail');
  write(e, '.gitignore', BLOCK + '\ntail.txt\n\n\n');
  const r4 = run(['uninstall', e]);
  check('T8d хвостовые пустые строки целы', r4.status === 0 && read(e, '.gitignore') === '.claude/\ntail.txt\n\n\n', JSON.stringify(read(e, '.gitignore')));
});

// T9 — регрессии
safe('T9', function () {
  const d = mk('fix2-t9');
  write(d, 'CLAUDE.md', '\ufeff# Проект\r\n\r\nсвои правила\r\n');
  write(d, '.gitignore', 'node_modules/\n.claude/\nsecrets.env\n');
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }] } }, null, 2) + '\n');
  const r1 = run(['install', d]);
  check('T9 install exit 0', r1.status === 0, 'exit ' + r1.status + ' ' + r1.err);
  const claude = read(d, 'CLAUDE.md');
  check('T9 CLAUDE.md: BOM, CRLF, свой текст, секция', claude.charCodeAt(0) === 0xfeff && /\r\n/.test(claude) && !/[^\r]\n/.test(claude) && claude.indexOf('# Проект') === 1 && /claude-workflow-kit:start/.test(claude), JSON.stringify(claude.slice(0, 30)));
  const gi = lines(read(d, '.gitignore'));
  check('T9 .gitignore: блок на месте .claude/, хвост цел', gi[1] === '# claude-workflow-kit:start' && gi[gi.length - 1] === 'secrets.env', gi.join(' | '));
  const r2 = run(['update', d]);
  check('T9 update идемпотентен', r2.status === 0 && /итого изменений: 0 /.test(r2.out), (r2.out.match(/итого изменений.*/) || [''])[0]);
  const s = run(['status', d]);
  check('T9 status exit 0', s.status === 0, 'exit ' + s.status + '\n' + s.out);
  const r3 = run(['uninstall', d]);
  const claude2 = read(d, 'CLAUDE.md');
  const st = json(d, '.claude/settings.json');
  const gi2 = lines(read(d, '.gitignore'));
  check('T9 uninstall exit 0', r3.status === 0, 'exit ' + r3.status + ' ' + r3.err);
  check('T9 CLAUDE.md остался без секции', claude2 !== null && claude2.indexOf('# Проект') === 1 && claude2.indexOf('claude-workflow-kit') < 0, JSON.stringify(claude2));
  check('T9 settings.json: чужой хук цел, хуков кита нет', st.hooks.PreToolUse[0].hooks[0].command === 'echo foreign' && st.hooks.UserPromptSubmit === undefined && st.permissions.allow[0] === 'Bash', JSON.stringify(st));
  check('T9 .gitignore вернулся к .claude/', gi2.join('|') === 'node_modules/|.claude/|secrets.env', gi2.join('|'));
  check('T9 файлы кита удалены', !fs.existsSync(path.join(d, '.claude', 'agents')) && !fs.existsSync(path.join(d, '.claude', 'hooks')), listAll(d).join(','));
  check('T9 tasks/ и docs/ остались', fs.existsSync(path.join(d, 'tasks', 'README.md')) && fs.existsSync(path.join(d, 'docs', 'decisions.md')), listAll(d).join(','));
});

safe('T10', function () {
  const d = mk('fix2-t10');
  const legacy = { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/task-context.js"', timeout: 10 };
  write(d, '.claude/settings.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [legacy] }] } }, null, 2) + '\n');
  const s1 = run(['status', d]);
  check('T10 status предупреждает про однострочный хук', /в старой однострочной форме/.test(s1.err), s1.err.trim());
  const r = run(['update', d]);
  const data = json(d, '.claude/settings.json');
  const flat = JSON.stringify(data);
  check('T10 update перевёл legacy в args-форму', r.status === 0 && flat.indexOf('$CLAUDE_PROJECT_DIR/.claude/hooks/task-context.js"') < 0 && flat.indexOf('${CLAUDE_PROJECT_DIR}/.claude/hooks/task-context.js') >= 0, flat);
  const s2 = run(['status', d]);
  check('T10 status после update exit 0', s2.status === 0 && !/однострочной/.test(s2.err), 'exit ' + s2.status + ' ' + s2.err.trim());
});

safe('T11', function () {
  const d = mk('fix2-t11');
  const r1 = run(['install', d, '--node', process.execPath]);
  check('T11 install с валидным --node', r1.status === 0, 'exit ' + r1.status + ' ' + r1.err);
  const kitJsonPath = path.join(d, '.claude', 'kit.json');
  const data = json(d, '.claude/kit.json');
  data.node = path.join(d, 'no-such-node.exe');
  fs.writeFileSync(kitJsonPath, JSON.stringify(data, null, 2) + '\n');
  const r2 = run(['update', d]);
  check('T11 update без --node с битым kit.json exit 0', r2.status === 0, 'exit ' + r2.status + ' ' + r2.err);
  check('T11 update предупреждает про node', /node не найден/.test(r2.err), r2.err.trim());
  const r3 = run(['update', d, '--node', path.join(d, 'no-such-node.exe')]);
  check('T11 update с явным битым --node exit 1', r3.status === 1, 'exit ' + r3.status + ' ' + r3.err.trim());
});

const SPEC = path.join(KIT, 'kit', 'hooks', 'spec.js');
const GUARD = path.join(KIT, 'kit', 'hooks', 'orchestrator-guard.js');

function spec(args) {
  return spawnNode([SPEC].concat(args));
}

const FILLED_SPEC = [
  '---',
  'id: VC-001',
  'title: Экспорт CSV',
  'status: draft',
  'approved:',
  'updated: 2026-09-18',
  '---',
  '# VC-001 — Экспорт CSV: спека',
  '',
  'Задача: tasks/VC-001.md.',
  '',
  '## Цель',
  'Админ выгружает список игроков в CSV одной кнопкой.',
  '',
  '## Трактовка и допущения',
  'Выгрузка синхронная, до 10 000 строк.',
  '',
  '## Не делаем',
  'Фильтры и выбор колонок — не в этой задаче.',
  '',
  '## Поведение',
  'Кнопка «Экспорт» в списке игроков; пустой список даёт файл с одной строкой заголовка; нет доступа — 403.',
  '',
  '## Контракты',
  '`GET /admin/players/export.csv` → `text/csv; charset=utf-8`, колонки `id,name,createdAt`.',
  '',
  '## Ограничения',
  'Node 18+, лимит 10 000 строк, тексты на русском.',
  '',
  '## Что меняется / что не меняется',
  '| Было | Станет |',
  '|---|---|',
  '| нет экспорта | кнопка и эндпоинт |',
  '',
  '## Зоны работ',
  '| Зона | Файлы | Потребляет | Производит | Исполнитель | Проверка |',
  '|---|---|---|---|---|---|',
  '| сервер | src/admin/export.ts | PlayerRepo.list() | GET /admin/players/export.csv | impl-opus | npm test |',
  '',
  '## Тесты',
  'test/admin/export.test.ts: пустой список → одна строка заголовка; 3 игрока → 4 строки.',
  '',
  '## Критерии приёмки',
  '- [ ] Админ нажимает «Экспорт» и получает CSV с колонками id,name,createdAt.',
  '',
  '## Открытые вопросы',
  '- Кодировка: решено: utf-8 с BOM.',
  '',
].join('\n');

// T12 — шаблон спеки: install создаёт, update дописывает недостающий, существующий не трогает
safe('T12', function () {
  const d = mk('spec-t12');
  const r1 = run(['install', d]);
  check('T12 install создал docs/specs/_template.md', r1.status === 0 && fs.existsSync(path.join(d, 'docs', 'specs', '_template.md')), 'exit ' + r1.status + ' ' + r1.err);
  check('T12 install скопировал spec.js', fs.existsSync(path.join(d, '.claude', 'hooks', 'spec.js')));
  check('T12 install скопировал скиллы spec и debug', fs.existsSync(path.join(d, '.claude', 'skills', 'spec', 'SKILL.md')) && fs.existsSync(path.join(d, '.claude', 'skills', 'debug', 'SKILL.md')));
  check('T12 шаблон задачи с полем spec', /^spec\s*:/m.test(read(d, 'tasks/_template.md')));

  const e = mk('spec-t12-upgrade');
  run(['install', e]);
  fs.rmSync(path.join(e, 'docs', 'specs'), { recursive: true, force: true });
  write(e, 'tasks/_template.md', '---\nid: VC-000\ntitle: Старый шаблон\nsize: M\nstatus: backlog\n---\n');
  write(e, 'docs/decisions.md', '# Мой журнал\n');
  const r2 = run(['update', e]);
  check('T12 update создал недостающий docs/specs/_template.md', r2.status === 0 && fs.existsSync(path.join(e, 'docs', 'specs', '_template.md')), 'exit ' + r2.status + ' ' + r2.err);
  check('T12 update не тронул существующие project-owned', read(e, 'docs/decisions.md') === '# Мой журнал\n' && read(e, 'tasks/_template.md').indexOf('Старый шаблон') >= 0);
  check('T12 update предупреждает про spec: в старом шаблоне', /нет поля spec/.test(r2.err), r2.err.trim());
  const r3 = run(['update', e]);
  check('T12 повторный update без изменений', r3.status === 0 && /итого изменений: 0 /.test(r3.out), (r3.out.match(/итого изменений.*/) || [''])[0]);
});

// T13 — spec.js: new / check / approve
safe('T13', function () {
  const d = mk('spec-t13');
  run(['install', d]);
  write(d, 'tasks/VC-001.md', '---\nid: VC-001\ntitle: Экспорт CSV\nsize: M\ntype: feature\nstatus: discuss\nspec:              # путь ставит spec.js new\ncreated: 2026-09-18\nupdated: 2026-09-18\n---\n# VC-001 — Экспорт CSV\n');
  const r0 = spec(['new', 'VC-001', 'Bad Slug', '--root', d]);
  check('T13 new с плохим slug exit 1', r0.status === 1 && /slug/.test(r0.err), 'exit ' + r0.status + ' ' + r0.err.trim());
  const r1 = spec(['new', 'VC-001', 'export-csv', '--root', d]);
  check('T13 new exit 0', r1.status === 0, 'exit ' + r1.status + ' ' + r1.err);
  const specText = read(d, 'docs/specs/VC-001-export-csv.md');
  check('T13 new создал спеку с id и title', specText !== null && /^id: VC-001$/m.test(specText) && /^title: Экспорт CSV$/m.test(specText) && /^# VC-001 — Экспорт CSV: спека$/m.test(specText), specText === null ? 'нет файла' : specText.slice(0, 120));
  check('T13 new прописал spec: в задаче', /^spec: docs\/specs\/VC-001-export-csv\.md$/m.test(read(d, 'tasks/VC-001.md')), (read(d, 'tasks/VC-001.md').match(/^spec.*$/m) || [''])[0]);
  const r2 = spec(['new', 'VC-001', 'export-csv', '--root', d]);
  check('T13 повторный new exit 1', r2.status === 1 && /уже есть/.test(r2.err), 'exit ' + r2.status + ' ' + r2.err.trim());
  const r3 = spec(['new', 'VC-099', '--root', d]);
  check('T13 new без задачи exit 1', r3.status === 1 && /нет файла tasks\/VC-099\.md/.test(r3.err), 'exit ' + r3.status + ' ' + r3.err.trim());

  const c1 = spec(['check', 'VC-001', '--root', d]);
  check('T13 check пустой спеки exit 1', c1.status === 1, 'exit ' + c1.status + '\n' + c1.out);
  check('T13 check видит пустые разделы и текст шаблона', /раздел «Цель» пуст/.test(c1.out) && /текст шаблона не заменён/.test(c1.out) && /нет ни одного пункта/.test(c1.out), c1.out);
  const a1 = spec(['approve', 'VC-001', '--root', d]);
  check('T13 approve пустой спеки exit 1, статус не менялся', a1.status === 1 && /^status: draft$/m.test(read(d, 'docs/specs/VC-001-export-csv.md')), 'exit ' + a1.status);

  write(d, 'docs/specs/VC-001-export-csv.md', FILLED_SPEC);
  const c2 = spec(['check', 'VC-001', '--root', d]);
  check('T13 check заполненной спеки exit 0', c2.status === 0 && /^ok docs\/specs\/VC-001-export-csv\.md \(status: draft\)/.test(c2.out), 'exit ' + c2.status + '\n' + c2.out);

  write(d, 'docs/specs/VC-001-export-csv.md', FILLED_SPEC.replace('- Кодировка: решено: utf-8 с BOM.', '- Кодировка: utf-8 или cp1251?'));
  const c3 = spec(['check', 'docs/specs/VC-001-export-csv.md', '--root', d]);
  check('T13 check по пути видит открытый вопрос', c3.status === 1 && /открытый вопрос без «решено»/.test(c3.out), c3.out);
  write(d, 'docs/specs/VC-001-export-csv.md', FILLED_SPEC.replace('Node 18+, лимит 10 000 строк', 'Node 18+, лимит TBD'));
  const c4 = spec(['check', 'VC-001', '--root', d]);
  check('T13 check видит заглушку TBD', c4.status === 1 && /заглушка/.test(c4.out), c4.out);

  write(d, 'docs/specs/VC-001-export-csv.md', FILLED_SPEC);
  const a2 = spec(['approve', 'VC-001', '--by', 'CEO', '--root', d]);
  const approved = read(d, 'docs/specs/VC-001-export-csv.md');
  check('T13 approve exit 0', a2.status === 0 && /утверждена/.test(a2.out), 'exit ' + a2.status + ' ' + a2.out + a2.err);
  check('T13 approve выставил status и approved', /^status: approved$/m.test(approved) && /^approved: \d{4}-\d{2}-\d{2} CEO$/m.test(approved), (approved.match(/^(status|approved):.*$/gm) || []).join(' | '));
  check('T13 approve не тронул тело спеки', approved.indexOf('## Критерии приёмки') >= 0 && approved.indexOf('Админ выгружает список игроков') >= 0);
  const c5 = spec(['check', 'VC-001', '--root', d]);
  check('T13 check после approve exit 0 со статусом approved', c5.status === 0 && /status: approved/.test(c5.out), c5.out);

  write(d, 'tasks/VC-002.md', '---\nid: VC-002\ntitle: Без спеки\nsize: M\nstatus: discuss\n---\n');
  const c6 = spec(['check', 'VC-002', '--root', d]);
  check('T13 check задачи без поля spec exit 1', c6.status === 1 && /нет поля spec/.test(c6.err), 'exit ' + c6.status + ' ' + c6.err.trim());
});

// T14 — гейт спеки в стоп-хуке: селфтест хука и сценарий по установленному проекту
safe('T14', function () {
  const st = spawnNode([GUARD, 'selftest']);
  check('T14 селфтест хука exit 0', st.status === 0, 'exit ' + st.status + '\n' + st.out);
  check('T14 селфтест содержит кейсы гейта спеки', /PASS caseD1/.test(st.out) && /PASS caseD9/.test(st.out) && !/FAIL/.test(st.out), (st.out.match(/.*case[D]\d.*/g) || []).join(' / '));

  const d = mk('spec-t14');
  run(['install', d]);
  write(d, 'tasks/VC-001.md', '---\nid: VC-001\ntitle: Экспорт CSV\nsize: M\nstatus: approved\nspec: docs/specs/VC-001-export-csv.md\n---\n');
  write(d, 'docs/specs/VC-001-export-csv.md', FILLED_SPEC.replace('status: draft', 'status: approved'));
  const guard = require(GUARD);
  const transcript = path.join(d, 'transcript.jsonl');
  const entries = (prompt) => [
    { type: 'user', message: { role: 'user', content: 'сделай VC-001' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Заспавнил: impl-opus · opus · high — VC-001' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'impl-opus', description: 'VC-001', prompt: prompt, run_in_background: true } }] } },
  ];
  const savedEnv = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    fs.writeFileSync(transcript, entries('Задача VC-001. Спека: docs/specs/VC-001-export-csv.md, зона «сервер».').map((e) => JSON.stringify(e)).join('\n') + '\n');
    const ok = guard.runStop({ transcript_path: transcript, stop_hook_active: false, cwd: d });
    check('T14 путь к утверждённой спеке в брифе — не блокирует', ok.block === false, ok.reason);
    fs.writeFileSync(transcript, entries('Задача VC-001, сделай по спеке.').map((e) => JSON.stringify(e)).join('\n') + '\n');
    const blocked = guard.runStop({ transcript_path: transcript, stop_hook_active: false, cwd: d });
    check('T14 бриф без пути к спеке — блокирует с причиной D', blocked.block === true && /не указан в брифе/.test(blocked.reason), blocked.reason);
    process.env.CLAUDE_PROJECT_DIR = d;
    const viaEnv = guard.runStop({ transcript_path: transcript, stop_hook_active: false, cwd: path.join(d, 'src') });
    check('T14 корень берётся из CLAUDE_PROJECT_DIR', viaEnv.block === true, viaEnv.reason);
  } finally {
    if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedEnv;
  }
});

// T15 — frontmatter: пустое значение с комментарием
safe('T15', function () {
  const board = require(BOARD);
  const parsed = board.parseFrontmatter('---\nid: VC-001\nspec:              # docs/specs/VC-001-x.md\nsize: M            # S | M | L\ntitle: "Bug #42"\n---\n');
  check('T15 spec: с комментарием — пустое значение', parsed.data && parsed.data.spec === '', JSON.stringify(parsed));
  check('T15 size с комментарием — значение без комментария', parsed.data && parsed.data.size === 'M', JSON.stringify(parsed));
  check('T15 title в кавычках с # цел', parsed.data && parsed.data.title === 'Bug #42', JSON.stringify(parsed));
});

let failed = 0;
try {
  failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
  process.stdout.write(results.join('\n') + '\n');
  process.stdout.write('ИТОГО: ' + (results.length - failed) + ' PASS, ' + failed + ' FAIL\n');
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
