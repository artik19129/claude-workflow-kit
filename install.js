'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const KIT_ROOT = __dirname;
const KIT_DIR = path.join(KIT_ROOT, 'kit');
const COMMANDS = ['install', 'update', 'status', 'uninstall'];
const MARK_END = '<!-- claude-workflow-kit:end -->';
const SECTION_BODY = '(?:(?!claude-workflow-kit:start)[\\s\\S])*?';
const SECTION_SOURCE =
  '[ \\t]*<!--\\s*claude-workflow-kit:start' + SECTION_BODY + 'claude-workflow-kit:end\\s*-->[ \\t]*';
const SECTION_RE = new RegExp(SECTION_SOURCE);
const SECTION_RE_G = new RegExp(SECTION_SOURCE, 'g');
const GITIGNORE_START = '# claude-workflow-kit:start';
const GITIGNORE_END = '# claude-workflow-kit:end';
const GITIGNORE_FALLBACK = '.claude/';
const CLAUDE_IGNORE_RE = /^(?:\*\*\/)?\/?\.claude(?:\/\*?)?$/;
const PROJECT_DIR_VAR = 'CLAUDE_PROJECT_DIR';
const DESIGN_SKILL = 'emil-design-eng';
const DESIGN_SKILL_GLOB = ['Claude', 'local-agent-mode-sessions', 'skills-plugin'];

const report = [];

function log(kind, target) {
  report.push({ kind: kind, target: target });
}

function warn(message) {
  process.stderr.write('install.js: ' + message + '\n');
}

function fail(message) {
  process.stderr.write('install.js: ' + message + '\n');
  process.exit(1);
}

function readVersion() {
  try {
    return fs.readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim();
  } catch (e) {
    fail('не читается VERSION: ' + e.message);
  }
}

const VERSION = readVersion();
const MARK_START = '<!-- claude-workflow-kit:start v' + VERSION + ' -->';

function parseArgs(argv) {
  const opts = {
    command: null,
    target: 'claude',
    project: null,
    node: null,
    nodeFlag: false,
    dryRun: false,
    designSkill: true,
    designSkillSet: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' || arg.indexOf('--target=') === 0) {
      opts.target = arg === '--target' ? argv[++i] : arg.slice(9);
      if (!['claude', 'codex', 'both'].includes(opts.target)) fail('--target: ожидается claude, codex или both');
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--no-design-skill') {
      opts.designSkill = false;
      opts.designSkillSet = true;
    } else if (arg === '--design-skill') {
      opts.designSkill = true;
      opts.designSkillSet = true;
    } else if (arg === '--node') {
      i++;
      if (i >= argv.length) fail('у --node нет значения');
      opts.node = argv[i];
      opts.nodeFlag = true;
    } else if (arg.indexOf('--node=') === 0) {
      opts.node = arg.slice('--node='.length);
      opts.nodeFlag = true;
    } else if (arg.indexOf('--') === 0) {
      fail('неизвестный флаг: ' + arg);
    } else {
      positional.push(arg);
    }
  }
  opts.command = positional[0] || null;
  opts.project = positional[1] || null;
  return opts;
}

