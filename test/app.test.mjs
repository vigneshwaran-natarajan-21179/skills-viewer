import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
  assert.deepEqual(state.agents.map((agent) => agent.id), ['shared']);
  await assert.rejects(fs.stat(options.dataDir), { code: 'ENOENT' });
  const detail = await store.detail(state.skills[0].id);
  assert(detail.files.some((file) => file.name === 'scripts' && file.directory));
});

test('only registered agents are listed; directory presence never registers an agent', async (t) => {
  const { store, home } = await fixture(t);
  await fs.mkdir(path.join(home, '.sahaa'));
  await fs.mkdir(path.join(home, '.unknown-agent', 'skills'), { recursive: true });
  let state = await store.snapshot();
  assert.equal(state.agents.some((agent) => agent.name === 'Sahaa'), false);
  assert(!state.agents.some((agent) => agent.name === 'Unknown agent'));
  await store.addAgent({ name: 'Unknown agent', path: '~/.unknown-agent/skills' });
  state = await store.snapshot();
  assert.equal(state.agents.find((agent) => agent.name === 'Unknown agent').skillsFolderExists, true);
});

test('all registrations can be removed and stay removed after restart; existing skills are untouched', async (t) => {
  const { store, options, source } = await fixture(t);
  const shared = (await store.snapshot()).agents[0];
  await store.removeRegistration('agents', shared.id);
  assert.equal((await createStore(options).snapshot()).agents.length, 0);
  assert((await fs.stat(source)).isDirectory());
  const agent = await store.addAgent({ name: 'My agent', path: '~/.my-agent/skills' });
  await store.removeRegistration('agents', agent.id);
  assert.equal((await createStore(options).snapshot()).agents.length, 0);
});

test('upgrade drops only unconfigured personalized legacy placeholders and preserves configured agents', async (t) => {
  const { store, options, home } = await fixture(t);
  const state = await store.snapshot();
  await fs.mkdir(options.dataDir, { recursive: true });
  await fs.writeFile(path.join(options.dataDir, 'settings.json'), JSON.stringify({
    version: 1, workspaces: state.workspaces, activity: [], agents: [
      ...state.agents,
      { id: 'sahaa', name: 'Sahaa', path: null, root: path.join(home, '.sahaa'), builtin: true },
      { id: 'zllm', name: 'Zllm', path: path.join(home, '.zllm', 'skills'), root: path.join(home, '.zllm'), builtin: true },
    ],
  }));
  const upgraded = createStore(options);
  const after = await upgraded.snapshot();
  assert.equal(after.agents.some((agent) => agent.id === 'sahaa'), false);
  assert.equal(after.agents.some((agent) => agent.id === 'zllm'), true);
  await upgraded.removeRegistration('agents', 'zllm');
  assert.equal((await createStore(options).snapshot()).agents.length, 1);
});

test('links workspace skill to a registered agent and shared library; edits propagate and configuration persists', async (t) => {
  const { store, source, home, options } = await fixture(t);
  const agent = await store.addAgent({ name: 'My agent', path: '~/.my-agent/skills' });
  const skill = (await store.snapshot()).skills[0];
  const result = await store.sync({ skillId: skill.id, targets: [agent.id, 'shared'], mode: 'link' });
  assert.deepEqual(result.results.map((entry) => entry.status), ['created', 'created']);
  const target = path.join(home, '.my-agent', 'skills', 'log-triage');
  assert.equal(await fs.realpath(target), source);
  const after = await store.snapshot();
  assert.equal(after.skills.length, 1);
  assert.equal(after.skills[0].locations.length, 3);
  assert.equal(after.agents.find((item) => item.id === agent.id).count, 1);
  const detail = await store.detail(skill.id);
  await store.edit({ skillId: skill.id, version: detail.version, document: '# Updated skill\n\nNew instructions.\n' });
  assert.match(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), /New instructions/);
  const reloaded = await createStore(options).snapshot();
  assert.equal(reloaded.activity.length, 2);
  assert.equal(reloaded.agents.find((item) => item.id === agent.id).path, path.join(home, '.my-agent', 'skills'));
  assert.equal((await store.sync({ skillId: skill.id, targets: [agent.id], mode: 'link' })).results[0].status, 'unchanged');
});

