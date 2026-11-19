import { createIssue, createPull, mergePull } from './domain.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const REVISION = '2026-07-28';

const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' }, owner: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request between two branches.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue.',
    inputSchema: { type: 'object', properties: { subjectId: { type: 'string' }, body: { type: 'string' } }, required: ['subjectId', 'body'] },
  },
]);

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function findRepo(store, args) {
  const owner = String(args.owner ?? 'adaiversen');
  const name = String(args.repo ?? args.name ?? '');
  return store.getRepo(owner, name);
}

function decodeId(value) {
  try { return Buffer.from(String(value), 'base64').toString('utf8'); } catch { return ''; }
}

export async function handleMcp(req, res, store, token) {
  if (new URL(req.url, 'http://localhost').pathname !== '/mcp') return false;
  const authorization = req.headers.authorization ?? '';
  if (!token || authorization !== `Bearer ${token}`) {
    respond(res, 401, rpcError(null, -32001, 'Unauthorized'));
    return true;
  }
  let request;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    respond(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  const id = request?.id;
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    respond(res, 400, rpcError(id, -32600, 'Invalid Request'));
    return true;
  }
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const method = request.method;
  if (method === 'server/discover') {
    respond(res, 200, { jsonrpc: '2.0', id, result: {
      protocolVersion: REVISION,
      supportedVersions: [REVISION],
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      capabilities: { tools: {} },
    } });
    return true;
  }
  if (method === 'initialize') {
    respond(res, 200, { jsonrpc: '2.0', id, result: {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      capabilities: { tools: {} },
    } });
    return true;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (method === 'tools/list') {
    respond(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return true;
  }
  if (method !== 'tools/call') {
    respond(res, 200, rpcError(id, -32601, 'Method not found'));
    return true;
  }
  const name = String(params.name ?? '');
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const definition = TOOLS.find((tool) => tool.name === name);
  if (!definition) {
    respond(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
    return true;
  }
  const missing = definition.inputSchema.required.filter((property) => args[property] === undefined || args[property] === null || args[property] === '');
  if (missing.length) {
    respond(res, 200, rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`));
    return true;
  }
  try {
    let result;
    if (name === 'create_repo') {
      const repo = store.createRepo('adaiversen', args.name, { description: args.description ?? '', private: args.private === true });
      if (!repo) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Repository already exists' }, true) }); return true; }
      result = repoJson(repo);
    } else if (name === 'get_repo') {
      const repo = findRepo(store, args);
      if (!repo) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Not Found' }, true) }); return true; }
      result = repoJson(repo);
    } else if (name === 'create_issue') {
      const repo = findRepo(store, args);
      if (!repo) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Not Found' }, true) }); return true; }
      result = issueJson(createIssue(store, repo, args));
    } else if (name === 'list_issues') {
      const repo = findRepo(store, args);
      if (!repo) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Not Found' }, true) }); return true; }
      const state = String(args.state ?? 'open');
      result = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state).map(issueJson);
    } else if (name === 'create_pull_request') {
      const repo = findRepo(store, args);
      if (!repo) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Not Found' }, true) }); return true; }
      const pull = createPull(store, repo, args);
      if (!pull.head.sha || !pull.base.sha) {
        repo.pulls.delete(pull.number);
        respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Head or base branch does not exist' }, true) });
        return true;
      }
      result = pullJson(pull);
    } else if (name === 'merge_pull_request') {
      const repo = findRepo(store, args);
      const pull = repo?.pulls.get(Number(args.pull_number));
      if (!repo || !pull) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: 'Not Found' }, true) }); return true; }
      const merged = mergePull(repo, pull);
      if (merged.status !== 200) { respond(res, 200, { jsonrpc: '2.0', id, result: toolResult({ message: merged.error }, true) }); return true; }
      result = { ...pullJson(pull), sha: merged.sha, message: merged.message };
    } else {
      const decoded = decodeId(args.subjectId);
      if (!decoded.startsWith('Issue:')) { respond(res, 200, rpcError(id, -32602, 'Invalid subjectId')); return true; }
      const issueId = Number(decoded.slice('Issue:'.length));
      const issue = [...store.repos.values()].flatMap((repo) => [...repo.issues.values()]).find((item) => item.id === issueId);
      if (!issue) { respond(res, 200, rpcError(id, -32602, 'Issue not found')); return true; }
      result = { id: String(issueId), body: String(args.body ?? '') };
      issue.comments.push({ id: store.nextCommentId++, body: result.body, user: { login: issue.user.login }, created_at: '2025-01-01T00:00:00Z' });
    }
    respond(res, 200, { jsonrpc: '2.0', id, result: toolResult(result) });
  } catch (failure) {
    respond(res, 200, rpcError(id, -32603, failure instanceof Error ? failure.message : 'Internal error'));
  }
  return true;
}
