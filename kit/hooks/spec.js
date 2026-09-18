'use strict';

// Спека задачи: docs/specs/<ID>-<slug>.md — источник требований для исполнителей и ревьюера.
// Команды: new <ID> [slug] | check <ID|путь> | approve <ID|путь> [--by <кто>]; общий флаг --root <корень проекта>.
// Библиотека для orchestrator-guard.js: readSpec, checkSpec, resolveSpecRef.

const fs = require('fs');
const path = require('path');
const board = require('./board.js');

const SPECS_DIR = 'docs/specs';
const TEMPLATE_NAME = '_template.md';
const TASK_ID_RE = /^VC-\d+$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_SECTIONS = ['Цель', 'Не делаем', 'Поведение', 'Контракты', 'Ограничения', 'Зоны работ', 'Тесты', 'Критерии приёмки'];
const CRITERIA_SECTION = 'Критерии приёмки';
const QUESTIONS_SECTION = 'Открытые вопросы';
const KNOWN_STATUSES = new Set(['draft', 'approved']);
const PLACEHOLDER_RE = /\b(?:TBD|TODO|FIXME)\b|\?\?\?|уточнить/i;
const RESOLVED_RE = /решено/i;
const CHECKBOX_RE = /^-\s+\[[ xX]\]\s+\S/;
const BULLET_RE = /^[-*]\s+\S/;
const TABLE_SEP_RE = /^\|?\s*:?-{3,}/;
const HOOKS_DIR_RE = /[\\/]\.claude[\\/]hooks$/;
const SNIPPET = 60;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (HOOKS_DIR_RE.test(__dirname)) return path.resolve(__dirname, '..', '..');
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return process.cwd();
}

function normalizeRel(rel) {
  return String(rel).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function toRel(root, p) {
  return path.relative(root, path.resolve(root, p)).split(path.sep).join('/');
}

function taskPath(root, id) {
  return path.join(board.tasksDir(root), id.toUpperCase() + '.md');
}

function readTask(root, id) {
  const file = taskPath(root, id);
  const text = readText(file);
  if (text === null) return { error: 'нет файла tasks/' + id.toUpperCase() + '.md' };
  const parsed = board.parseFrontmatter(text);
  if (parsed.error) return { error: 'tasks/' + id.toUpperCase() + '.md: ' + parsed.error };
  return { data: parsed.data, text: text, file: file };
}

function resolveSpecRef(root, ref) {
  if (TASK_ID_RE.test(ref)) {
    const id = ref.toUpperCase();
    const task = readTask(root, id);
    if (task.error) return { error: task.error, id: id };
    const field = (task.data.spec || '').trim();
    if (!field) return { error: 'в frontmatter tasks/' + id + '.md нет поля spec', id: id };
    return { rel: normalizeRel(field), id: id };
  }
  return { rel: toRel(root, ref), id: null };
}

function readSpec(root, rel) {
  const normalized = normalizeRel(rel);
  const abs = path.resolve(root, normalized);
  const text = readText(abs);
  if (text === null) {
    return { exists: false, rel: normalized, abs: abs, status: '', data: null, text: null, frontmatterError: null };
  }
  const parsed = board.parseFrontmatter(text);
  const data = parsed.data || {};
  return {
    exists: true,
    rel: normalized,
    abs: abs,
    status: (data.status || '').trim().toLowerCase(),
    data: data,
    text: text,
    frontmatterError: parsed.error || null,
  };
}

function frontmatterEnd(lines) {
  if (!lines.length || lines[0].trim() !== '---') return 0;
  let end = 1;
  while (end < lines.length && lines[end].trim() !== '---') end++;
  return end >= lines.length ? 0 : end + 1;
}

function splitBody(text) {
  const lines = stripBom(text).split(/\r?\n/);
  let i = frontmatterEnd(lines);
  const sections = [];
  let current = { name: '', lines: [], line: i + 1 };
  for (; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      sections.push(current);
      current = { name: m[1], lines: [], line: i + 2 };
      continue;
    }
    current.lines.push(lines[i]);
  }
  sections.push(current);
  return sections;
}

