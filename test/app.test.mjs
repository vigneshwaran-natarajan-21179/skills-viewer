import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStore } from '../core.mjs';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-viewer-test-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'Projects', 'logs_fw');
  const source = path.join(cwd, '.github', 'skills', 'log-triage');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: log-triage\ndescription: >\n  Diagnose firmware logs\n  without losing context.\n---\n# Log triage\n\nRead the attached logs.\n');
  await fs.writeFile(path.join(source, 'scripts', 'check.py'), 'print("check")\n');
  const options = { home, cwd, dataDir: path.join(home, '.config', 'skills-viewer') };
  return { home, cwd, source, options, store: createStore(options) };
}

test('discovers workspace skills, parses folded metadata and does not create config on read', async (t) => {
  const { store, options } = await fixture(t);
  const state = await store.snapshot();
  assert.equal(state.skills.length, 1);
  assert.equal(state.skills[0].name, 'log-triage');
  assert.equal(state.skills[0].description, 'Diagnose firmware logs without losing context.');
  assert.equal(state.skills[0].locations[0].scope, 'workspace');
  assert.equal(state.agents.find((agent) => agent.id === 'sahaa').path, null);
  await assert.rejects(fs.stat(options.dataDir), { code: 'ENOENT' });
  const detail = await store.detail(state.skills[0].id);
  assert(detail.files.some((file) => file.name === 'scripts' && file.directory));
});

test('agent detection is explicit path evidence, not unknown-agent or capability discovery', async (t) => {
  const { store, home } = await fixture(t);
  await fs.mkdir(path.join(home, '.sahaa'));
  await fs.mkdir(path.join(home, '.unknown-agent', 'skills'), { recursive: true });
  let state = await store.snapshot();
  const sahaa = state.agents.find((agent) => agent.id === 'sahaa');
  assert.equal(sahaa.detected, true);
  assert.equal(sahaa.evidencePath, path.join(home, '.sahaa'));
  assert.equal(sahaa.skillsFolderExists, false);
  assert.equal(sahaa.path, null);
  assert(!state.agents.some((agent) => agent.name === 'Unknown agent'));
  await store.addAgent({ name: 'Unknown agent', path: '~/.unknown-agent/skills' });
  state = await store.snapshot();
  assert.equal(state.agents.find((agent) => agent.name === 'Unknown agent').skillsFolderExists, true);
});

test('links workspace skill to Sahaa and shared library; original edits propagate, configuration persists', async (t) => {
  const { store, source, home, options } = await fixture(t);
  await store.addAgent({ id: 'sahaa', name: 'Sahaa', path: '~/.sahaa/skills' });
  const skill = (await store.snapshot()).skills[0];
  const result = await store.sync({ skillId: skill.id, targets: ['sahaa', 'shared'], mode: 'link' });
  assert.deepEqual(result.results.map((entry) => entry.status), ['created', 'created']);
  const target = path.join(home, '.sahaa', 'skills', 'log-triage');
  assert.equal(await fs.realpath(target), source);
  const after = await store.snapshot();
  assert.equal(after.skills.length, 1);
  assert.equal(after.skills[0].locations.length, 3);
  assert.equal(after.agents.find((agent) => agent.id === 'sahaa').count, 1);
  const detail = await store.detail(skill.id);
  await store.edit({ skillId: skill.id, version: detail.version, document: '# Updated skill\n\nNew instructions.\n' });
  assert.match(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), /New instructions/);
  const reloaded = await createStore(options).snapshot();
  assert.equal(reloaded.activity.length, 2);
  assert.equal(reloaded.agents.find((agent) => agent.id === 'sahaa').path, path.join(home, '.sahaa', 'skills'));
  assert.equal((await store.sync({ skillId: skill.id, targets: ['sahaa'], mode: 'link' })).results[0].status, 'unchanged');
});

test('copies supporting files, leaves copies independent, and refuses to overwrite', async (t) => {
  const { store, home } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  const input = { skillId: skill.id, targets: ['copilot'], mode: 'copy' };
  assert.equal((await store.sync(input)).results[0].status, 'created');
  const destination = path.join(home, '.copilot', 'skills', 'log-triage');
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(destination, 'scripts', 'check.py'), 'utf8'), 'print("check")\n');
  const detail = await store.detail(skill.id);
  await store.edit({ skillId: skill.id, version: detail.version, document: '# Changed\n' });
  assert.match(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), /Diagnose firmware/);
  assert.equal((await store.sync(input)).results[0].status, 'conflict');
  assert.match(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), /Diagnose firmware/);
});

