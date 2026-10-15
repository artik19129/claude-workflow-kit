'use strict';

const fs = require('fs');
const path = require('path');
const KIT = path.resolve(__dirname, '..', 'kit');
const MANIFEST = '.codex/workflow-kit.json';
const START = '<!-- ai-workflow-kit:codex:start -->';
const END = '<!-- ai-workflow-kit:codex:end -->';
const hooks = require('./codex-hooks.js');

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

function portable(text) {
  return text.replace(/^\uFEFF/, '').replace(/\.claude\/hooks\//g, '.codex/workflow/').replace(/\.claude\/skills\//g, '.agents/skills/');
}

function section(text) {
  text = text || '';
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(END) < text.indexOf(START))) {
    throw new Error('AGENTS.md: повреждены маркеры Codex workflow-kit');
  }
  return starts ? [text.indexOf(START), text.indexOf(END) + END.length] : null;
}

function managed(file) {
  return typeof file === 'string' && !file.includes('\\') && !file.split('/').includes('..') &&
    /^(?:\.agents\/skills\/[^/]+\/.+|\.codex\/workflow\/(?:board|spec|guard|workflow-policy)\.js|\.codex\/agents\/[a-z0-9-]+\.toml)$/.test(file);
}

function manifest(project) {
  const raw = read(path.join(project, MANIFEST));
  if (raw === null) return null;
  const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!data || !Array.isArray(data.files) || !data.files.every(managed)) {
    throw new Error('Некорректный ' + MANIFEST);
  }
  return data;
}

function safePath(project, relative) {
  let current = project;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Путь установки является ссылкой: ' + relative);
    }
  }
  return current;
}

function preflight(project, opts) {
  section(read(safePath(project, 'AGENTS.md')));
  safePath(project, MANIFEST);
  safePath(project, hooks.FILE);
  hooks.read(project);
  const previous = manifest(project);
  if (previous) previous.files.forEach(file => safePath(project, file));
  if (opts && ['install', 'update'].includes(opts.command)) {
    const effective = { ...opts };
    if (!opts.designSkillSet && previous) effective.designSkill = previous.design_skill;
    for (const [file] of payload(effective)) {
      const dest = safePath(project, file);
      if (fs.existsSync(dest) && (!previous || !previous.files.includes(file))) {
        throw new Error('Конфликт с пользовательским файлом: ' + file);
      }
    }
    for (const src of files(path.join(KIT, 'templates'))) {
      safePath(project, path.relative(path.join(KIT, 'templates'), src).split(path.sep).join('/'));
    }
    safePath(project, 'tasks/_index.md');
  }
}

function payload(opts) {
  const result = new Map();
  for (const src of files(path.join(KIT, 'skills'))) {
    const relative = path.relative(path.join(KIT, 'skills'), src).split(path.sep).join('/');
    if (opts.designSkill === false && relative.startsWith('emil-design-eng/')) continue;
    const override = path.join(KIT, 'codex', 'skills', relative);
    const chosen = fs.existsSync(override) ? override : src;
    const content = fs.readFileSync(chosen);
    result.set('.agents/skills/' + relative, /\.(md|py|json|yaml)$/i.test(src) ? Buffer.from(portable(content.toString('utf8'))) : content);
  }
  for (const name of ['board', 'spec', 'workflow-policy']) {
    result.set('.codex/workflow/' + name + '.js', fs.readFileSync(path.join(KIT, 'hooks', name + '.js')));
  }
  result.set('.codex/workflow/guard.js', fs.readFileSync(path.join(KIT, 'codex', 'guard.js')));
  for (const src of files(path.join(KIT, 'codex', 'agents'))) {
    result.set('.codex/agents/' + path.basename(src), fs.readFileSync(src));
  }
  return result;
}