function templateLines(root) {
  const text = readText(path.join(root, SPECS_DIR, TEMPLATE_NAME));
  if (text === null) return null;
  const set = new Set();
  for (const section of splitBody(text)) {
    for (const line of section.lines) {
      const t = line.trim();
      if (!t || t.charAt(0) === '#') continue;
      set.add(t);
    }
  }
  return set;
}

function checkSpec(root, rel) {
  const info = readSpec(root, rel);
  const findings = [];
  if (!info.exists) return { findings: ['файл ' + info.rel + ' не найден'], info: info };
  if (info.frontmatterError) findings.push('frontmatter: ' + info.frontmatterError);

  const data = info.data;
  const fileId = (/^(VC-\d+)/i.exec(path.basename(info.rel)) || [])[1];
  if (!data.id) findings.push('frontmatter: нет поля id');
  else if (fileId && data.id.trim().toUpperCase() !== fileId.toUpperCase()) {
    findings.push('frontmatter: id (' + data.id.trim() + ') не совпадает с именем файла (' + fileId + ')');
  }
  if (!data.title) findings.push('frontmatter: нет поля title');
  if (!KNOWN_STATUSES.has(info.status)) {
    findings.push('frontmatter: status должен быть draft или approved, сейчас «' + (data.status || '') + '»');
  }

  const tpl = templateLines(root) || new Set();
  const sections = splitBody(info.text);
  const byName = new Map();
  for (const s of sections) if (s.name) byName.set(s.name, s);
  const contentOf = (s) => s.lines.map((l) => l.trim()).filter((t) => t && !tpl.has(t) && !TABLE_SEP_RE.test(t));

  for (const name of REQUIRED_SECTIONS) {
    const s = byName.get(name);
    if (!s) {
      findings.push('нет раздела «## ' + name + '»');
      continue;
    }
    if (contentOf(s).length === 0) findings.push('раздел «' + name + '» пуст');
  }

  const lines = stripBom(info.text).split(/\r?\n/);
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.charAt(0) === '#') continue;
    if (PLACEHOLDER_RE.test(t)) findings.push('строка ' + (i + 1) + ': заглушка «' + t.slice(0, SNIPPET) + '»');
    else if (tpl.has(t) && t.charAt(0) !== '|') {
      findings.push('строка ' + (i + 1) + ': текст шаблона не заменён «' + t.slice(0, SNIPPET) + '»');
    }
  }

  const criteria = byName.get(CRITERIA_SECTION);
  if (criteria && !contentOf(criteria).some((t) => CHECKBOX_RE.test(t))) {
    findings.push('в «' + CRITERIA_SECTION + '» нет ни одного пункта «- [ ]»');
  }

  const questions = byName.get(QUESTIONS_SECTION);
  if (questions) {
    for (const t of contentOf(questions)) {
      if (BULLET_RE.test(t) && !RESOLVED_RE.test(t)) {
        findings.push('открытый вопрос без «решено»: «' + t.slice(0, SNIPPET) + '»');
      }
    }
  }

  return { findings: findings, info: info };
}

function setFrontmatterField(text, key, value) {
  const eol = detectEol(text);
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const lines = stripBom(text).split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end === 0) return text;
  const re = new RegExp('^' + key + '\\s*:');
  let done = false;
  for (let i = 1; i < end - 1; i++) {
    if (re.test(lines[i])) {
      lines[i] = key + ': ' + value;
      done = true;
      break;
    }
  }
  if (!done) lines.splice(end - 1, 0, key + ': ' + value);
  return bom + lines.join(eol);
}

