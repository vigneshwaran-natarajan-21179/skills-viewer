import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const idFor = (value) => hash(value).slice(0, 20);
const MAX_DOCUMENT = 512 * 1024;
const WORKSPACE_ROOTS = ['.agents/skills', '.github/skills', '.claude/skills', '.codex/skills', '.copilot/skills', '.cursor/skills', '.gemini/skills'];

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function text(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new InputError(`${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

async function exists(location) {
  try {
    return await fs.lstat(location);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function prospectivePath(location) {
  try {
    return await fs.realpath(location);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    if (parent === location) throw error;
    return path.join(await prospectivePath(parent), path.basename(location));
  }
}

function metadata(document, fallback) {
  const front = document.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const fields = {};
  const lines = front.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    fields[match[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return {
    name: (fields.name || document.match(/^#\s+(.+)$/m)?.[1] || fallback).slice(0, 160),
    description: (fields.description || document.split(/\r?\n/).find((line) => line.trim() && !/^(#|---|[a-z-]+:|\s)/i.test(line)) || 'No description in SKILL.md.').slice(0, 500),
  };
}

export function createStore({ home = homedir(), cwd = process.cwd(), includeCwd = true, dataDir = process.env.SKILLS_VIEWER_DATA_DIR || path.join(home, '.config', 'skills-viewer') } = {}) {
  const configFile = path.join(dataDir, 'settings.json');
  let config;
  const expand = (value) => {
    const input = text(value, 'Absolute folder path');
    const expanded = input === '~' ? home : input.startsWith('~/') ? path.join(home, input.slice(2)) : input;
    if (!path.isAbsolute(expanded)) throw new InputError('Use an absolute path or a path beginning with ~/.');
    return path.resolve(expanded);
  };
  const defaults = () => ({
    version: 1,
    agents: [{ id: 'shared', name: 'Shared library', path: path.join(home, '.agents', 'skills'), root: path.join(home, '.agents', 'skills'), note: 'Shared convention; register other agent folders for explicit access.' }],
    workspaces: includeCwd ? [{ id: idFor(cwd), name: path.basename(cwd), path: cwd }] : [],
    activity: [],
    removed: [],
  });

  async function load() {
    if (config) return config;
    try {
      const parsed = JSON.parse(await fs.readFile(configFile, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.agents) || !Array.isArray(parsed.workspaces) || !Array.isArray(parsed.activity) || (parsed.removed !== undefined && !Array.isArray(parsed.removed))) {
        throw new Error('Unsupported or invalid settings format.');
      }
      config = {
        ...parsed,
        agents: parsed.agents.filter((agent) => !(agent.builtin && !agent.path && ['sahaa', 'zllm'].includes(agent.id))),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot load ${configFile}: ${error.message}. Your settings were not changed.`);
      config = defaults();
    }
    return config;
  }

  async function save(next) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dataDir, `settings-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, configFile);
      config = next;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async function readDocument(directory) {
    const filename = path.join(directory, 'SKILL.md');
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile()) throw new InputError('SKILL.md must be a regular file, not a symbolic link.');
      if (info.size > MAX_DOCUMENT) throw new InputError('SKILL.md exceeds the 512 KiB preview/edit limit.');
      const buffer = Buffer.alloc(MAX_DOCUMENT + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_DOCUMENT) throw new InputError('SKILL.md exceeds the 512 KiB preview/edit limit.');
      return buffer.toString('utf8', 0, total);
    } catch (error) {
      if (error.code === 'ELOOP') throw new InputError('SKILL.md must be a regular file, not a symbolic link.');
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async function snapshot() {
    const current = await load();
    const warnings = [];
    const skills = new Map();
    const agents = [];
    const workspaces = current.workspaces.map((workspace) => ({ ...workspace, count: 0 }));
    let entriesVisited = 0;
    async function scan(root, owner, scope) {
      let entries;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`${root}: ${error.message}`);
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        if (++entriesVisited > 6000) {
          if (!warnings.includes('Inventory scan capped at 6,000 folders. Register a narrower skills folder.')) warnings.push('Inventory scan capped at 6,000 folders. Register a narrower skills folder.');
          return;
        }
        const directory = path.join(root, entry.name);
        try {
          const canonical = await fs.realpath(directory);
          if (!(await exists(path.join(canonical, 'SKILL.md')))) continue;
          const document = await readDocument(canonical);
          const id = idFor(canonical);
          if (!skills.has(id)) skills.set(id, { id, ...metadata(document, entry.name), folder: path.basename(canonical), path: canonical, version: hash(document), locations: [] });
          skills.get(id).locations.push({ path: directory, ownerId: owner.id, ownerName: owner.name, scope, linked: entry.isSymbolicLink() });
          owner.count++;
        } catch (error) {
          warnings.push(`${directory}: ${error.message}`);
        }
      }
    }
    for (const agent of current.agents) {
      const evidence = await exists(agent.root || agent.path);
      const skillsFolder = agent.path ? await exists(agent.path) : null;
      const row = { ...agent, count: 0, detected: !!evidence, evidencePath: agent.root || agent.path, skillsFolderExists: !!skillsFolder };
      agents.push(row);
      if (agent.path) await scan(agent.path, row, 'system');
    }
    for (const workspace of workspaces) {
      workspace.available = !!(await exists(workspace.path));
      const roots = new Set([workspace.path, ...WORKSPACE_ROOTS.map((part) => path.join(workspace.path, part))]);
      for (const root of roots) await scan(root, workspace, 'workspace');
    }
    return {
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      agents, workspaces, warnings, activity: current.activity, removed: current.removed || [],
      home, configFile, scannedAt: new Date().toISOString(),
      memoryBytes: process.memoryUsage().rss,
    };
  }

  async function resolveSkill(id) {
    const inventory = await snapshot();
    const skill = inventory.skills.find((item) => item.id === id);
    if (!skill) throw new InputError('Skill is no longer available. Refresh the inventory.', 404);
    return skill;
  }

  async function detail(id) {
    const skill = await resolveSkill(id);
    const document = await readDocument(skill.path);
    const entries = await fs.readdir(skill.path, { withFileTypes: true });
    return { ...skill, document, version: hash(document), files: entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory(), linked: entry.isSymbolicLink() })).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async function addAgent(input) {
    const current = await load();
    const name = text(input.name, 'Agent name', 80);
    const location = await prospectivePath(expand(input.path));
    if (location === await prospectivePath(home) || location === path.parse(location).root) throw new InputError('Choose a dedicated skills folder, not your home or filesystem root.');
    const info = await exists(location);
    if (info && !(await fs.stat(location)).isDirectory()) throw new InputError('The skills path must be a folder.');
    const existing = current.agents.find((agent) => agent.id === input.id);
    if (input.id && !existing) throw new InputError('Agent not found.', 404);
    if (current.agents.some((agent) => agent.id !== input.id && agent.name.toLowerCase() === name.toLowerCase())) throw new InputError('An agent with that name already exists.', 409);
    if (current.agents.some((agent) => agent.id !== input.id && agent.path === location)) throw new InputError('That skills folder already belongs to an agent.', 409);
    const agent = { ...existing, id: existing?.id || randomUUID(), name, path: location, root: location, note: 'Custom folder. Confirm your agent supports SKILL.md and this location.', builtin: existing?.builtin || false };
    await save({ ...current, agents: existing ? current.agents.map((item) => item.id === existing.id ? agent : item) : [...current.agents, agent] });
    return agent;
  }

  async function addWorkspace(input) {
    const current = await load();
    const location = await fs.realpath(expand(input.path));
    if (!(await fs.stat(location)).isDirectory()) throw new InputError('The workspace path must be a folder.');
    if (current.workspaces.some((workspace) => workspace.path === location)) throw new InputError('That workspace is already registered.', 409);
    const workspace = { id: idFor(location), name: path.basename(location), path: location };
    await save({ ...current, workspaces: [...current.workspaces, workspace] });
    return workspace;
  }

  async function removeRegistration(kind, id) {
    const current = await load();
    if (!['agents', 'workspaces'].includes(kind)) throw new InputError('Invalid registration type.');
    const item = current[kind].find((entry) => entry.id === id);
    if (!item) throw new InputError('Registration not found.', 404);
    await save({ ...current, [kind]: current[kind].filter((entry) => entry.id !== id) });
    return { message: 'Registration removed. No skill files were deleted.' };
  }

  async function discover() {
    const candidates = [];
    const warnings = [];
    const current = await load();
    const seen = new Set();
    let visited = 0;
    // shortcut: bounded discovery in common project folders; register other repositories explicitly.
    async function walk(directory, depth) {
      if (visited++ >= 1500) return;
      let real;
      try {
        real = await fs.realpath(directory);
        if (seen.has(real)) return;
        seen.add(real);
        const found = [];
        for (const part of WORKSPACE_ROOTS) {
          const info = await exists(path.join(real, part));
          if (info && (await fs.stat(path.join(real, part))).isDirectory()) found.push(part);
        }
        if (found.length && !current.workspaces.some((item) => item.path === real)) candidates.push({ path: real, name: path.basename(real), roots: found });
        if (!depth || found.length) return;
        for (const entry of await fs.readdir(real, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'vendor', 'dist', 'build', 'Library', 'target'].includes(entry.name)) await walk(path.join(real, entry.name), depth - 1);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`${directory}: ${error.message}`);
      }
    }
    for (const directory of new Set([path.dirname(cwd), ...['Projects', 'AI Projects', 'Developer', 'code', 'repos', 'work', 'git'].map((name) => path.join(home, name))])) await walk(directory, 3);
    if (visited >= 1500) warnings.push('Discovery stopped at 1,500 folders. Add other workspace paths manually.');
    return { candidates, warnings };
  }

  async function validateCopy(directory) {
    let bytes = 0;
    let count = 0;
    async function walk(location) {
      for (const entry of await fs.readdir(location, { withFileTypes: true })) {
        const filename = path.join(location, entry.name);
        if (++count > 2000) throw new InputError('Copy exceeds 2,000 files/folders. Use a link instead.');
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new InputError('Copies require regular files and folders only. This skill contains links or special files; use a link instead.');
        if (entry.isDirectory()) await walk(filename);
        else bytes += (await fs.stat(filename)).size;
        if (bytes > 25 * 1024 * 1024) throw new InputError('Copy exceeds 25 MiB. Use a link instead.');
      }
    }
    await walk(directory);
  }

  async function sync(input) {
    if (!['link', 'copy'].includes(input.mode)) throw new InputError('Choose link or copy.');
    if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 50 || input.targets.some((id) => typeof id !== 'string')) throw new InputError('Choose between 1 and 50 agent destinations.');
    const skill = await resolveSkill(input.skillId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(skill.folder)) throw new InputError('Skill folder names must use letters, numbers, dots, underscores or hyphens, and start with a letter or number.');
    const current = await load();
    const targets = await Promise.all([...new Set(input.targets)].map(async (id) => {
      const agent = current.agents.find((item) => item.id === id);
      if (!agent?.path) throw new InputError('Every destination needs a configured skills folder.');
      const destination = path.join(agent.path, skill.folder);
      const parent = await prospectivePath(agent.path);
      if (parent === skill.path || parent.startsWith(`${skill.path}${path.sep}`)) throw new InputError(`Cannot share a skill into itself (${agent.name}).`);
      return { agent, destination };
    }));
    if (input.mode === 'copy') await validateCopy(skill.path);
    const results = [];
    for (const { agent, destination } of targets) {
      let created = false;
      try {
        const previous = await exists(destination);
        if (previous) {
          const same = await fs.realpath(destination).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          }) === skill.path;
          results.push({ agent: agent.name, path: destination, status: same ? 'unchanged' : 'conflict', message: same ? 'Already uses this source.' : 'Destination exists. Nothing was overwritten.' });
          continue;
        }
        await fs.mkdir(agent.path, { recursive: true });
        const canonicalParent = await fs.realpath(agent.path);
        if (canonicalParent === skill.path || canonicalParent.startsWith(`${skill.path}${path.sep}`)) throw new InputError('The destination resolves inside the source skill.');
        if (input.mode === 'link') await fs.symlink(skill.path, destination, 'dir');
        else {
          await fs.mkdir(destination, { mode: (await fs.stat(skill.path)).mode & 0o777 });
          created = true;
          for (const name of await fs.readdir(skill.path)) {
            await fs.cp(path.join(skill.path, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true, dereference: false });
          }
        }
        created = true;
        const event = { id: randomUUID(), skill: skill.name, source: skill.path, agent: agent.name, destination, destinationParent: canonicalParent, mode: input.mode, at: new Date().toISOString() };
        try {
          await save({ ...config, activity: [event, ...config.activity].slice(0, 200) });
        } catch (error) {
          if (input.mode === 'link') await fs.unlink(destination);
          else await fs.rm(destination, { recursive: true });
          created = false;
          throw error;
        }
        results.push({ agent: agent.name, path: destination, status: 'created', message: input.mode === 'link' ? 'Linked. Source changes are available immediately.' : 'Copied. Future source changes are not synced.' });
      } catch (error) {
        if (created && input.mode === 'copy') await fs.rm(destination, { recursive: true });
        results.push({ agent: agent.name, path: destination, status: 'error', message: error.message });
      }
    }
    return { results };
  }

  async function edit(input) {
    if (typeof input.document !== 'string' || Buffer.byteLength(input.document) > MAX_DOCUMENT) throw new InputError('Skill content must be text no larger than 512 KiB.');
    const skill = await resolveSkill(input.skillId);
    const original = await readDocument(skill.path);
    if (hash(original) !== input.version) throw new InputError('This skill changed since you opened it. Reload before saving; your edit was not written.', 409);
    const filename = path.join(skill.path, 'SKILL.md');
    const info = await fs.stat(filename);
    const temporary = path.join(skill.path, `.SKILL-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, input.document, { flag: 'wx', mode: info.mode });
      if (hash(await readDocument(skill.path)) !== input.version) throw new InputError('The file changed while saving. Reload and try again.', 409);
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { version: hash(input.document), message: 'SKILL.md saved. All linked agents use this source.' };
  }

  async function unlinkManaged(input) {
    const current = await load();
    const event = current.activity.find((item) => item.id === input.id);
    if (!event || event.mode !== 'link' || event.undone) throw new InputError('Only active links created by this app can be disconnected.');
    const info = await exists(event.destination);
    if (info && (!info.isSymbolicLink() || await fs.readlink(event.destination) !== event.source)) throw new InputError('The destination has changed. Nothing was removed.', 409);
    const parent = await fs.realpath(path.dirname(event.destination));
    if (event.destinationParent && parent !== event.destinationParent) throw new InputError('The destination parent changed. Nothing was disconnected.', 409);
    if (info) await fs.unlink(path.join(parent, path.basename(event.destination)));
    try {
      await save({ ...current, activity: current.activity.map((item) => item.id === event.id ? { ...item, undone: true } : item) });
    } catch (error) {
      if (info) await fs.symlink(event.source, path.join(parent, path.basename(event.destination)), 'dir');
      throw error;
    }
    return { message: 'Link disconnected. The original skill is untouched.' };
  }

  async function dismissActivity(input) {
    const current = await load();
    const event = current.activity.find((item) => item.id === input.id);
    if (!event) throw new InputError('Activity entry not found.', 404);
    if (event.mode === 'link' && !event.undone) throw new InputError('Disconnect this active link before removing its history entry.', 409);
    if ((current.removed || []).some((item) => item.id === event.id)) throw new InputError('Restore this removed skill before clearing its history entry.', 409);
    await save({ ...current, activity: current.activity.filter((item) => item.id !== event.id) });
    return { message: 'History entry removed. No skill files or sharing destinations were changed.' };
  }

  async function removeSkill(input) {
    const skill = await resolveSkill(input.skillId);
    if (input.confirmation !== skill.name) throw new InputError('Type the skill name exactly to confirm removal.');
    const location = skill.locations.find((entry) => entry.path === input.location);
    if (!location) throw new InputError('Choose a currently registered skill location.', 409);
    if (hash(await readDocument(skill.path)) !== input.version) throw new InputError('This skill changed. Reload its details before removing it.', 409);
    const info = await fs.lstat(location.path);
    if (await fs.realpath(location.path) !== skill.path) throw new InputError('This location changed. Nothing was removed.', 409);
    if (!info.isSymbolicLink() && skill.locations.some((entry) => entry.path !== location.path)) {
      throw new InputError('Other registered locations use this source. Remove their links or registrations first; the source was not moved.', 409);
    }
    const archiveRoot = await prospectivePath(path.join(dataDir, 'trash'));
    if (archiveRoot === skill.path || archiveRoot.startsWith(`${skill.path}${path.sep}`)) throw new InputError('The recovery folder is inside this skill. Choose a different SKILLS_VIEWER_DATA_DIR.');
    const current = await load();
    const id = randomUUID();
    await fs.mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    const archive = path.join(archiveRoot, id);
    await fs.mkdir(archive, { mode: 0o700 });
    const event = {
      id, skill: skill.name, source: location.path, destination: path.join(archive, 'skill'),
      mode: info.isSymbolicLink() ? 'remove-link' : 'remove-skill',
      agent: location.ownerName, at: new Date().toISOString(),
      linkTarget: info.isSymbolicLink() ? await fs.readlink(location.path) : null,
      parent: await parentIdentity(path.dirname(location.path)),
    };
    let moved = false;
    try {
      await fs.rename(path.join(event.parent.path, path.basename(event.source)), event.destination);
      moved = true;
      const previous = current.activity.map((item) => item.mode === 'link' && item.destination === location.path ? { ...item, undone: true } : item);
      await save({ ...current, removed: [event, ...(current.removed || [])], activity: [event, ...previous].slice(0, 200) });
    } catch (error) {
      if (moved) await fs.rename(event.destination, event.source);
      await fs.rmdir(archive);
      if (error.code === 'EXDEV') throw new InputError('This skill is on a different filesystem from the recovery folder. Nothing was removed. Use a profile on that filesystem or manage the files manually.');
      throw error;
    }
    return { message: info.isSymbolicLink() ? 'Link removed. The source is untouched. Restore it from Activity if needed.' : 'Skill moved to recovery storage. Restore it from Activity if needed.' };
  }

  async function restoreSkill(input) {
    const current = await load();
    const event = (current.removed || []).find((item) => item.id === input.id);
    if (!event) throw new InputError('Removed skill not found.', 404);
    if (!event.parent) throw new InputError('This older recovery record has no parent identity. Restore it manually after checking the original directory.', 409);
    const parent = await parentIdentity(path.dirname(event.source));
    if (parent.path !== event.parent.path || parent.dev !== event.parent.dev || parent.ino !== event.parent.ino) {
      throw new InputError('The original parent directory changed. Nothing was restored.', 409);
    }
    if (await exists(event.source)) throw new InputError('The original location is occupied. Nothing was overwritten.', 409);
    const info = await fs.lstat(event.destination);
    if (event.mode === 'remove-link' ? !info.isSymbolicLink() || await fs.readlink(event.destination) !== event.linkTarget : !info.isDirectory() || info.isSymbolicLink()) {
      throw new InputError('Recovery storage changed unexpectedly. Nothing was restored.', 409);
    }
    if (event.mode === 'remove-link') {
      const target = path.resolve(path.dirname(event.source), event.linkTarget);
      if (!(await exists(target))) throw new InputError('The original link target is missing. Restore its source first.', 409);
    }
    await recoveryOperation('restore', event);
    try {
      const restored = { id: randomUUID(), skill: event.skill, source: event.destination, destination: event.source, agent: event.agent, mode: 'restore', at: new Date().toISOString() };
      await save({ ...current, removed: current.removed.filter((item) => item.id !== event.id), activity: [restored, ...current.activity].slice(0, 200) });
    } catch (error) {
      await recoveryOperation('rollback', event);
      throw error;
    }
    if (event.mode === 'remove-link') await fs.unlink(event.destination);
    return { message: 'Skill location restored. Rescan or restart the agent if it caches skills.' };
  }

  return { snapshot, detail, addAgent, addWorkspace, removeRegistration, discover, sync, edit, unlinkManaged, removeSkill, restoreSkill, dismissActivity };
}

async function parentIdentity(directory) {
  const canonical = await fs.realpath(directory);
  const info = await fs.stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new InputError('Expected a directory.', 409);
  return { path: canonical, dev: info.dev.toString(), ino: info.ino.toString() };
}

async function recoveryOperation(action, event) {
  try {
    await execute(process.execPath, [fileURLToPath(new URL('./recovery.mjs', import.meta.url)), action, JSON.stringify(event)], { cwd: event.parent.path });
  } catch (error) {
    throw new InputError(`Recovery failed: ${error.stderr?.trim() || error.message}`, 409);
  }
}