function usage() {
  return (
    'Использование: node install.js <install|update|status|uninstall> <путь-к-проекту>' +
    ' [--target claude|codex|both] [--node <путь к node>] [--design-skill|--no-design-skill] [--dry-run]'
  );
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function listFiles(dir) {
  const out = [];
  if (!isDir(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push.apply(out, listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

function toEol(text, eol) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, eol);
}

function writeFileSafe(file, content, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function kitOwnedFiles(opts) {
  const withDesignSkill = !opts || opts.designSkill !== false;
  const items = [];
  for (const src of listFiles(path.join(KIT_DIR, 'agents'))) {
    if (!/\.md$/i.test(src)) continue;
    items.push({ src: src, dest: path.join('.claude', 'agents', path.basename(src)) });
  }
  const skillsRoot = path.join(KIT_DIR, 'skills');
  for (const src of listFiles(skillsRoot)) {
    const relative = path.relative(skillsRoot, src);
    if (!withDesignSkill && relative.split(path.sep)[0] === DESIGN_SKILL) continue;
    items.push({ src: src, dest: path.join('.claude', 'skills', relative) });
  }
  for (const src of listFiles(path.join(KIT_DIR, 'hooks'))) {
    if (!/\.js$/i.test(src)) continue;
    items.push({ src: src, dest: path.join('.claude', 'hooks', path.basename(src)) });
  }
  return items;
}

function kitHookNames() {
  return listFiles(path.join(KIT_DIR, 'hooks'))
    .filter((f) => /\.js$/i.test(f))
    .map((f) => path.basename(f));
}

function designSkillDir() {
  return path.join(KIT_DIR, 'skills', DESIGN_SKILL);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function findDesignSkillInPluginCache() {
  const appData = process.env.APPDATA;
  if (process.platform !== 'win32' || !appData) return null;
  const root = path.join(appData, DESIGN_SKILL_GLOB[0], DESIGN_SKILL_GLOB[1], DESIGN_SKILL_GLOB[2]);
  if (!isDir(root)) return null;
  const subDirs = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name));
    } catch (e) {
      return [];
    }
  };
  for (const level1 of subDirs(root)) {
    for (const level2 of subDirs(level1)) {
      const candidate = path.join(level2, 'skills', DESIGN_SKILL);
      if (exists(path.join(candidate, 'SKILL.md'))) return candidate;
    }
  }
  return null;
}

function ensureDesignSkill(opts) {
  if (!opts.designSkill) return;
  const dir = designSkillDir();
  if (exists(path.join(dir, 'SKILL.md'))) return;
  const found = findDesignSkillInPluginCache();
  if (found === null) {
    warn('скилл ' + DESIGN_SKILL + ' не найден; положите его в kit/skills/' + DESIGN_SKILL + '/');
    return;
  }
  if (!opts.dryRun) copyDirRecursive(found, dir);
  log('взят из кэша плагина', 'kit/skills/' + DESIGN_SKILL);
}

function copyKitFile(project, item, dryRun) {
  const dest = path.join(project, item.dest);
  const target = rel(project, dest);
  const source = fs.readFileSync(item.src);
  let current = null;
  try {
    current = fs.readFileSync(dest);
  } catch (e) {}

  if (current && current.equals(source)) {
    log('без изменений', target);
    return;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source);
  }
  log(current ? 'обновлён' : 'создан', target);
}

function copyProjectFile(project, src, destRel, dryRun) {
  const dest = path.join(project, destRel);
  const target = rel(project, dest);
  if (exists(dest)) {
    log('пропущен (project-owned)', target);
    return;
  }
  writeFileSafe(dest, fs.readFileSync(src, 'utf8'), dryRun);
  log('создан', target);
}

function projectOwnedFiles() {
  const templates = path.join(KIT_DIR, 'templates');
  return [
    { src: path.join(templates, 'tasks', 'README.md'), dest: path.join('tasks', 'README.md') },
    { src: path.join(templates, 'tasks', '_template.md'), dest: path.join('tasks', '_template.md') },
    { src: path.join(templates, 'docs', 'decisions.md'), dest: path.join('docs', 'decisions.md') },
    { src: path.join(templates, 'docs', 'specs', '_template.md'), dest: path.join('docs', 'specs', '_template.md') },
  ];
}

function copyProjectFiles(project, dryRun) {
  projectOwnedFiles().forEach((item) => copyProjectFile(project, item.src, item.dest, dryRun));
}

function warnTaskTemplate(project) {
  const text = readText(path.join(project, 'tasks', '_template.md'));
  if (text !== null && !/^spec\s*:/m.test(stripBom(text))) {
    warn('в tasks/_template.md нет поля spec: — добавьте строку «spec:» во frontmatter (образец: kit/templates/tasks/_template.md)');
  }
}

function sectionText() {
  const file = path.join(KIT_DIR, 'CLAUDE.section.md');
  const text = readText(file);
  if (text === null) return null;
  return text.replace(/\r\n/g, '\n').replace(/\s*$/, '');
}

