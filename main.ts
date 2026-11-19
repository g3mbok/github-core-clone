import { createServer } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { ForgeStore, TOKEN_OWNER } from './store.ts';
import {
  cleanBase,
  collectBody,
  failureMessage,
  isHealthProbe,
  jsonHeaders,
  rawPath,
  ROUTE,
  routeKind,
  tuneServerSockets,
  writeFailure,
  writeFixedJson,
} from './http.ts';

const environmentUrl = process.env.MAKEFUN_ENV_URL;
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const store = new ForgeStore();

const HEALTH_BODY = '{"ok":true}\n';
const POLL_INTERVAL_MS = 250;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
}

function boundPort(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The server did not bind to a TCP port');
  }
  return address.port;
}

async function register(port) {
  const response = await fetch(`${cleanBase(environmentUrl)}/register`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ port }),
  });
  if (!response.ok) {
    throw new Error(`Registration failed with HTTP ${response.status}`);
  }
}

async function readStatus() {
  const response = await fetch(`${cleanBase(environmentUrl)}/done`);
  if (!response.ok) {
    throw new Error(`Environment status polling failed with HTTP ${response.status}`);
  }
  return response.json();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForEnvironment() {
  for (;;) {
    const status = await readStatus();
    if (status.done === true) return;
    await delay(POLL_INTERVAL_MS);
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((failure) => (
      failure ? reject(failure) : resolve()
    ));
  });
}

async function dispatch(req, res, url) {
  // The route table lives in http.ts so this hot path only performs one
  // classification and then calls the matching handler directly.
  switch (routeKind(url.pathname)) {
    case ROUTE.mcp:
      return handleMcp(req, res, store, token);
    case ROUTE.graphql:
      return handleGraphql(req, res, store, token, TOKEN_OWNER);
    case ROUTE.rest:
      return handleRest(req, res, url, store, token);
    case ROUTE.git:
      return handleGit(req, res, store, url, collectBody);
    default:
      return false;
  }
}

const server = createServer(async (req, res) => {
  const rawUrl = rawPath(req);

  // The environment checks health before registering any work. Answering here
  // avoids token checks, URL parsing and the full handler chain.
  if (isHealthProbe(req, rawUrl)) {
    writeFixedJson(res, HEALTH_BODY);
    return;
  }

  const url = new URL(rawUrl, 'http://localhost');
  try {
    const handled = await dispatch(req, res, url);
    if (!handled) writeFailure(res, 404, 'Not Found');
  } catch (failure) {
    writeFailure(res, 500, failureMessage(failure));
  }
});

tuneServerSockets(server);

async function start() {
  if (!environmentUrl) {
    throw new Error('MAKEFUN_ENV_URL is required');
  }
  await listen(server);
  const port = boundPort(server);
  await register(port);
  await waitForEnvironment();
  await closeServer(server);
}

start().catch((failure) => {
  console.error(failure instanceof Error ? failure.stack : failure);
  process.exitCode = 1;
});
