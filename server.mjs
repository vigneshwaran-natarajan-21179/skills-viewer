import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createStore, InputError } from './core.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/tokens.css', ['tokens.css', 'text/css']],
  ['/base.css', ['base.css', 'text/css']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

export function createApp(options = {}) {
  const store = createStore(options);
  const token = randomBytes(32).toString('hex');
  let mutation = Promise.resolve();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    try {
      const port = server.address().port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(request.headers.host)) throw new InputError('Only loopback hosts are allowed.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new InputError('Cross-site access is not allowed.', 403);
      if (request.headers.origin && !allowedHosts.map((host) => `http://${host}`).includes(request.headers.origin)) throw new InputError('Origin not allowed.', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET') {
        if (url.pathname === '/api/state') return send(200, { ...await store.snapshot(), token });
        if (url.pathname === '/api/skill') return send(200, await store.detail(url.searchParams.get('id')));
        if (url.pathname === '/api/discover') return send(200, await store.discover());
        const asset = staticFiles.get(url.pathname);
        if (!asset) throw new InputError('Not found.', 404);
        const content = await readFile(path.join(directory, asset[0]));
        response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
        return response.end(content);
      }
      if (request.method !== 'POST') throw new InputError('Method not allowed.', 405);
      const supplied = Buffer.from(request.headers['x-skills-token'] || '');
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new InputError('Session expired. Refresh this page before making changes.', 403);
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new InputError('Send JSON content.', 415);
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 768 * 1024) throw new InputError('Request is too large.', 413);
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new InputError('Invalid JSON.');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Expected a JSON object.');
      const routes = {
        '/api/agents': () => store.addAgent(input),
        '/api/workspaces': () => store.addWorkspace(input),
        '/api/remove': () => store.removeRegistration(input.kind, input.id),
        '/api/sync': () => store.sync(input),
        '/api/edit': () => store.edit(input),
        '/api/unlink': () => store.unlinkManaged(input),
        '/api/remove-skill': () => store.removeSkill(input),
        '/api/restore-skill': () => store.restoreSkill(input),
      };
      const action = routes[url.pathname];
      if (!action) throw new InputError('Not found.', 404);
      const result = mutation.then(action);
      mutation = result.catch(() => {});
      send(200, await result);
    } catch (error) {
      const status = error instanceof InputError ? error.status : error.code === 'ENOENT' ? 404 : 500;
      if (status === 500) console.error(error);
      if (!response.headersSent) send(status, { error: error.message });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const server = createApp();
  server.on('error', (error) => {
    console.error(`Skills Viewer could not start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Skills Viewer is ready at http://127.0.0.1:${port}\nLocal only. Press Ctrl+C to stop.`));
}