function countClaudeBlocks(text) {
  const starts = (text.match(/claude-workflow-kit:start/g) || []).length;
  const ends = (text.match(/claude-workflow-kit:end/g) || []).length;
  const blocks = (text.match(SECTION_RE_G) || []).length;
  if (starts !== ends || blocks !== starts) {
    fail(
      'в CLAUDE.md маркеры кита не парные (start: ' +
        starts +
        ', end: ' +
        ends +
        ', целых блоков: ' +
        blocks +
        '); почините разметку вручную, файл не изменён'
    );
  }
  return blocks;
}

function applyClaudeSection(project, dryRun) {
  const section = sectionText();
  if (section === null) {
    log('пропущен (нет kit/CLAUDE.section.md)', 'CLAUDE.md');
    return;
  }

  const file = path.join(project, 'CLAUDE.md');
  const current = readText(file);
  const eol = current === null ? '\n' : detectEol(current);
  const block = toEol([MARK_START, section, MARK_END].join('\n'), eol);

  if (current === null) {
    writeFileSafe(file, block + eol, dryRun);
    log('создан', 'CLAUDE.md');
    return;
  }

  const blocks = countClaudeBlocks(current);
  let next;
  if (blocks > 0) {
    let seen = 0;
    next = current.replace(SECTION_RE_G, () => (seen++ === 0 ? block : ''));
    if (blocks > 1) {
      warn('в CLAUDE.md было ' + blocks + ' блоков кита, лишние удалены');
      next = next.replace(/(\r?\n){3,}/g, eol + eol);
    }
  } else {
    const trailing = /\r?\n$/.test(current);
    const base = current.replace(/\s*$/, '');
    next = base === '' ? block : base + eol + eol + block;
    if (trailing || base === '') next += eol;
  }

  if (next === current) {
    log('без изменений', 'CLAUDE.md');
    return;
  }
  writeFileSafe(file, next, dryRun);
  log('обновлён', 'CLAUDE.md');
}

function removeClaudeSection(project, dryRun, allowDelete) {
  const file = path.join(project, 'CLAUDE.md');
  const current = readText(file);
  if (current === null || countClaudeBlocks(current) === 0) {
    log('без изменений', 'CLAUDE.md');
    return;
  }
  const eol = detectEol(current);
  const next = current.replace(SECTION_RE_G, '').replace(/(\r?\n){3,}/g, eol + eol).replace(/\s*$/, eol);
  if (allowDelete && stripBom(next).trim() === '') {
    if (!dryRun) fs.unlinkSync(file);
    log('удалён', 'CLAUDE.md');
    return;
  }
  writeFileSafe(file, next, dryRun);
  log('обновлён', 'CLAUDE.md');
}

function normalizeSlashes(value) {
  return String(value).replace(/\\/g, '/');
}

function endsWith(value, suffix) {
  return value.length >= suffix.length && value.slice(value.length - suffix.length) === suffix;
}

function hasProjectDirVar(value) {
  return typeof value === 'string' && value.indexOf(PROJECT_DIR_VAR) >= 0;
}

function hookKey(hook) {
  if (!hook || typeof hook !== 'object') return null;
  const hasArgs = Array.isArray(hook.args) && typeof hook.args[0] === 'string';
  const arg = hasArgs ? normalizeSlashes(hook.args[0]) : null;
  const command = typeof hook.command === 'string' ? normalizeSlashes(hook.command) : null;
  for (const name of kitHookNames()) {
    const suffix = '/.claude/hooks/' + name;
    if (hasArgs) {
      if (hasProjectDirVar(arg) && endsWith(arg, suffix)) return name;
    } else if (command !== null && hasProjectDirVar(command) && command.indexOf(suffix) >= 0) {
      return name;
    }
  }
  return null;
}