test('copies supporting files, leaves copies independent, and refuses to overwrite', async (t) => {
  const { store, home, source } = await fixture(t);
  await fs.chmod(source, 0o700);
  const copilot = await store.addAgent({ name: 'GitHub Copilot', path: '~/.copilot/skills' });
  const skill = (await store.snapshot()).skills[0];
  const input = { skillId: skill.id, targets: [copilot.id], mode: 'copy' };
  const copied = (await store.sync(input)).results[0];
  assert.equal(copied.status, 'created', copied.message);
  const destination = path.join(home, '.copilot', 'skills', 'log-triage');
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
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
  assert.match(state.warnings.find((warning) => warning.includes('SKILL.md')), /regular file/);
});

test('rejects invalid destinations, unconfigured agents, self-copy and nested symlinks', async (t) => {
  const { store, source, home } = await fixture(t);
  const copilot = await store.addAgent({ name: 'GitHub Copilot', path: '~/.copilot/skills' });
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
  await assert.rejects(store.sync({ skillId: skill.id, targets: [copilot.id], mode: 'copy' }), /regular files/);
  await assert.rejects(fs.stat(path.join(home, '.copilot')), { code: 'ENOENT' });
});

test('disconnect removes only an unchanged managed link, never its source or replacement', async (t) => {
  const { store, source } = await fixture(t);
  const agent = await store.addAgent({ name: 'GitHub Copilot', path: '~/.copilot/skills' });
  const skill = (await store.snapshot()).skills[0];
  await store.sync({ skillId: skill.id, targets: ['shared', agent.id], mode: 'link' });
  const [copilot, shared] = (await store.snapshot()).activity;
  await fs.unlink(copilot.destination);
  await fs.mkdir(copilot.destination);
  await assert.rejects(store.unlinkManaged({ id: copilot.id }), /changed/);
  await store.unlinkManaged({ id: shared.id });
  await assert.rejects(fs.lstat(shared.destination), { code: 'ENOENT' });
  assert((await fs.stat(source)).isDirectory());
  assert((await fs.stat(copilot.destination)).isDirectory());
  assert((await store.snapshot()).activity.find((event) => event.id === shared.id).undone);
  await assert.rejects(store.dismissActivity({ id: copilot.id }), /Disconnect/);
  await store.dismissActivity({ id: shared.id });
  assert(!(await store.snapshot()).activity.some((event) => event.id === shared.id));
  assert((await fs.stat(source)).isDirectory());
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
  await store.addAgent({ name: 'GitHub Copilot', path: '~/.copilot/skills' });
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

test('restore rejects an ancestor redirected to an agent directory and a replaced parent inode', async (t) => {
  const { store, source, home } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  await store.removeSkill({ skillId: skill.id, version: skill.version, location: source, confirmation: skill.name });
  const event = (await store.snapshot()).removed[0];
  await assert.rejects(store.dismissActivity({ id: event.id }), /Restore/);
  const parent = path.dirname(source);
  const saved = `${parent}-original`;
  const redirected = path.join(home, '.copilot', 'skills');
  await fs.mkdir(redirected, { recursive: true });
  await fs.rename(parent, saved);
  await fs.symlink(redirected, parent);
  await assert.rejects(store.restoreSkill({ id: event.id }), /parent directory changed/);
  await assert.rejects(fs.stat(path.join(redirected, 'log-triage')), { code: 'ENOENT' });
  assert((await fs.stat(event.destination)).isDirectory());
  await fs.unlink(parent);
  await fs.mkdir(parent);
  await assert.rejects(store.restoreSkill({ id: event.id }), /parent directory changed/);
  await fs.rmdir(parent);
  await fs.rename(saved, parent);
  await store.restoreSkill({ id: event.id });
  assert((await fs.stat(source)).isDirectory());
});

test('recovery helper rejects a different directory even if its parent path was substituted before spawn', async (t) => {
  const { store, source, home } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  await store.removeSkill({ skillId: skill.id, version: skill.version, location: source, confirmation: skill.name });
  const event = (await store.snapshot()).removed[0];
  const other = path.join(home, 'redirected');
  await fs.mkdir(other);
  await assert.rejects(promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../recovery.mjs', import.meta.url)), 'restore', JSON.stringify(event),
  ], { cwd: other }), /parent directory changed/);
  assert.deepEqual(await fs.readdir(other), []);
  assert((await fs.stat(event.destination)).isDirectory());
});

