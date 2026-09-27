// Zero-dependency static server for the fixture pages (manual smoke and Playwright).
// http://localhost:PORT and http://127.0.0.1:PORT reach the same files as two different
// origins: that is how fields.html gets a cross-origin frame.
//   node test/fixtures/serve.mjs          (PORT defaults to 8765)
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_PORT = 8765;
// Loopback only. Browsers try ::1 first for "localhost", so listen there too when IPv6 exists.
const HOSTS = ['127.0.0.1', '::1'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.png': 'image/png',
};

/** Extra response headers per fixture file. */
const EXTRA_HEADERS = {
  'pp-denied.html': { 'Permissions-Policy': 'microphone=()' },
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** @type {import('node:http').RequestListener} */
async function handle(req, res) {
  let name;
  try {
    name = decodeURIComponent(new URL(req.url ?? '/', 'http://fixtures').pathname).replace(/^\/+/, '') || 'fields.html';
  } catch {
    plain(res, 400, 'Bad request');
    return;
  }
  const file = normalize(join(ROOT, name));
  const rel = relative(ROOT, file);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    plain(res, 403, 'Forbidden');
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    plain(res, 404, 'Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    ...(EXTRA_HEADERS[rel] ?? {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
}

/**
 * Serve test/fixtures/ on the loopback addresses.
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startFixtureServer({ port = Number(process.env.PORT) || DEFAULT_PORT } = {}) {
  const servers = [];
  for (const host of HOSTS) {
    const server = createServer(handle);
    try {
      await listen(server, port, host);
      servers.push(server);
    } catch (err) {
      // A machine without IPv6 still serves both names over 127.0.0.1.
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)) continue;
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      throw err;
    }
  }
  return {
    port,
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))).then(() => {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const { port } = await startFixtureServer();
  console.log(`VoiceType fixtures on http://localhost:${port}/fields.html (cross-origin host http://127.0.0.1:${port})`);
}