function run(project, opts, version) {
  preflight(project, opts);
  const previous = manifest(project);
  opts = { ...opts };
  if (!opts.designSkillSet && previous) opts.designSkill = previous.design_skill;
  const expected = payload(opts);
  const agentsFile = safePath(project, 'AGENTS.md');
  const original = read(agentsFile);
  const bounds = section(original);
  const eol = /\r\n/.test(original || '') ? '\r\n' : '\n';
  const block = [START, fs.readFileSync(path.join(KIT, 'codex', 'AGENTS.section.md'), 'utf8').trim(), END].join('\n').replace(/\r\n/g, '\n').replace(/\n/g, eol);
  let next = bounds ? original.slice(0, bounds[0]) + block + original.slice(bounds[1]) :
    (original || '') + (original && !original.endsWith('\n') ? eol : '') + block + eol;
  const write = (relative, content) => {
    const file = safePath(project, relative);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(content))) return;
    process.stdout.write((opts.dryRun ? '[dry-run] ' : '') + 'Codex: запись ' + relative + '\n');
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  };
  if (opts.command === 'status') {
    const missing = [...expected].filter(([file, content]) => {
      const dest = safePath(project, file);
      return !fs.existsSync(dest) || !fs.readFileSync(dest).equals(content);
    }).map(([file]) => file);
    const healthy = previous && previous.version === version && bounds && original.slice(bounds[0], bounds[1]) === block && !missing.length && hooks.current(project);
    process.stdout.write('Codex: ' + (healthy ? 'актуален' : 'не установлен или требует обновления') + '\n');
    missing.forEach(file => process.stdout.write('  отсутствует/изменён: ' + file + '\n'));
    process.stdout.write('  хуки: ' + (hooks.current(project) ? 'настроены; доверие и включение проверьте через /hooks в Codex' : 'требуют обновления') + '\n');
    return healthy ? 0 : 1;
  }
  if (opts.command === 'uninstall') {
    if (previous) {
      const merged = hooks.merge(project, true);
      if (merged.text !== null) {
        if (!Object.keys(merged.data).length && previous.created_hooks_json) {
          if (!opts.dryRun) fs.unlinkSync(path.join(project, hooks.FILE));
        } else write(hooks.FILE, merged.content);
      }
    }
    for (const file of previous ? previous.files.concat(MANIFEST) : []) {
      const dest = safePath(project, file);
      if (fs.existsSync(dest)) {
        process.stdout.write((opts.dryRun ? '[dry-run] ' : '') + 'Codex: удаление ' + file + '\n');
        if (!opts.dryRun) fs.unlinkSync(dest);
      }
    }
    if (bounds) {
      next = original.slice(0, bounds[0]) + original.slice(bounds[1]).replace(/^\r?\n/, '');
      if (!next.trim() && previous && previous.created_agents_md) {
        if (!opts.dryRun) fs.unlinkSync(agentsFile);
      } else write('AGENTS.md', next);
    }
    return 0;
  }
  for (const [file] of expected) {
    const dest = safePath(project, file);
    if (fs.existsSync(dest) && (!previous || !previous.files.includes(file))) {
      throw new Error('Конфликт с пользовательским файлом: ' + file);
    }
  }
  const templates = files(path.join(KIT, 'templates')).map(src => [src, path.relative(path.join(KIT, 'templates'), src).split(path.sep).join('/')]);
  templates.forEach(([, file]) => safePath(project, file));
  safePath(project, 'tasks/_index.md');
  for (const [file, content] of expected) write(file, content);
  const mergedHooks = hooks.merge(project, false);
  write(hooks.FILE, mergedHooks.content);
  write('AGENTS.md', next);
  for (const [src, file] of templates) {
    if (!fs.existsSync(path.join(project, file))) write(file, portable(fs.readFileSync(src, 'utf8')));
  }
  const board = require(path.join(KIT, 'hooks', 'board.js'));
  write('tasks/_index.md', portable(board.renderBoard(project, { quiet: true })));
  write(MANIFEST, JSON.stringify({
    version, target: 'codex', design_skill: opts.designSkill !== false,
    created_agents_md: previous ? previous.created_agents_md : original === null,
    created_hooks_json: previous && typeof previous.created_hooks_json === 'boolean' ? previous.created_hooks_json : mergedHooks.text === null,
    files: [...new Set([...(previous ? previous.files : []), ...expected.keys()])],
  }, null, 2) + '\n');
  if (fs.existsSync(path.join(project, 'AGENTS.override.md'))) {
    process.stderr.write('Codex: AGENTS.override.md имеет приоритет над AGENTS.md; перенесите в него нужные правила кита.\n');
  }
  process.stdout.write('Codex: проектные хуки установлены. В доверенном проекте откройте /hooks и проверьте/разрешите новые определения; без доверия Codex их пропускает.\n');
  return 0;
}

module.exports = { preflight, run };
