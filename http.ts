const JSON_MIME = 'application/json; charset=utf-8';
const FORGE_REQUEST_ID = 'FORGE00000000';
const BODY_CEILING = 64 * 1024 * 1024;
const GRAPH_ENDPOINTS = new Set(['/api/graphql', '/graphql']);
const REST_BASE = '/api/v3';

export const ROUTE = Object.freeze({
  mcp: 'mcp',
  graphql: 'graphql',
  rest: 'rest',
  git: 'git',
  unknown: 'unknown',
});

export function jsonHeaders() {
  return { 'content-type': JSON_MIME };
}

export function tracedHeaders() {
  const headers = jsonHeaders();
  headers['x-github-request-id'] = FORGE_REQUEST_ID;
  return headers;
}

export function withLength(body, base = jsonHeaders()) {
  const headers = { ...base };
  headers['content-length'] = String(Buffer.byteLength(body));
  return headers;
}

export function writeBody(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

export function writeJsonValue(res, status, value, headers = jsonHeaders()) {
  writeBody(res, status, JSON.stringify(value), headers);
}

export function writeFailure(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  writeJsonValue(res, status, { message }, tracedHeaders());
}

export function writeFixedJson(res, body) {
  writeBody(res, 200, body, withLength(body));
}

export function writeAccepted(res) {
  res.writeHead(202);
  res.end();
}

export function failureMessage(failure) {
  if (failure instanceof Error && failure.message) return failure.message;
  return 'Internal server error';
}

export function collectBody(req, ceiling = BODY_CEILING) {
  return new Promise((resolve, reject) => {
    const pieces = [];
    let received = 0;
    req.on('data', (piece) => {
      received += piece.length;
      if (received > ceiling) {
        reject(new Error('Request body exceeds the configured limit'));
        req.destroy();
        return;
      }
      pieces.push(Buffer.from(piece));
    });
    req.once('end', () => resolve(Buffer.concat(pieces)));
    req.once('error', reject);
  });
}

export function rawPath(req) {
  return req.url ?? '/';
}

export function isHealthProbe(req, path) {
  return req.method === 'GET' && path === '/healthz';
}

export function isMcpEndpoint(path) {
  return path === '/mcp';
}

export function isGraphEndpoint(path) {
  return GRAPH_ENDPOINTS.has(path);
}

export function isRestEndpoint(path) {
  return path.startsWith(REST_BASE);
}

export function isGitEndpoint(path) {
  if (path.endsWith('.git')) return true;
  return path.includes('.git/');
}

export function routeKind(path) {
  if (isMcpEndpoint(path)) return ROUTE.mcp;
  if (isGraphEndpoint(path)) return ROUTE.graphql;
  if (isRestEndpoint(path)) return ROUTE.rest;
  if (isGitEndpoint(path)) return ROUTE.git;
  return ROUTE.unknown;
}

export function cleanBase(value) {
  return value.replace(/\/+$/, '');
}