test('old recovery entries without recorded directory identity require manual restoration', async (t) => {
  const { store, source, options } = await fixture(t);
  const skill = (await store.snapshot()).skills[0];
  await store.removeSkill({ skillId: skill.id, version: skill.version, location: source, confirmation: skill.name });
  const settings = JSON.parse(await fs.readFile(path.join(options.dataDir, 'settings.json'), 'utf8'));
  delete settings.removed[0].parent;
  await fs.writeFile(path.join(options.dataDir, 'settings.json'), JSON.stringify(settings));
  await assert.rejects(createStore(options).restoreSkill({ id: settings.removed[0].id }), /older recovery record/);
  assert((await fs.stat(settings.removed[0].destination)).isDirectory());
});

test('all APIs require owner-provided authentication; the secret is not disclosed over HTTP', async (t) => {
  const { options, home } = await fixture(t);
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = new URLSearchParams(new URL(server.launchURL()).hash.slice(1)).get('access');
  const get = (route) => fetch(`${base}${route}`, { headers: { 'X-Skills-Token': token } });
  for (const route of ['/api/state', '/api/skill?id=guess', '/api/discover']) assert.equal((await fetch(`${base}${route}`)).status, 401);
  const state = await (await get('/api/state')).json();
  assert.equal(state.token, undefined);
  assert.equal(JSON.stringify(state).includes(token), false);
  const input = { skillId: state.skills[0].id, targets: ['shared'], mode: 'link' };
  const post = (body, extra = {}, route = '/api/sync') => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skills-Token': token, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await post(input, { 'X-Skills-Token': '' })).status, 401);
  assert.equal((await post(input, { 'X-Skills-Token': '0'.repeat(64) })).status, 401);
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
  assert.equal((await post(removal, { 'X-Skills-Token': '' }, '/api/remove-skill')).status, 401);
  assert.equal((await post(removal, {}, '/api/remove-skill')).status, 200);
  const after = await (await get('/api/state')).json();
  assert.equal(after.removed.length, 1);
  assert.equal((await post({ id: after.removed[0].id }, {}, '/api/restore-skill')).status, 200);
  assert((await fs.lstat(linked)).isSymbolicLink());
});

test('desktop launcher requires the owner secret, stops cleanly, and recovers after a crash', { timeout: 15_000 }, async (t) => {
  const { home, options } = await fixture(t);
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../launcher.mjs', import.meta.url)), '--no-open'], {
      env: { ...process.env, HOME: home, PORT: '0', SKILLS_VIEWER_DATA_DIR: options.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const url = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#access=[a-f0-9]{64}/);
        if (match) resolve(new URL(match[0]));
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`Launcher exited before ready: ${code}`)));
    });
    return { child, exited, url };
  };
  const { exited, url } = await start();
  const token = new URLSearchParams(url.hash.slice(1)).get('access');
  assert.equal((await fetch(`${url.origin}/api/state`)).status, 401);
  const headers = { 'X-Skills-Token': token, 'Content-Type': 'application/json' };
  const state = await (await fetch(`${url.origin}/api/state`, { headers })).json();
  assert.equal(state.appVersion, '1.0.0');
  assert.equal(state.workspaces.length, 0);
  assert.deepEqual(state.agents.map((agent) => agent.id), ['shared']);
  assert.equal((await fetch(`${url.origin}/api/quit`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await exited)[0], 0);
  const crashed = await start();
  crashed.child.kill('SIGKILL');
  await crashed.exited;
  const recovered = await start();
  assert.notEqual(recovered.url.hash, crashed.url.hash);
  assert.equal((await fetch(recovered.url.origin)).status, 200);
  assert.equal((await fetch(`${recovered.url.origin}/api/quit`, {
    method: 'POST', headers: { ...headers, 'X-Skills-Token': recovered.url.hash.slice('#access='.length) }, body: '{}',
  })).status, 200);
  assert.equal((await recovered.exited)[0], 0);
});

