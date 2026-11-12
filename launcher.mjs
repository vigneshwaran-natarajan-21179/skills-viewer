import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createApp } from './server.mjs';

const filename = fileURLToPath(import.meta.url);

async function openBrowser(url) {
  const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  const [code, signal] = await once(browser, 'exit');
  if (code !== 0) throw new Error(`Browser opener failed (${signal || code}). Use the private launch link above.`);
}

async function launch(url) {
  console.log(`Skills Viewer 1.0 private launch link (do not share):\n${url}`);
  if (process.send) process.send(url);
  if (!process.argv.includes('--no-open')) await openBrowser(url);
}

async function main() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Skills Viewer 1.0 supports macOS and Linux.');
  if (process.argv.includes('--install')) {
    const applications = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'applications');
    const quote = (value) => `"${value.replace(/\\/g, '\\\\\\\\').replace(/["`$]/g, '\\\\$&').replace(/%/g, '%%')}"`;
    await fs.mkdir(applications, { recursive: true });
    const desktopFile = path.join(applications, 'skills-viewer.desktop');
    await fs.writeFile(desktopFile, `[Desktop Entry]\nType=Application\nName=Skills Viewer\nComment=Local AI skills dashboard\nExec=${quote(process.execPath)} ${quote(filename)} --background\nIcon=${path.join(path.dirname(filename), 'icon.svg').replace(/\\/g, '\\\\')}\nTerminal=false\nCategories=Development;Utility;\n`, { mode: 0o755 });
    console.log(`Installed ${desktopFile}. Keep the extracted application in its current location.`);
    return;
  }
  const requestedPort = Number(process.env.PORT || 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid PORT.');

  if (process.argv.includes('--background')) {
    const dataDir = process.env.SKILLS_VIEWER_DATA_DIR || path.join(homedir(), '.config', 'skills-viewer');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const log = await fs.open(path.join(dataDir, 'launcher.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [filename, '--no-open'], {
        detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'],
      });
      const url = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Background launcher exited (${code}). See ${path.join(dataDir, 'launcher.log')}.`)));
        child.once('message', resolve);
      });
      if (child.connected) child.disconnect();
      child.unref();
      await launch(url);
    } finally {
      await log.close();
    }
    return;
  }

  const profile = path.resolve(process.env.SKILLS_VIEWER_DATA_DIR || path.join(homedir(), '.config', 'skills-viewer'));
  const id = createHash('sha256').update(`${process.getuid()}:${profile}`).digest('hex').slice(0, 16);
  const runtime = path.join(tmpdir(), `sv-${id}`);
  await fs.mkdir(runtime, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(runtime);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error(`Unsafe launcher directory: ${runtime}`);
  const socketPath = path.join(runtime, 'app.sock');
  let ready;
  // ponytail: a private local socket shares the launch link without exposing it through HTTP.
  const control = net.createServer((socket) => {
    socket.on('error', (error) => console.error(`Launcher connection failed: ${error.message}`));
    ready.then((url) => socket.end(url), () => socket.destroy());
  });
  let server;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        control.listen(socketPath);
        await once(control, 'listening');
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        try {
          const url = await new Promise((resolve, reject) => {
            const socket = net.createConnection(socketPath);
            let result = '';
            socket.setEncoding('utf8');
            socket.setTimeout(10_000, () => socket.destroy(new Error('Existing launcher did not respond.')));
            socket.on('data', (chunk) => { result += chunk; });
            socket.once('error', reject);
            socket.once('end', () => resolve(result));
          });
          if (!/^http:\/\/127\.0\.0\.1:\d+\/#access=[a-f0-9]{64}$/.test(url)) throw new Error('Invalid response from existing launcher.');
          await launch(url);
          return;
        } catch (error) {
          if (!['ECONNREFUSED', 'ENOENT'].includes(error.code) || attempt >= 2) throw error;
          console.error('Recovering a stopped desktop launcher.');
          await fs.rm(socketPath, { force: true });
        }
      }
    }
    server = createApp({ includeCwd: false, cwd: path.join(homedir(), 'Projects', 'Skills Viewer') });
    ready = new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, '127.0.0.1', () => resolve(server.launchURL()));
    });
    server.once('close', () => control.close());
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
    await launch(await ready);
  } catch (error) {
    server?.close();
    control.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Skills Viewer could not start: ${error.message}`);
  process.exitCode = 1;
});