function isLegacyHook(hook) {
  return (
    hook &&
    typeof hook === 'object' &&
    !Array.isArray(hook.args) &&
    typeof hook.command === 'string' &&
    hasProjectDirVar(hook.command) &&
    normalizeSlashes(hook.command).indexOf('/.claude/hooks/') >= 0
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function sameHook(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function probeNode(nodePath, explicit) {
  const nodeCmd = nodePath || 'node';
  let result;
  try {
    result = childProcess.spawnSync(nodeCmd, ['-v'], { shell: false, encoding: 'utf8' });
  } catch (e) {
    result = { error: e };
  }
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : 'код выхода ' + result.status;
    if (explicit) {
      fail('--node ' + nodeCmd + ' не запускается без шелла (' + reason + '); файлы не изменены');
    }
    warn('node не найден без шелла, укажите --node <путь к node.exe> (' + nodeCmd + ': ' + reason + ')');
    return false;
  }
  log('node ок', nodeCmd + ' ' + String(result.stdout || '').trim());
  return true;
}

function loadHooksFragment(nodePath) {
  const file = path.join(KIT_DIR, 'settings.hooks.json');
  const text = readText(file);
  if (text === null) fail('не читается kit/settings.hooks.json');
  let parsed;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (e) {
    fail('kit/settings.hooks.json не парсится: ' + e.message);
  }
  const events = parsed.hooks || {};
  if (!nodePath) return events;
  for (const event of Object.keys(events)) {
    for (const group of events[event]) {
      for (const hook of group.hooks || []) {
        if (hook.command === 'node') hook.command = nodePath;
      }
    }
  }
  return events;
}

function readSettings(file) {
  const text = readText(file);
  if (text === null) return { data: {}, text: null };
  try {
    return { data: JSON.parse(stripBom(text)), text: text };
  } catch (e) {
    fail('.claude/settings.json не парсится: ' + e.message);
  }
}

function writeSettings(file, data, previousText, dryRun) {
  const eol = previousText === null ? '\n' : detectEol(previousText);
  const next = toEol(JSON.stringify(data, null, 2) + '\n', eol);
  if (previousText === next) {
    log('без изменений', '.claude/settings.json');
    return;
  }
  writeFileSafe(file, next, dryRun);
  log(previousText === null ? 'создан' : 'обновлён', '.claude/settings.json');
}

function settingsHooks(settings) {
  if (settings.hooks === undefined) return {};
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    fail('.claude/settings.json: ключ hooks не объект — почините вручную, файл не изменён');
  }
  return settings.hooks;
}

function mergeHooks(project, opts) {
  const file = path.join(project, '.claude', 'settings.json');
  const loaded = readSettings(file);
  const settings = loaded.data;
  const fragment = loadHooksFragment(opts.node);
  const hooks = settingsHooks(settings);

  for (const event of Object.keys(fragment)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      fail('.claude/settings.json: hooks.' + event + ' не массив — почините вручную, файл не изменён');
    }
    let groups = Array.isArray(hooks[event]) ? hooks[event] : [];

    const wanted = new Map();
    for (const group of fragment[event]) {
      for (const hook of group.hooks || []) wanted.set(hookKey(hook), hook);
    }
    const satisfied = new Set();

    groups = groups
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const kept = group.hooks.filter((h) => {
          const key = hookKey(h);
          if (key === null || !wanted.has(key)) return true;
          if (satisfied.has(key) || !sameHook(h, wanted.get(key))) return false;
          satisfied.add(key);
          return true;
        });
        return kept.length === group.hooks.length ? group : Object.assign({}, group, { hooks: kept });
      })
      .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);

    for (const group of fragment[event]) {
      const missing = (group.hooks || []).filter((h) => !satisfied.has(hookKey(h)));
      if (missing.length === 0) continue;
      groups.push(Object.assign({}, group, { hooks: missing }));
    }
    hooks[event] = groups;
  }
  settings.hooks = hooks;

  writeSettings(file, settings, loaded.text, opts.dryRun);
}

