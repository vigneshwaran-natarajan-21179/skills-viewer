import { spawn } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './server.mjs';

if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Skills Viewer 1.0 supports macOS and Linux.');
const requestedPort = Number(process.env.PORT || 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid PORT.');
const server = createApp({ includeCwd: false, cwd: path.join(homedir(), 'Projects', 'Skills Viewer') });
server.on('error', (error) => {
  console.error(`Skills Viewer could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(requestedPort, '127.0.0.1', () => {
  const url = server.launchURL();
  console.log(`Skills Viewer 1.0 private launch link (do not share):\n${url}`);
  if (process.argv.includes('--no-open')) return;
  const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  browser.on('error', (error) => console.error(`Could not open your browser: ${error.message}. Use the private launch link above.`));
  browser.on('exit', (code) => {
    if (code) console.error(`Browser opener exited with ${code}. Use the private launch link above.`);
  });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