test('preserves local edits on stale save and refuses symlinked SKILL.md', async (t) => {
  const { store, source, home } = await fixture(t);
  const detail = await store.detail((await store.snapshot()).skills[0].id);
  await fs.writeFile(path.join(source, 'SKILL.md'), '# External edit\n');
  await assert.rejects(store.edit({ skillId: detail.id, version: detail.version, document: '# Stale edit\n' }), /changed since/);
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), '# External edit\n');
  await fs.writeFile(path.join(home, 'private.txt'), 'private');
  await fs.unlink(path.join(source, 'SKILL.md'));
  await fs.symlink(path.join(home, 'private.txt'), path.join(source, 'SKILL.md'));
  const state = await store.snapshot();
  assert.equal(state.skills.length, 0);
  assert.match(state.warnings[0], /regular file/);
});

test('rejects invalid destinations, unconfigured agents, self-copy and nested symlinks', async (t) => {
  const { store, source, home } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  await assert.rejects(store.addAgent({ name: 'Bad', path: '../outside' }), /absolute/);
  await assert.rejects(store.addAgent({ name: 'Bad', path: home }), /dedicated/);
  await assert.rejects(store.sync({ skillId: skill.id, targets: ['sahaa'], mode: 'link' }), /configured/);
  await assert.rejects(store.sync({ skillId: skill.id, targets: [], mode: 'link' }), /between 1 and 50/);
  await store.addAgent({ name: 'Nested', path: path.join(source, 'nested') });
  const nested = (await store.snapshot()).agents.find((agent) => agent.name === 'Nested');
  await assert.rejects(store.sync({ skillId: skill.id, targets: [nested.id], mode: 'copy' }), /itself/);
  await assert.rejects(fs.stat(path.join(source, 'nested')), { code: 'ENOENT' });
  const alias = path.join(home, 'skill-alias');
  await fs.symlink(source, alias);
  await store.addAgent({ name: 'Alias', path: path.join(alias, 'nested-alias') });
  const aliased = (await store.snapshot()).agents.find((agent) => agent.name === 'Alias');
  await assert.rejects(store.sync({ skillId: skill.id, targets: [aliased.id], mode: 'link' }), /itself/);
  await assert.rejects(fs.stat(path.join(source, 'nested-alias')), { code: 'ENOENT' });
  await fs.symlink(home, path.join(source, 'outside'));
  await assert.rejects(store.sync({ skillId: skill.id, targets: ['copilot'], mode: 'copy' }), /regular files/);
  await assert.rejects(fs.stat(path.join(home, '.copilot')), { code: 'ENOENT' });
});

test('disconnect removes only an unchanged managed link, never its source or replacement', async (t) => {
  const { store, source } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  await store.sync({ skillId: skill.id, targets: ['shared', 'copilot'], mode: 'link' });
  const [copilot, shared] = (await store.snapshot()).activity;
  await fs.unlink(copilot.destination);
  await fs.mkdir(copilot.destination);
  await assert.rejects(store.unlinkManaged({ id: copilot.id }), /changed/);
  await store.unlinkManaged({ id: shared.id });
  await assert.rejects(fs.lstat(shared.destination), { code: 'ENOENT' });
  assert((await fs.stat(source)).isDirectory());
  assert((await fs.stat(copilot.destination)).isDirectory());
  assert((await store.snapshot()).activity.find((event) => event.id === shared.id).undone);
});

test('registers/discovers workspaces, supports custom skills roots and removes registration only', async (t) => {
  const { store, home } = await fixture(t);
  const other = path.join(home, 'Projects', 'other');
  const direct = path.join(other, '.agents', 'skills');
  await fs.mkdir(path.join(direct, 'build'), { recursive: true });
  await fs.writeFile(path.join(direct, 'build', 'SKILL.md'), '# Build\n');
  assert((await store.discover()).candidates.some((candidate) => candidate.path === other));
  const workspace = await store.addWorkspace({ path: direct });
  assert.equal((await store.snapshot()).skills.length, 2);
  await assert.rejects(store.addWorkspace({ path: direct }), /already registered/);
  await store.removeRegistration('workspaces', workspace.id);
  assert.equal((await store.snapshot()).skills.length, 1);
  assert((await fs.stat(path.join(direct, 'build', 'SKILL.md'))).isFile());
});