function removeHooks(project, dryRun, allowDelete) {
  const file = path.join(project, '.claude', 'settings.json');
  const loaded = readSettings(file);
  if (loaded.text === null) {
    log('без изменений', '.claude/settings.json');
    return;
  }
  const settings = loaded.data;
  const hooks = settingsHooks(settings);
  if (Object.keys(hooks).length === 0) {
    log('без изменений', '.claude/settings.json');
    return;
  }

  const isKitHook = (hook) => hookKey(hook) !== null;

  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = [];
    for (const group of hooks[event]) {
      if (!group || !Array.isArray(group.hooks)) {
        groups.push(group);
        continue;
      }
      const kept = group.hooks.filter((h) => !isKitHook(h));
      if (kept.length === 0) continue;
      groups.push(Object.assign({}, group, { hooks: kept }));
    }
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  if (allowDelete && Object.keys(settings).length === 0) {
    if (!dryRun) fs.unlinkSync(file);
    log('удалён', '.claude/settings.json');
    return;
  }
  writeSettings(file, settings, loaded.text, dryRun);
}

function gitignoreBlockLines() {
  const text = readText(path.join(KIT_DIR, 'gitignore.block'));
  if (text === null) fail('не читается kit/gitignore.block');
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
}

function findBlock(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.indexOf(GITIGNORE_END) === 0) {
      if (start >= 0) return { start: start, end: i };
      continue;
    }
    if (start < 0 && trimmed.indexOf(GITIGNORE_START) === 0) start = i;
  }
  if (start >= 0) {
    fail(
      'в .gitignore блок кита (строка ' +
        (start + 1) +
        ') не закрыт маркером «' +
        GITIGNORE_END +
        '» — почините вручную, файл не изменён'
    );
  }
  return null;
}

function splitGitignore(text) {
  return text.replace(/(\r?\n)$/, '').split(/\r?\n/);
}

function strayClaudeLines(lines, block) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (block && i >= block.start && i <= block.end) continue;
    if (CLAUDE_IGNORE_RE.test(lines[i].trim())) out.push(i);
  }
  return out;
}

function applyGitignore(project, dryRun) {
  const file = path.join(project, '.gitignore');
  const current = readText(file);
  const blockLines = gitignoreBlockLines();
  const eol = current === null ? '\n' : detectEol(current);

  if (current === null) {
    writeFileSafe(file, blockLines.join(eol) + eol, dryRun);
    log('создан', '.gitignore');
    return;
  }

  const lines = splitGitignore(current);
  const found = findBlock(lines);
  const strays = strayClaudeLines(lines, found);
  const anchor = found ? found.start : strays.length > 0 ? strays[0] : -1;

  const drop = new Set(strays);
  if (found) {
    for (let i = found.start; i <= found.end; i++) drop.add(i);
  }

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === anchor) result.push.apply(result, blockLines);
    if (drop.has(i)) continue;
    result.push(lines[i]);
  }

  if (anchor < 0) {
    if (result.every((l) => l.trim() === '')) result.length = 0;
    else if (result[result.length - 1].trim() !== '') result.push('');
    result.push.apply(result, blockLines);
  }

  const next = result.join(eol) + eol;
  if (next === current) {
    log('без изменений', '.gitignore');
    return;
  }
  writeFileSafe(file, next, dryRun);
  log('обновлён', '.gitignore');
}

function removeGitignore(project, dryRun) {
  const file = path.join(project, '.gitignore');
  const current = readText(file);
  if (current === null) {
    log('без изменений', '.gitignore');
    return;
  }
  const eol = detectEol(current);
  const lines = splitGitignore(current);
  const found = findBlock(lines);
  if (!found) {
    log('без изменений', '.gitignore');
    return;
  }
  lines.splice(found.start, found.end - found.start + 1, GITIGNORE_FALLBACK);
  const next = lines.length === 0 ? '' : lines.join(eol) + eol;
  writeFileSafe(file, next, dryRun);
  log('обновлён', '.gitignore');
}

function kitJsonFile(project) {
  return path.join(project, '.claude', 'kit.json');
}

