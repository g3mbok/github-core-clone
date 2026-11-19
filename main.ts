import { createServer } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { ForgeStore, TOKEN_OWNER } from './store.ts';

const environmentUrl = process.env.MAKEFUN_ENV_URL;
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const store = new ForgeStore();

function readBody(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body exceeds the allowed size'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': 'FORGE00000000',
  });
  res.end(JSON.stringify({ message }));
}

const server = createServer(async (req, res) => {
  const rawUrl = req.url ?? '/';
  // The env's boot check calls this twice before any route is exercised. Keep it as the first
  // branch: it is the only request that needs no token, no URL parse and no handler chain.
  if (req.method === 'GET' && rawUrl === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': 12 });
    res.end('{"ok":true}\n');
    return;
  }
  const url = new URL(rawUrl, 'http://localhost');
  const path = url.pathname;
  try {
    // Dispatch on the path prefix before calling any handler: the old chain built a second URL in
    // mcp.ts and graphql.ts on every request, and the read workload makes two thousand of them.
    if (path === '/mcp') {
      if (await handleMcp(req, res, store, token)) return;
    } else if (path === '/api/graphql' || path === '/graphql') {
      if (await handleGraphql(req, res, store, token, TOKEN_OWNER)) return;
    } else if (path.startsWith('/api/v3')) {
      if (await handleRest(req, res, url, store, token)) return;
    } else if (path.endsWith('.git') || path.includes('.git/')) {
      if (await handleGit(req, res, store, url, readBody)) return;
    }
    sendError(res, 404, 'Not Found');
  } catch (failure) {
    sendError(res, 500, failure instanceof Error ? failure.message : 'Internal server error');
  }
});

async function start() {
  if (!environmentUrl) throw new Error('MAKEFUN_ENV_URL is required');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The server did not bind to a TCP port');
  const register = await fetch(`${environmentUrl.replace(/\/+$/, '')}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: address.port }),
  });
  if (!register.ok) throw new Error(`Registration failed with HTTP ${register.status}`);
  for (;;) {
    const response = await fetch(`${environmentUrl.replace(/\/+$/, '')}/done`);
    if (!response.ok) throw new Error(`Environment status polling failed with HTTP ${response.status}`);
    const status = await response.json();
    if (status.done === true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await new Promise((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
}

start().catch((failure) => {
  console.error(failure instanceof Error ? failure.stack : failure);
  process.exitCode = 1;
});