test('removal archives the full directory and persists recovery; restore never overwrites', async (t) => {
  const { store, source, options } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  const input = { skillId: skill.id, location: source, version: skill.version, confirmation: skill.name };
  await assert.rejects(store.removeSkill({ ...input, confirmation: 'wrong' }), /exactly/);
  await assert.rejects(store.removeSkill({ ...input, location: path.dirname(source) }), /registered/);
  await assert.rejects(store.removeSkill({ ...input, version: 'stale' }), /changed/);
  await store.removeSkill(input);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  const after = await createStore(options).snapshot();
  assert.equal(after.skills.length, 0);
  assert.equal(after.removed.length, 1);
  assert.equal(after.removed[0].mode, 'remove-skill');
  assert.equal(await fs.readFile(path.join(after.removed[0].destination, 'scripts', 'check.py'), 'utf8'), 'print("check")\n');
  await fs.writeFile(source, 'Do not replace me');
  await assert.rejects(store.restoreSkill({ id: after.removed[0].id }), /occupied/);
  assert.equal(await fs.readFile(source, 'utf8'), 'Do not replace me');
  await fs.unlink(source);
  await store.restoreSkill({ id: after.removed[0].id });
  assert.equal((await store.snapshot()).removed.length, 0);
  assert.equal((await store.snapshot()).skills.length, 1);
  assert.equal(await fs.readFile(path.join(source, 'scripts', 'check.py'), 'utf8'), 'print("check")\n');
});

test('source removal is blocked by known links; relative links can be removed and restored safely', async (t) => {
  const { store, source, home } = await fixture(t);
  const link = path.join(home, '.copilot', 'skills', 'log-triage');
  await fs.mkdir(path.dirname(link), { recursive: true });
  const target = path.relative(path.dirname(link), source);
  await fs.symlink(target, link);
  let skill = (await store.snapshot()).skills[0];
  await assert.rejects(store.removeSkill({ skillId: skill.id, version: skill.version, location: source, confirmation: skill.name }), /Other registered/);
  await store.removeSkill({ skillId: skill.id, version: skill.version, location: link, confirmation: skill.name });
  const removedLink = (await store.snapshot()).removed[0];
  assert((await fs.stat(source)).isDirectory());
  await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
  skill = (await store.snapshot()).skills[0];
  await store.removeSkill({ skillId: skill.id, version: skill.version, location: source, confirmation: skill.name });
  const removedSource = (await store.snapshot()).removed[0];
  await assert.rejects(store.restoreSkill({ id: removedLink.id }), /target is missing/);
  await store.restoreSkill({ id: removedSource.id });
  await store.restoreSkill({ id: removedLink.id });
  assert.equal(await fs.readlink(link), target);
  assert.equal(await fs.realpath(link), source);
});

test('removal and restoration roll back filesystem changes when settings cannot be saved', async (t) => {
  const { store, source, options } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  await fs.mkdir(path.join(options.dataDir, 'settings.json'), { recursive: true });
  const input = { skillId: skill.id, version: skill.version, location: source, confirmation: skill.name };
  await assert.rejects(store.removeSkill(input));
  assert((await fs.stat(source)).isDirectory());
  assert.equal((await store.snapshot()).removed.length, 0);
  await fs.rmdir(path.join(options.dataDir, 'settings.json'));
  await store.removeSkill(input);
  const event = (await store.snapshot()).removed[0];
  await fs.unlink(path.join(options.dataDir, 'settings.json'));
  await fs.mkdir(path.join(options.dataDir, 'settings.json'));
  await assert.rejects(store.restoreSkill({ id: event.id }));
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  assert((await fs.stat(event.destination)).isDirectory());
  assert.equal((await store.snapshot()).removed.length, 1);
});

test('API protects mutations, host and origin; actual HTTP share persists and static routes are bounded', async (t) => {
  const { options, home } = await fixture(t);
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const input = { skillId: state.skills[0].id, targets: ['shared'], mode: 'link' };
  const post = (body, extra = {}, route = '/api/sync') => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skills-Token': state.token, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await post(input, { 'X-Skills-Token': '' })).status, 403);
  assert.equal((await post(input, { Origin: 'https://not-local.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { Host: 'not-local.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(`${base}/core.mjs`)).status, 404);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const response = await post(input);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].status, 'created');
  assert((await fs.lstat(path.join(home, '.agents', 'skills', 'log-triage'))).isSymbolicLink());
  assert((await fs.stat(path.join(options.dataDir, 'settings.json'))).isFile());
  const linked = path.join(home, '.agents', 'skills', 'log-triage');
  const removal = { skillId: state.skills[0].id, version: state.skills[0].version, location: linked, confirmation: state.skills[0].name };
  assert.equal((await post(removal, { 'X-Skills-Token': '' }, '/api/remove-skill')).status, 403);
  assert.equal((await post(removal, {}, '/api/remove-skill')).status, 200);
  const after = await (await fetch(`${base}/api/state`)).json();
  assert.equal(after.removed.length, 1);
  assert.equal((await post({ id: after.removed[0].id }, {}, '/api/restore-skill')).status, 200);
  assert((await fs.lstat(linked)).isSymbolicLink());
});
