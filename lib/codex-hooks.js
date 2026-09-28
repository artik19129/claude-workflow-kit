'use strict';

const fs = require('fs');
const path = require('path');
const FILE = '.codex/hooks.json';
const COMMAND = 'node -e "const fs=require(\'fs\'),p=require(\'path\');let d=process.cwd();while(!fs.existsSync(p.join(d,\'.codex/workflow/guard.js\'))){const n=p.dirname(d);if(n===d)process.exit(1);d=n;}require(p.join(d,\'.codex/workflow/guard.js\')).main();"';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

function read(project) {
  const file = path.join(project, FILE);
  if (!fs.existsSync(file)) return { data: {}, text: null };
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !['hooks', 'description'].includes(k))) {
    throw new Error(FILE + ': ожидается объект { hooks: { Event: [...] } }');
  }
  if (data.hooks !== undefined && (!data.hooks || Array.isArray(data.hooks) || typeof data.hooks !== 'object')) throw new Error(FILE + ': hooks должен быть объектом');
  for (const groups of Object.values(data.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) throw new Error(FILE + ': событие должно содержать массив групп hooks');
  }
  return { data, text };
}

function owned(handler) {
  return handler && handler.type === 'command' && handler.command === COMMAND;
}

function merge(project, remove) {
  const { data, text } = read(project);
  const next = JSON.parse(JSON.stringify(data));
  next.hooks = next.hooks || {};
  for (const event of EVENTS) {
    const groups = next.hooks[event] || [];
    next.hooks[event] = groups.flatMap(group => {
      const kept = group.hooks.filter(h => !owned(h));
      return kept.length || !group.hooks.some(owned) ? [{ ...group, hooks: kept }] : [];
    });
    if (!remove) next.hooks[event].push({ hooks: [{ type: 'command', command: COMMAND, timeout: 10, statusMessage: 'AI Workflow Kit: ' + event }] });
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  const eol = /\r\n/.test(text || '') ? '\r\n' : '\n';
  return { text, data: next, content: (JSON.stringify(next, null, 2) + '\n').replace(/\n/g, eol) };
}

function current(project) {
  const { data } = read(project);
  return EVENTS.every(event => {
    const groups = (data.hooks || {})[event] || [];
    const matches = groups.flatMap(group => group.hooks.filter(owned).map(handler => ({ group, handler })));
    return matches.length === 1 && !matches[0].group.matcher && matches[0].handler.async !== true && matches[0].handler.timeout === 10;
  });
}

module.exports = { FILE, COMMAND, read, merge, current };