function readKitJson(project) {
  const text = readText(kitJsonFile(project));
  if (text === null) return null;
  try {
    const data = JSON.parse(stripBom(text));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

function applyKitJsonDefaults(project, opts) {
  const previous = readKitJson(project);
  if (previous === null) return;
  if (opts.node === null && typeof previous.node === 'string' && previous.node !== '') {
    opts.node = previous.node;
  }
  if (!opts.designSkillSet && typeof previous.design_skill === 'boolean') {
    opts.designSkill = previous.design_skill;
  }
}

function writeKitJson(project, opts, created) {
  const file = kitJsonFile(project);
  const previousText = readText(file);
  const previous = readKitJson(project);
  let installedAt = new Date().toISOString();
  if (previous && previous.version === VERSION && previous.installed_at) {
    installedAt = previous.installed_at;
  }
  const inherit = (key, value) =>
    previous && typeof previous[key] === 'boolean' ? previous[key] : value;
  const data = {
    version: VERSION,
    installed_at: installedAt,
    node: opts.node === null ? null : opts.node,
    design_skill: opts.designSkill !== false,
    created_claude_md: inherit('created_claude_md', created.claudeMd),
    created_settings: inherit('created_settings', created.settings),
  };
  const next = JSON.stringify(data, null, 2) + '\n';
  if (next === previousText) {
    log('без изменений', '.claude/kit.json');
    return;
  }
  writeFileSafe(file, next, opts.dryRun);
  log(previousText === null ? 'создан' : 'обновлён', '.claude/kit.json');
}

function removeFile(project, relPath, dryRun) {
  const file = path.join(project, relPath);
  if (!exists(file)) return false;
  if (!dryRun) fs.unlinkSync(file);
  log('удалён', rel(project, file));
  return true;
}

function removeDir(project, relPath, dryRun) {
  const dir = path.join(project, relPath);
  if (!isDir(dir)) return false;
  if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
  log('удалён', rel(project, dir));
  return true;
}

function pruneEmptyDirs(project, dryRun) {
  if (dryRun) return;
  const roots = [
    path.join(project, '.claude', 'agents'),
    path.join(project, '.claude', 'hooks'),
    path.join(project, '.claude', 'skills'),
  ];
  const prune = (dir) => {
    if (!isDir(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  roots.forEach(prune);
}

function generateBoard(project, dryRun) {
  const board = require(path.join(KIT_DIR, 'hooks', 'board.js'));
  const file = path.join(project, 'tasks', '_index.md');
  const previous = readText(file);
  const content = board.renderBoard(project, { quiet: true });
  if (previous === content) {
    log('без изменений', 'tasks/_index.md');
    return;
  }
  writeFileSafe(file, content, dryRun);
  log(previous === null ? 'создан' : 'обновлён', 'tasks/_index.md');
}

function preflight(project, opts, checkNode) {
  gitignoreBlockLines();
  const fragment = loadHooksFragment(null);

  const claudeText = readText(path.join(project, 'CLAUDE.md'));
  if (claudeText !== null) countClaudeBlocks(claudeText);
  const gitignoreText = readText(path.join(project, '.gitignore'));
  if (gitignoreText !== null) findBlock(splitGitignore(gitignoreText));
  const settingsFile = path.join(project, '.claude', 'settings.json');
  if (readText(settingsFile) !== null) {
    const hooks = settingsHooks(readSettings(settingsFile).data);
    for (const event of Object.keys(fragment)) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
        fail('.claude/settings.json: hooks.' + event + ' не массив — почините вручную, файл не изменён');
      }
    }
  }

  if (checkNode) probeNode(opts.node, opts.nodeFlag);
}

function projectState(project) {
  return {
    claudeMd: !exists(path.join(project, 'CLAUDE.md')),
    settings: !exists(path.join(project, '.claude', 'settings.json')),
  };
}

function commandInstall(project, opts) {
  preflight(project, opts, true);
  const created = projectState(project);
  ensureDesignSkill(opts);
  kitOwnedFiles(opts).forEach((item) => copyKitFile(project, item, opts.dryRun));
  applyClaudeSection(project, opts.dryRun);
  mergeHooks(project, opts);
  applyGitignore(project, opts.dryRun);
  writeKitJson(project, opts, created);

  copyProjectFiles(project, opts.dryRun);
  warnTaskTemplate(project);
  generateBoard(project, opts.dryRun);
}

function commandUpdate(project, opts) {
  applyKitJsonDefaults(project, opts);
  preflight(project, opts, true);
  const created = projectState(project);
  ensureDesignSkill(opts);
  kitOwnedFiles(opts).forEach((item) => copyKitFile(project, item, opts.dryRun));
  applyClaudeSection(project, opts.dryRun);
  mergeHooks(project, opts);
  applyGitignore(project, opts.dryRun);
  writeKitJson(project, opts, created);
  copyProjectFiles(project, opts.dryRun);
  warnTaskTemplate(project);
  generateBoard(project, opts.dryRun);
}

function commandUninstall(project, opts) {
  preflight(project, opts, false);
  const installed = readKitJson(project) || {};
  const items = kitOwnedFiles();
  let removed = 0;
  for (const item of items) {
    if (removeFile(project, item.dest, opts.dryRun)) removed++;
  }
  if (!exists(path.join(designSkillDir(), 'SKILL.md'))) {
    removed += removeDir(project, path.join('.claude', 'skills', DESIGN_SKILL), opts.dryRun) ? 1 : 0;
  }
  if (removed === 0) log('без изменений', '.claude/agents, .claude/skills, .claude/hooks');
  removeFile(project, path.join('.claude', 'kit.json'), opts.dryRun);
  removeHooks(project, opts.dryRun, installed.created_settings === true);
  removeClaudeSection(project, opts.dryRun, installed.created_claude_md === true);
  removeGitignore(project, opts.dryRun);
  pruneEmptyDirs(project, opts.dryRun);
  log('пропущен (project-owned)', 'tasks/, docs/decisions.md, docs/specs/');
}

function commandStatus(project, opts) {
  applyKitJsonDefaults(project, opts);
  const installed = readKitJson(project);

  const lines = [];
  lines.push('кит:      ' + KIT_ROOT + ' (VERSION ' + VERSION + ')');
  lines.push('проект:   ' + project);
  if (installed === null) lines.push('установка: .claude/kit.json отсутствует');
  else {
    lines.push(
      'установка: версия ' +
        (installed.version || '?') +
        (installed.version === VERSION ? ' (совпадает)' : ' (отличается от ' + VERSION + ')') +
        ', ' +
        (installed.installed_at || '?')
    );
  }
  lines.push(
    'выбор:    node ' + (opts.node === null ? 'node (по умолчанию)' : opts.node) +
      ', скилл ' + DESIGN_SKILL + ': ' + (opts.designSkill ? 'да' : 'нет')
  );
  lines.push('');

  const rows = [];
  const items = kitOwnedFiles(opts);
  if (items.length === 0) lines.push('kit-owned файлов в ките нет');
  for (const item of items) {
    const dest = path.join(project, item.dest);
    let state;
    if (!exists(dest)) state = 'отсутствует';
    else {
      const same = fs.readFileSync(dest).equals(fs.readFileSync(item.src));
      state = same ? 'совпадает' : 'отличается';
    }
    rows.push({ state: state, target: rel(project, dest) });
  }

  if (opts.designSkill && !exists(path.join(designSkillDir(), 'SKILL.md'))) {
    rows.push({ state: 'нет в ките', target: '.claude/skills/' + DESIGN_SKILL });
  }

  const section = sectionText();
  const claudeText = readText(path.join(project, 'CLAUDE.md'));
  let sectionState;
  if (section === null) sectionState = 'нет в ките';
  else if (claudeText === null || !SECTION_RE.test(claudeText)) sectionState = 'отсутствует';
  else {
    const eol = detectEol(claudeText);
    const expected = toEol([MARK_START, section, MARK_END].join('\n'), eol);
    const actual = (claudeText.match(SECTION_RE) || [''])[0].trim();
    sectionState = actual === expected.trim() ? 'совпадает' : 'отличается';
  }
  rows.push({ state: sectionState, target: 'CLAUDE.md (секция кита)' });

  const settings = readSettings(path.join(project, '.claude', 'settings.json'));
  const fragment = loadHooksFragment(null);
  let total = 0;
  let present = 0;
  let legacy = 0;
  for (const event of Object.keys(fragment)) {
    const groups =
      settings.data.hooks && Array.isArray(settings.data.hooks[event]) ? settings.data.hooks[event] : [];
    const keys = new Set();
    for (const group of groups) {
      for (const hook of group && Array.isArray(group.hooks) ? group.hooks : []) {
        const key = hookKey(hook);
        if (key === null) continue;
        keys.add(key);
        if (isLegacyHook(hook)) legacy++;
      }
    }
    for (const group of fragment[event]) {
      for (const hook of group.hooks || []) {
        total++;
        if (keys.has(hookKey(hook))) present++;
      }
    }
  }
  rows.push({
    state: present === total ? 'совпадает' : present + ' из ' + total,
    target: '.claude/settings.json (хуки кита)',
  });

  const gitignoreText = readText(path.join(project, '.gitignore'));
  let gitignoreState;
  if (gitignoreText === null) gitignoreState = 'отсутствует';
  else {
    const gitignoreLines = splitGitignore(gitignoreText);
    const strays = strayClaudeLines(gitignoreLines, findBlock(gitignoreLines));
    gitignoreState = strays.length === 0 ? 'совпадает' : 'отличается';
    if (strays.length > 0) {
      warn(
        'в .gitignore вне блока кита строки, игнорирующие .claude: ' +
          strays.map((i) => 'строка ' + (i + 1) + ' «' + gitignoreLines[i].trim() + '»').join(', ') +
          ' — выполните update'
      );
    }
  }
  rows.push({ state: gitignoreState, target: '.gitignore: вне блока нет строк, игнорирующих .claude' });

  const width = rows.reduce((max, row) => Math.max(max, row.state.length), 0) + 2;
  for (const row of rows) lines.push(row.state.padEnd(width) + row.target);

  process.stdout.write(lines.join('\n') + '\n');
  if (legacy > 0) {
    warn('в .claude/settings.json ' + legacy + ' хук(ов) кита в старой однострочной форме — выполните update');
  }
  const broken = rows.filter((row) => row.state === 'отличается' || row.state === 'отсутствует').length;
  return broken > 0 || present !== total ? 1 : 0;
}

function printReport(opts) {
  if (report.length === 0) {
    process.stdout.write('нечего делать\n');
    return;
  }
  const prefix = opts.dryRun ? '[dry-run] ' : '';
  const width = report.reduce((max, entry) => Math.max(max, entry.kind.length), 0) + 2;
  for (const entry of report) {
    process.stdout.write(prefix + entry.kind.padEnd(width) + entry.target + '\n');
  }
  const changed = report.filter((e) => e.kind === 'создан' || e.kind === 'обновлён' || e.kind === 'удалён').length;
  process.stdout.write(prefix + 'итого изменений: ' + changed + ' из ' + report.length + '\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command || COMMANDS.indexOf(opts.command) < 0) {
    process.stderr.write(usage() + '\n');
    process.exit(1);
  }
  if (!opts.project) {
    process.stderr.write(usage() + '\n');
    process.exit(1);
  }

  const project = path.resolve(opts.project);
  if (!isDir(project)) fail('каталог проекта не найден: ' + project);
  if (!isDir(KIT_DIR)) fail('каталог кита не найден: ' + KIT_DIR);

  try {
    if (opts.target !== 'claude') {
      const codex = require('./lib/codex.js');
      codex.preflight(project, opts);
      if (opts.target === 'both' && opts.command !== 'status') preflight(project, opts, opts.command !== 'uninstall');
      if (opts.target === 'codex') {
        process.exit(codex.run(project, opts, VERSION));
      }
      if (opts.command === 'status') {
        const codexStatus = codex.run(project, opts, VERSION);
        process.exit(Math.max(codexStatus, commandStatus(project, opts)));
      }
    }
    if (opts.command === 'status') {
      process.exit(commandStatus(project, opts));
    }
    if (opts.command === 'install') commandInstall(project, opts);
    if (opts.command === 'update') commandUpdate(project, opts);
    if (opts.command === 'uninstall') commandUninstall(project, opts);
    if (opts.target === 'both') require('./lib/codex.js').run(project, opts, VERSION);
  } catch (e) {
    process.stderr.write('install.js: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
  }

  printReport(opts);
  process.exit(0);
}

if (require.main === module) {
  main();
}
