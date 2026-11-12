import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = manifest.version;
const targets = process.argv.slice(2);
const supported = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
if (targets.some((target) => !supported.includes(target))) throw new Error(`Targets: ${supported.join(', ')}`);
const output = path.join(root, 'dist');
await fs.mkdir(output, { recursive: true });

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const releases = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString());
const runtimeVersion = releases.find((release) => /^v22\./.test(release.version) && release.lts)?.version;
if (!runtimeVersion) throw new Error('No supported Node.js 22 LTS runtime found.');
const checksums = (await download(`https://nodejs.org/dist/${runtimeVersion}/SHASUMS256.txt`)).toString();
const checksumsOut = [];

for (const target of targets.length ? targets : supported) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-viewer-package-'));
  try {
    const archiveName = `node-${runtimeVersion}-${target}.tar.gz`;
    console.log(`Packaging Skills Viewer ${version} for ${target} with ${runtimeVersion}...`);
    const bytes = await download(`https://nodejs.org/dist/${runtimeVersion}/${archiveName}`);
    const expected = checksums.split('\n').find((line) => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Runtime checksum mismatch: ${target}`);
    const runtimeArchive = path.join(temporary, archiveName);
    await fs.writeFile(runtimeArchive, bytes);
    await execute('tar', ['-xzf', runtimeArchive, '-C', temporary]);
    const runtime = path.join(temporary, archiveName.replace(/\.tar\.gz$/, ''));
    const isMac = target.startsWith('darwin');
    const bundleName = isMac ? 'Skills Viewer.app' : 'skills-viewer';
    const bundle = path.join(temporary, bundleName);
    const resources = isMac ? path.join(bundle, 'Contents', 'Resources') : bundle;
    const application = path.join(resources, 'app');
    await fs.mkdir(application, { recursive: true });
    for (const file of ['package.json', 'server.mjs', 'core.mjs', 'recovery.mjs', 'launcher.mjs', 'index.html', 'app.js', 'styles.css', 'base.css', 'tokens.css', 'icon.svg', 'README.md']) {
      await fs.copyFile(path.join(root, file), path.join(application, file));
    }
    await fs.mkdir(path.join(resources, 'runtime'), { recursive: true });
    await fs.copyFile(path.join(runtime, 'bin', 'node'), path.join(resources, 'runtime', 'node'));
    await fs.chmod(path.join(resources, 'runtime', 'node'), 0o755);
    await fs.copyFile(path.join(runtime, 'LICENSE'), path.join(resources, 'runtime', 'LICENSE'));
    if (isMac) {
      const executable = path.join(bundle, 'Contents', 'MacOS', 'skills-viewer');
      await fs.mkdir(path.dirname(executable), { recursive: true });
      await fs.writeFile(executable, '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)\nexec "$ROOT/runtime/node" "$ROOT/app/launcher.mjs" --background "$@"\n', { mode: 0o755 });
      await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>Skills Viewer</string>\n<key>CFBundleDisplayName</key><string>Skills Viewer</string>\n<key>CFBundleIdentifier</key><string>local.skills-viewer.app</string>\n<key>CFBundleVersion</key><string>${version}</string>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleExecutable</key><string>skills-viewer</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>LSMinimumSystemVersion</key><string>11.0</string>\n<key>LSUIElement</key><true/>\n</dict></plist>\n`);
    } else {
      await fs.writeFile(path.join(bundle, 'skills-viewer'), '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/runtime/node" "$ROOT/app/launcher.mjs" --background "$@"\n', { mode: 0o755 });
    }
    const filename = `skills-viewer-${version}-${target}${isMac ? '.zip' : '.tar.gz'}`;
    const destination = path.join(output, filename);
    await fs.rm(destination, { force: true });
    if (isMac) await execute('zip', ['-q', '-r', destination, bundleName], { cwd: temporary, maxBuffer: 1024 * 1024 });
    else await execute('tar', ['-czf', destination, '-C', temporary, bundleName]);
    const digest = createHash('sha256').update(await fs.readFile(destination)).digest('hex');
    checksumsOut.push(`${digest}  ${filename}`);
    console.log(`Created ${destination}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${checksumsOut.join('\n')}\n`);