test('icon launcher exits, reopens one background server, and restarts after Stop app', { timeout: 30_000 }, async (t) => {
  const { home, options } = await fixture(t);
  const bin = path.join(home, 'bin');
  const opened = path.join(home, 'opened.log');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'),
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SKILLS_VIEWER_OPEN_LOG"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PORT: '0', PATH: `${bin}:${process.env.PATH}`, SKILLS_VIEWER_DATA_DIR: options.dataDir, SKILLS_VIEWER_OPEN_LOG: opened };
  const urls = new Set();
  const stop = async (url) => fetch(`${url.origin}/api/quit`, {
    method: 'POST', headers: { 'X-Skills-Token': url.hash.slice('#access='.length), 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(2000),
  });
  t.after(async () => {
    for (const url of urls) {
      try { await stop(url); } catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED') throw error;
      }
    }
  });
  const click = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../launcher.mjs', import.meta.url)), '--background',
    ], { env, timeout: 10_000 });
    const url = new URL(stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#access=[a-f0-9]{64}/)[0]);
    urls.add(url);
    return url;
  };
  const [first, repeated] = await Promise.all([click(), click()]);
  assert.equal(first.href, repeated.href);
  assert.equal((await fetch(first.origin)).status, 200);
  assert.equal((await fetch(`${first.origin}/api/state`)).status, 401);
  assert.equal((await click()).href, first.href);
  assert.deepEqual((await fs.readFile(opened, 'utf8')).trim().split('\n'), [first.href, first.href, first.href]);
  assert.deepEqual((await Promise.all([click(), click()])).map((url) => url.href), [first.href, first.href]);
  assert.equal((await stop(first)).status, 200);
  urls.delete(first);
  const restarted = await click();
  assert.notEqual(restarted.hash, first.hash);
  assert.equal((await fetch(restarted.origin)).status, 200);
  const log = await fs.stat(path.join(options.dataDir, 'launcher.log'));
  assert.equal(log.mode & 0o777, 0o600);
});

test('Linux menu installation uses absolute quoted paths and does not start a server', async (t) => {
  const { home } = await fixture(t);
  const data = path.join(home, 'desktop data');
  const application = path.join(home, 'app $100%');
  await fs.mkdir(application);
  for (const file of ['launcher.mjs', 'server.mjs', 'core.mjs', 'recovery.mjs']) {
    await fs.copyFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(application, file));
  }
  await promisify(execFile)(process.execPath, [
    path.join(application, 'launcher.mjs'), '--install',
  ], { env: { ...process.env, HOME: home, XDG_DATA_HOME: data } });
  const entry = await fs.readFile(path.join(data, 'applications', 'skills-viewer.desktop'), 'utf8');
  assert(entry.includes(`Exec="${process.execPath}" "`));
  assert(entry.includes(String.raw`app \\$100%%`));
  assert(entry.includes('launcher.mjs" --background\n'));
  assert(entry.includes('Terminal=false\n'));
  assert(entry.includes(`Icon=${path.join(application, 'icon.svg')}\n`));
});