function yamlValue(value) {
  const v = String(value);
  if (!/^["']|\s#/.test(v)) return v;
  return v.indexOf('"') >= 0 ? "'" + v + "'" : '"' + v + '"';
}

function createSpec(root, id, slug) {
  const ID = String(id || '').toUpperCase();
  if (!TASK_ID_RE.test(ID)) return { error: 'ID задачи должен быть вида VC-012, получено «' + id + '»' };
  if (slug && !SLUG_RE.test(slug)) return { error: 'slug — латиница, цифры и дефисы: «' + slug + '»' };
  const task = readTask(root, ID);
  if (task.error) return { error: task.error };
  const tplText = readText(path.join(root, SPECS_DIR, TEMPLATE_NAME));
  if (tplText === null) {
    return { error: 'нет ' + SPECS_DIR + '/' + TEMPLATE_NAME + ' — выполните node install.js update <проект>' };
  }
  const rel = SPECS_DIR + '/' + ID + (slug ? '-' + slug : '') + '.md';
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) return { error: rel + ' уже есть' };

  const title = (task.data.title || ID).trim();
  const eol = detectEol(tplText);
  let text = stripBom(tplText).replace(/\r\n/g, '\n');
  text = text.replace(/^title:.*$/m, () => 'title: ' + yamlValue(title));
  text = text.replace(/^updated:.*$/m, () => 'updated: ' + today());
  text = text.replace(/VC-000/g, () => ID).replace(/Заголовок/g, () => title);
  text = text.replace(/\n/g, eol);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');

  const next = setFrontmatterField(task.text, 'spec', rel);
  const taskUpdated = next !== task.text;
  if (taskUpdated) fs.writeFileSync(task.file, next, 'utf8');
  return { rel: rel, id: ID, taskUpdated: taskUpdated };
}

function approveSpec(root, rel, by) {
  const result = checkSpec(root, rel);
  if (result.findings.length > 0) return { ok: false, findings: result.findings, info: result.info };
  const info = result.info;
  const date = today();
  let text = setFrontmatterField(info.text, 'status', 'approved');
  text = setFrontmatterField(text, 'approved', date + ' ' + (by || 'CEO'));
  text = setFrontmatterField(text, 'updated', date);
  fs.writeFileSync(info.abs, text, 'utf8');
  return { ok: true, findings: [], info: readSpec(root, rel) };
}

function usage() {
  return (
    'Использование: node spec.js <new <ID> [slug] | check <ID|путь> | approve <ID|путь> [--by <кто>]>' +
    ' [--root <корень проекта>]'
  );
}

function fail(message) {
  process.stderr.write('spec.js: ' + message + '\n');
  process.exit(1);
}

function printFindings(findings) {
  for (const f of findings) process.stdout.write('  - ' + f + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { root: null, by: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') opts.root = argv[++i];
    else if (arg.indexOf('--root=') === 0) opts.root = arg.slice('--root='.length);
    else if (arg === '--by') opts.by = argv[++i];
    else if (arg.indexOf('--by=') === 0) opts.by = arg.slice('--by='.length);
    else if (arg.indexOf('--') === 0) fail('неизвестный флаг: ' + arg);
    else positional.push(arg);
  }
  const root = resolveRoot(opts.root);
  const command = positional[0];
  const ref = positional[1];

  if (command === 'new') {
    if (!ref) fail(usage());
    const result = createSpec(root, ref, positional[2]);
    if (result.error) fail(result.error);
    process.stdout.write('создан ' + result.rel + '\n');
    process.stdout.write(
      (result.taskUpdated ? 'обновлён' : 'без изменений') + ' tasks/' + result.id + '.md (spec: ' + result.rel + ')\n'
    );
    process.exit(0);
  }

  if (command === 'check' || command === 'approve') {
    if (!ref) fail(usage());
    const target = resolveSpecRef(root, ref);
    if (target.error) fail(target.error);
    if (command === 'check') {
      const result = checkSpec(root, target.rel);
      if (result.findings.length === 0) {
        process.stdout.write('ok ' + target.rel + ' (status: ' + result.info.status + ')\n');
        process.exit(0);
      }
      process.stdout.write('спека ' + target.rel + ': замечаний ' + result.findings.length + '\n');
      printFindings(result.findings);
      process.exit(1);
    }
    const result = approveSpec(root, target.rel, opts.by);
    if (!result.ok) {
      process.stdout.write('не утверждена ' + target.rel + ': замечаний ' + result.findings.length + '\n');
      printFindings(result.findings);
      process.exit(1);
    }
    process.stdout.write('утверждена ' + target.rel + ' (approved: ' + result.info.data.approved + ')\n');
    if (target.id) process.stdout.write('теперь в tasks/' + target.id + '.md: status: approved\n');
    process.exit(0);
  }

  process.stderr.write(usage() + '\n');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  SPECS_DIR,
  TEMPLATE_NAME,
  REQUIRED_SECTIONS,
  resolveRoot,
  resolveSpecRef,
  readSpec,
  splitBody,
  checkSpec,
  setFrontmatterField,
  createSpec,
  approveSpec,
};
