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

function spawnNode(args) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', cwd: KIT });
    if (!r.error && r.status !== null) return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
    results.push('NOTE повтор spawn (' + (r.error ? r.error.message : 'status null') + ')');
  }
  return { status: null, out: '', err: 'spawn не удался' };
}

function run(args) {
  return spawnNode([INSTALL].concat(args));
}

function git(dir, args) {
  const r = cp.spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
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

let failed = 0;
try {
  failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
  process.stdout.write(results.join('\n') + '\n');
  process.stdout.write('ИТОГО: ' + (results.length - failed) + ' PASS, ' + failed + ' FAIL\n');
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
