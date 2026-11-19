import { createIssue, createPull, decodeIssueGlobalId, mergePull } from './domain.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { collectBody, writeAccepted } from './http.ts';
import {
  argumentBag,
  bearerMatches,
  firstArgument,
  integerArgument,
  missingKeys,
  namedTool,
  readJsonRequest,
} from './request.ts';

const REVISION = '2026-07-28';
const DEFAULT_OWNER = 'adaiversen';
const COMMENT_TIME = '2025-01-01T00:00:00Z';

function serverInfo() {
  return {
    name: 'github-core-clone',
    version: '1.0.0',
  };
}

function toolCapabilities() {
  return { tools: {} };
}

function discoveryResult() {
  return {
    protocolVersion: REVISION,
    supportedVersions: [REVISION],
    serverInfo: serverInfo(),
    capabilities: toolCapabilities(),
  };
}

function initializeResult() {
  return {
    protocolVersion: '2025-11-25',
    serverInfo: serverInfo(),
    capabilities: toolCapabilities(),
  };
}

const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['subjectId', 'body'],
    },
  },
]);

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function errorToolResult(message) {
  return toolResult({ message }, true);
}

function findRepo(store, args) {
  const owner = firstArgument(args, ['owner'], DEFAULT_OWNER);
  const name = firstArgument(args, ['repo', 'name']);
  return store.getRepo(owner, name);
}

function addComment(store, args) {
  const issueId = decodeIssueGlobalId(args.subjectId);
  if (issueId === null) {
    return { ok: false, error: 'Invalid subjectId' };
  }
  const issue = [...store.repos.values()]
    .flatMap((repo) => [...repo.issues.values()])
    .find((item) => item.id === issueId);
  if (!issue) {
    return { ok: false, error: 'Issue not found' };
  }
  const body = String(args.body ?? '');
  issue.comments.push({
    id: store.nextCommentId++,
    body,
    user: { login: issue.user.login },
    created_at: COMMENT_TIME,
  });
  return { ok: true, id: issueId, body };
}

function dispatchTool(name, args, store, id, res) {
  let result;
  if (name === 'create_repo') {
    const repo = store.createRepo(DEFAULT_OWNER, args.name, {
      description: args.description ?? '',
      private: args.private === true,
    });
    if (!repo) {
      respond(res, 200, rpcResult(id, errorToolResult('Repository already exists')));
      return;
    }
    result = repoJson(repo);
  } else if (name === 'get_repo') {
    const repo = findRepo(store, args);
    if (!repo) {
      respond(res, 200, rpcResult(id, errorToolResult('Not Found')));
      return;
    }
    result = repoJson(repo);
  } else if (name === 'create_issue') {
    const repo = findRepo(store, args);
    if (!repo) {
      respond(res, 200, rpcResult(id, errorToolResult('Not Found')));
      return;
    }
    result = issueJson(createIssue(store, repo, args));
  } else if (name === 'list_issues') {
    const repo = findRepo(store, args);
    if (!repo) {
      respond(res, 200, rpcResult(id, errorToolResult('Not Found')));
      return;
    }
    const state = String(args.state ?? 'open');
    result = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .map(issueJson);
  } else if (name === 'create_pull_request') {
    const repo = findRepo(store, args);
    if (!repo) {
      respond(res, 200, rpcResult(id, errorToolResult('Not Found')));
      return;
    }
    const pull = createPull(store, repo, args);
    if (!pull.head.sha || !pull.base.sha) {
      repo.pulls.delete(pull.number);
      respond(res, 200, rpcResult(id, errorToolResult('Head or base branch does not exist')));
      return;
    }
    result = pullJson(pull);
  } else if (name === 'merge_pull_request') {
    const repo = findRepo(store, args);
    const pull = repo?.pulls.get(integerArgument(args, 'pull_number'));
    if (!repo || !pull) {
      respond(res, 200, rpcResult(id, errorToolResult('Not Found')));
      return;
    }
    const merged = mergePull(repo, pull);
    if (merged.status !== 200) {
      respond(res, 200, rpcResult(id, errorToolResult(merged.error)));
      return;
    }
    result = { ...pullJson(pull), sha: merged.sha, message: merged.message };
  } else {
    const comment = addComment(store, args);
    if (!comment.ok) {
      respond(res, 200, rpcError(id, -32602, comment.error));
      return;
    }
    result = { id: String(comment.id), body: comment.body };
  }
  respond(res, 200, rpcResult(id, toolResult(result)));
}

export async function handleMcp(req, res, store, token) {
  if (new URL(req.url, 'http://localhost').pathname !== '/mcp') return false;

  if (!bearerMatches(req.headers, token)) {
    respond(res, 401, rpcError(null, -32001, 'Unauthorized'));
    return true;
  }

  let request;
  try {
    request = await readJsonRequest(req, collectBody);
  } catch {
    respond(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  const id = request?.id;
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    respond(res, 400, rpcError(id, -32600, 'Invalid Request'));
    return true;
  }

  const params = argumentBag(request.params);
  const method = request.method;

  if (method === 'server/discover') {
    respond(res, 200, rpcResult(id, discoveryResult()));
    return true;
  }

  if (method === 'initialize') {
    respond(res, 200, rpcResult(id, initializeResult()));
    return true;
  }

  if (method === 'notifications/initialized') {
    writeAccepted(res);
    return true;
  }

  if (method === 'tools/list') {
    respond(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method !== 'tools/call') {
    respond(res, 200, rpcError(id, -32601, 'Method not found'));
    return true;
  }

  const name = String(params.name ?? '');
  const args = argumentBag(params.arguments);
  const definition = namedTool(TOOLS, name);
  if (!definition) {
    respond(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
    return true;
  }

  const missing = missingKeys(definition.inputSchema.required, args);
  if (missing.length) {
    respond(res, 200, rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`));
    return true;
  }

  try {
    dispatchTool(name, args, store, id, res);
  } catch (failure) {
    respond(res, 200, rpcError(id, -32603, failure instanceof Error ? failure.message : 'Internal error'));
  }
  return true;
}
