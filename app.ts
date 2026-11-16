import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  commitMessage, filesAtCommit, handleGitRequest, isAncestor,
  makeCommit, parseCommit, putObject, type GitRepo,
} from './git.ts';

type Issue = { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; comments: Array<{ id: number; body: string }> };
type Pull = {
  number: number; title: string; body: string; state: 'open' | 'closed'; merged: boolean;
  head: string; base: string; headSha: string; baseSha: string; mergeSha: string | null;
};
type Repository = GitRepo & {
  owner: string; name: string; private: boolean; description: string; issues: Issue[]; pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
};

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_DATE = '2026-01-01T00:00:00Z';
const LOGIN = 'adaiversen';
const requestIds = { value: 0 };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE${String(++requestIds.value).padStart(8, '0')}`,
    ...headers,
  });
  res.end(text);
}

function emptyRepo(owner: string, name: string, options: { private?: boolean; description?: string; default_branch?: string } = {}): Repository {
  return {
    owner, name, private: options.private ?? true, description: options.description ?? '',
    default_branch: options.default_branch || 'main', objects: new Map(), refs: new Map(),
    issues: [], pulls: [], labels: new Map(),
  };
}

function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: `${repo.owner}/${repo.name}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    private: repo.private, description: repo.description, default_branch: repo.default_branch,
    owner: { login: repo.owner }, html_url: `http://forge/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE, updated_at: FIXED_DATE, has_issues: true,
  };
}

function issueJson(repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ ...repo.labels.get(name), name })),
    user: { login: LOGIN }, assignee: null, milestone: null, comments: issue.comments.length,
    created_at: FIXED_DATE, updated_at: FIXED_DATE, closed_at: issue.state === 'closed' ? FIXED_DATE : null,
    html_url: `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repository, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    user: { login: LOGIN }, head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged, mergeable: true, mergeable_state: 'clean', merged_at: pull.merged ? FIXED_DATE : null,
    merge_commit_sha: pull.mergeSha, created_at: FIXED_DATE, updated_at: FIXED_DATE,
    html_url: `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > 2 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): Record<string, unknown> | null {
  if (!body.length) return {};
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function error(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function shaForPath(repo: Repository, commit: string | null, filePath: string): string | undefined {
  if (!commit) return undefined;
  return filesAtCommit(repo, commit).get(filePath)?.sha;
}

function fileJson(repo: Repository, sha: string, path: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'blob') return null;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file', name, path, sha, size: object.data.length, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `http://forge/${repo.owner}/${repo.name}/blob/${repo.default_branch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    download_url: null, encoding: 'base64', content: object.data.toString('base64').replace(/(.{76})/g, '$1\n'),
  };
}

function contentAt(repo: Repository, commit: string | null, path: string): unknown {
  if (!commit) return null;
  const files = filesAtCommit(repo, commit);
  const entry = files.get(path);
  if (entry) return fileJson(repo, entry.sha, path);
  const prefix = path ? `${path}/` : '';
  const children = new Map<string, Record<string, unknown>>();
  for (const [filePath, file] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const remainder = filePath.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash < 0) {
      const result = fileJson(repo, file.sha, filePath);
      if (result) children.set(remainder, result);
    } else {
      const name = remainder.slice(0, slash);
      children.set(name, { type: 'dir', name, path: prefix + name });
    }
  }
  return children.size ? [...children.values()] : null;
}

function changedFiles(repo: Repository, pull: Pull): Array<Record<string, unknown>> {
  const base = filesAtCommit(repo, pull.baseSha);
  const head = filesAtCommit(repo, pull.headSha);
  const result: Array<Record<string, unknown>> = [];
  for (const [path, file] of head) {
    const old = base.get(path);
    if (old?.sha === file.sha) continue;
    const text = repo.objects.get(file.sha)?.data.toString('utf8') ?? '';
    const oldText = old ? repo.objects.get(old.sha)?.data.toString('utf8') ?? '' : '';
    const additions = text.split('\n').filter(Boolean).length;
    const deletions = oldText.split('\n').filter(Boolean).length;
    result.push({
      sha: file.sha, filename: path, status: old ? 'modified' : 'added',
      additions, deletions, changes: additions + deletions,
      blob_url: `http://forge/${repo.owner}/${repo.name}/blob/${pull.head}/${path}`,
      raw_url: `http://forge/${repo.owner}/${repo.name}/raw/${pull.head}/${path}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${pull.head}`,
    });
  }
  for (const [path, file] of base) {
    if (head.has(path)) continue;
    result.push({ sha: file.sha, filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
  }
  return result;
}

function paginationLink(url: URL, page: number, perPage: number, total: number): string | undefined {
  const links: string[] = [];
  if (page > 1) {
    const prev = new URL(url);
    prev.searchParams.set('page', String(page - 1));
    links.push(`<${prev.href}>; rel="prev"`);
  }
  if (page * perPage < total) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    links.push(`<${next.href}>; rel="next"`);
  }
  return links.length ? links.join(', ') : undefined;
}

const MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a repository for the authenticated viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read a repository owned by the authenticated viewer.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request between repository branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function jsonRpc(res: ServerResponse, id: unknown, result: unknown, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, result });
}

function jsonRpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function handleMcp(req: IncomingMessage, res: ServerResponse, repos: Map<string, Repository>, body: Buffer | null): boolean {
  if (!req.url?.startsWith('/mcp')) return false;
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    error(res, 401, 'Requires authentication');
    return true;
  }
  if (!body) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid request');
    request = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = request.id;
  const method = String(request.method ?? '');
  const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'x-github-request-id': `FORGE${String(++requestIds.value).padStart(8, '0')}` }); res.end(); return true;
  }
  if (method === 'server/discover') {
    jsonRpc(res, id, {
      resultType: 'discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} }, serverInfo: { name: 'github-compatible-forge', version: '1.0.0' },
    });
    return true;
  }
  if (method === 'initialize') {
    jsonRpc(res, id, {
      protocolVersion: String(params.protocolVersion ?? '2025-11-25'),
      capabilities: { tools: {} }, serverInfo: { name: 'github-compatible-forge', version: '1.0.0' },
    });
    return true;
  }
  if (method === 'ping') { jsonRpc(res, id, {}); return true; }
  if (method === 'tools/list') { jsonRpc(res, id, { tools: MCP_TOOLS }); return true; }
  if (method !== 'tools/call') { jsonRpcError(res, id, -32601, 'Method not found'); return true; }
  const toolName = String(params.name ?? '').toLowerCase().replace(/^.*(?:__|:)/, '');
  const owner = String(args.owner ?? LOGIN);
  const name = String(args.repo ?? args.name ?? '');
  const repo = repos.get(`${owner}/${name}`);
  const missing = (keys: string[]) => keys.some((key) => args[key] === undefined || args[key] === '');
  let value: unknown;
  if (toolName === 'create_repo') {
    if (missing(['name'])) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'name is required' }] }); return true; }
    const repoName = String(args.name);
    const key = `${LOGIN}/${repoName}`;
    if (repos.has(key)) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Repository already exists' }] }); return true; }
    const created = emptyRepo(LOGIN, repoName, { private: typeof args.private === 'boolean' ? args.private : true, description: String(args.description ?? '') });
    repos.set(key, created); value = repoJson(created);
  } else if (toolName === 'get_repo') {
    if (missing(['owner', 'repo'])) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'owner and repo are required' }] }); return true; }
    if (!repo || owner !== LOGIN) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Not Found' }] }); return true; }
    value = repoJson(repo);
  } else if (toolName === 'create_issue') {
    if (missing(['owner', 'repo', 'title'])) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'owner, repo and title are required' }] }); return true; }
    if (!repo || owner !== LOGIN) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Not Found' }] }); return true; }
    const issue: Issue = { number: repo.issues.length + 1, title: String(args.title), body: String(args.body ?? ''), state: 'open', labels: [], comments: [] };
    repo.issues.push(issue); value = issueJson(repo, issue);
  } else if (toolName === 'list_issues') {
    if (missing(['owner', 'repo'])) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'owner and repo are required' }] }); return true; }
    if (!repo || owner !== LOGIN) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Not Found' }] }); return true; }
    value = repo.issues.filter((issue) => !args.state || args.state === 'all' || issue.state === args.state).map((issue) => issueJson(repo, issue));
  } else if (toolName === 'create_pull_request') {
    if (missing(['owner', 'repo', 'title', 'head', 'base'])) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'owner, repo, title, head and base are required' }] }); return true; }
    if (!repo || owner !== LOGIN) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Not Found' }] }); return true; }
    const head = String(args.head).split(':').pop()!;
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Head or base branch not found' }] }); return true; }
    const pull: Pull = { number: repo.pulls.length + 1, title: String(args.title), body: '', state: 'open', merged: false, head, base, headSha, baseSha, mergeSha: null };
    repo.pulls.push(pull); value = pullJson(repo, pull);
  } else if (toolName === 'merge_pull_request') {
    if (missing(['owner', 'repo', 'pull_number'])) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'owner, repo and pull_number are required' }] }); return true; }
    if (!repo || owner !== LOGIN) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Not Found' }] }); return true; }
    const pull = repo.pulls.find((item) => item.number === Number(args.pull_number));
    if (!pull) { jsonRpc(res, id, { isError: true, content: [{ type: 'text', text: 'Not Found' }] }); return true; }
    if (!pull.merged) {
      const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
      const baseFiles = filesAtCommit(repo, baseSha);
      for (const [filePath, entry] of filesAtCommit(repo, pull.headSha)) baseFiles.set(filePath, entry);
      const mergeSha = makeCommit(repo, baseSha, `Squash merge pull request #${pull.number}`, baseFiles);
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      pull.merged = true; pull.state = 'closed'; pull.mergeSha = mergeSha;
    }
    value = pullJson(repo, pull);
  } else {
    jsonRpcError(res, id, -32601, 'Unknown tool'); return true;
  }
  const text = JSON.stringify(value);
  jsonRpc(res, id, { content: [{ type: 'text', text }], structuredContent: value });
  return true;
}

function gqlId(kind: string, owner: string, name: string, number?: number): string {
  return Buffer.from(`${kind}:${owner}/${name}${number === undefined ? '' : `/${number}`}`).toString('base64');
}

function decodeGqlId(id: unknown): string[] {
  if (typeof id !== 'string') return [];
  try { return Buffer.from(id, 'base64').toString('utf8').split(':').pop()!.split('/'); }
  catch { return []; }
}

function executeGraphql(request: { query?: string; variables?: Record<string, unknown> }, repos: Map<string, Repository>): unknown {
  const query = String(request.query ?? '');
  const variables = request.variables ?? {};
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string; path?: string[] }> = [];
  const repository = (): Repository | undefined => {
    let owner = String(variables.owner ?? '');
    let name = String(variables.name ?? '');
    if (!owner || !name) {
      const literal = /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"/.exec(query);
      owner ||= literal?.[1] ?? '';
      name ||= literal?.[2] ?? '';
    }
    return repos.get(`${owner}/${name}`);
  };
  const gqlIssue = (repo: Repository, issue: Issue) => ({
    id: gqlId('Issue', repo.owner, repo.name, issue.number), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state.toUpperCase(),
  });
  const gqlPull = (repo: Repository, pull: Pull) => ({
    id: gqlId('PullRequest', repo.owner, repo.name, pull.number), number: pull.number,
    title: pull.title, body: pull.body, state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged, headRefName: pull.head, baseRefName: pull.base,
    mergeable: 'MERGEABLE',
    files: { nodes: changedFiles(repo, pull).map((file) => ({ path: file.filename })) },
  });
  const typeFields: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'updatedAt', 'url'],
    PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
    User: ['id', 'login', 'name', 'email'],
  };
  for (const match of query.matchAll(/(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)) {
    const typeName = match[2]!;
    data[match[1]!] = typeName === 'SearchType'
      ? { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'WIKI'].map((name) => ({ name })) }
      : { fields: (typeFields[typeName] ?? []).map((name) => ({ name })) };
  }
  if (/__type\s*\(\s*name\s*:/.test(query) && !Object.keys(data).length) {
    const typeName = /__type\s*\(\s*name\s*:\s*"([^"]+)"/.exec(query)?.[1] ?? '';
    data.__type = { fields: (typeFields[typeName] ?? []).map((name) => ({ name })) };
  }
  if (/\bviewer\s*\{/.test(query)) data.viewer = { login: LOGIN };
  const repo = repository();
  if (/\brepository\s*\(/.test(query)) {
    if (!repo) data.repository = null;
    else {
      const object: Record<string, unknown> = {
        id: gqlId('Repository', repo.owner, repo.name), databaseId: 1, name: repo.name,
        nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner },
        defaultBranchRef: { name: repo.default_branch }, viewerPermission: 'ADMIN', hasIssuesEnabled: true,
      };
      const issueNumber = Number(variables.number ?? /issue\s*\(\s*number\s*:\s*(\d+)/.exec(query)?.[1]);
      if (/\bissue\s*\(/.test(query)) {
        const issue = repo.issues.find((item) => item.number === issueNumber);
        object.issue = issue ? gqlIssue(repo, issue) : null;
      }
      if (/\bissues\s*\(/.test(query)) {
        const stateMatch = /states\s*:\s*\[\s*(OPEN|CLOSED)/.exec(query)?.[1]?.toLowerCase();
        let issues = repo.issues.filter((issue) => !stateMatch || issue.state === stateMatch);
        if (/direction\s*:\s*DESC/.test(query)) issues = [...issues].reverse();
        const first = Number(variables.first ?? 100);
        const offset = Number(String(variables.after ?? '').replace('cursor:', '')) || 0;
        const selected = issues.slice(offset, offset + first);
        object.issues = {
          nodes: selected.map((issue) => gqlIssue(repo, issue)),
          pageInfo: { hasNextPage: offset + selected.length < issues.length, endCursor: selected.length ? `cursor:${offset + selected.length}` : null },
        };
      }
      if (/\bpullRequests\s*\(/.test(query)) object.pullRequests = { nodes: repo.pulls.map((pull) => gqlPull(repo, pull)) };
      if (/\bpullRequest\s*\(/.test(query)) {
        const pull = repo.pulls.find((item) => item.number === issueNumber);
        object.pullRequest = pull ? gqlPull(repo, pull) : null;
      }
      data.repository = object;
    }
  }
  if (/\bnode\s*\(/.test(query)) {
    const id = variables.id;
    const parts = decodeGqlId(id);
    const nodeRepo = parts.length >= 2 ? repos.get(`${parts[0]}/${parts[1]}`) : undefined;
    data.node = nodeRepo ? {
      id: gqlId('Repository', nodeRepo.owner, nodeRepo.name),
      name: nodeRepo.name, nameWithOwner: `${nodeRepo.owner}/${nodeRepo.name}`,
    } : null;
  }
  const input = (variables.input && typeof variables.input === 'object' ? variables.input : {}) as Record<string, unknown>;
  const inputParts = decodeGqlId(input.repositoryId);
  const inputRepo = inputParts.length >= 2 ? repos.get(`${inputParts[0]}/${inputParts[1]}`) : repo;
  if (/createIssue\s*\(/.test(query)) {
    if (!inputRepo) { data.createIssue = null; }
    else {
      const issue: Issue = { number: inputRepo.issues.length + 1, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], comments: [] };
      inputRepo.issues.push(issue); data.createIssue = { issue: gqlIssue(inputRepo, issue) };
    }
  }
  if (/closeIssue\s*\(/.test(query)) {
    const parts = decodeGqlId(input.issueId);
    const target = parts.length >= 3 ? repos.get(`${parts[0]}/${parts[1]}`) : undefined;
    const issue = target?.issues.find((item) => item.number === Number(parts[2]));
    if (issue) issue.state = 'closed';
    data.closeIssue = { issue: target && issue ? gqlIssue(target, issue) : null };
  }
  if (/createPullRequest\s*\(/.test(query)) {
    const head = String(input.headRefName ?? '').split(':').pop()!;
    const base = String(input.baseRefName ?? '');
    const headSha = inputRepo?.refs.get(`refs/heads/${head}`);
    const baseSha = inputRepo?.refs.get(`refs/heads/${base}`);
    if (inputRepo && headSha && baseSha) {
      const pull: Pull = { number: inputRepo.pulls.length + 1, title: String(input.title ?? ''), body: '', state: 'open', merged: false, head, base, headSha, baseSha, mergeSha: null };
      inputRepo.pulls.push(pull); data.createPullRequest = { pullRequest: gqlPull(inputRepo, pull) };
    } else data.createPullRequest = { pullRequest: null };
  }
  if (/mergePullRequest\s*\(/.test(query)) {
    const parts = decodeGqlId(input.pullRequestId);
    const target = parts.length >= 3 ? repos.get(`${parts[0]}/${parts[1]}`) : undefined;
    const pull = target?.pulls.find((item) => item.number === Number(parts[2]));
    if (target && pull && !pull.merged) {
      const base = target.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
      const mergedFiles = filesAtCommit(target, base);
      for (const [filePath, entry] of filesAtCommit(target, pull.headSha)) mergedFiles.set(filePath, entry);
      const sha = makeCommit(target, base, `Squash merge pull request #${pull.number}`, mergedFiles);
      target.refs.set(`refs/heads/${pull.base}`, sha);
      pull.merged = true; pull.state = 'closed'; pull.mergeSha = sha;
    }
    data.mergePullRequest = { pullRequest: target && pull ? gqlPull(target, pull) : null };
  }
  if (/addComment\s*\(/.test(query)) {
    const parts = decodeGqlId(input.subjectId);
    const target = parts.length >= 3 ? repos.get(`${parts[0]}/${parts[1]}`) : undefined;
    const issue = target?.issues.find((item) => item.number === Number(parts[2]));
    const comment = issue ? { id: issue.comments.length + 1, body: String(input.body ?? '') } : null;
    if (issue && comment) issue.comments.push(comment);
    data.addComment = { commentEdge: { node: comment ? { id: gqlId('Comment', target!.owner, target!.name, comment.id), body: comment.body } : null } };
  }
  if (/noSuchFieldOnViewer/.test(query)) errors.push({ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".', path: ['viewer', 'noSuchFieldOnViewer'] });
  return errors.length ? { data, errors } : { data };
}

function makeRouteHandler(repos: Map<string, Repository>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    if (path === '/mcp') {
      let raw: Buffer;
      try { raw = await readBody(req); } catch { raw = Buffer.alloc(0); }
      if (handleMcp(req, res, repos, raw)) return;
    }
    if (path === '/api/graphql' && req.method === 'POST') {
      let raw: Buffer;
      try { raw = await readBody(req); } catch { error(res, 400, 'Invalid JSON body'); return; }
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (!token || req.headers.authorization !== `Bearer ${token}`) { error(res, 401, 'Requires authentication'); return; }
      try {
        const request: unknown = JSON.parse(raw.toString('utf8'));
        if (Array.isArray(request)) {
          sendJson(res, 200, request.map((item) => executeGraphql(item as { query?: string; variables?: Record<string, unknown> }, repos)));
        } else {
          sendJson(res, 200, executeGraphql(request as { query?: string; variables?: Record<string, unknown> }, repos));
        }
      } catch {
        error(res, 400, 'Invalid JSON body');
      }
      return;
    }
    if (path.startsWith('/api/v3')) {
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (!token || req.headers.authorization !== `Bearer ${token}`) { error(res, 401, 'Requires authentication'); return; }
      if (path === '/api/v3' || path === '/api/v3/') {
        if (req.method === 'GET') sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
        else error(res, 405, 'Method Not Allowed');
        return;
      }
      if (req.method === 'GET' && path === '/api/v3/user') {
        sendJson(res, 200, { login: LOGIN, id: 1, type: 'User', name: LOGIN }); return;
      }
      if (req.method === 'GET' && path === '/api/v3/meta') {
        sendJson(res, 200, { installed_version: '1.0.0' }); return;
      }
      let body: Record<string, unknown> | null = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
        try { body = parseJson(await readBody(req)); }
        catch { error(res, 400, 'Invalid JSON body'); return; }
        if (body === null) { error(res, 400, 'Invalid JSON body'); return; }
      }
      const root = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
      if (req.method === 'GET' && path === '/api/v3/user/repos' || req.method === 'POST' && path === '/api/v3/user/repos') {
        if (req.method === 'POST') {
          const name = String(body?.name ?? '');
          if (!name || name.includes('/')) { error(res, 422, 'Invalid repository name'); return; }
          const key = `${LOGIN}/${name}`;
          if (repos.has(key)) { error(res, 422, 'Repository already exists'); return; }
          const repo = emptyRepo(LOGIN, name, body ?? {});
          repos.set(key, repo);
          sendJson(res, 201, repoJson(repo)); return;
        }
        const all = [...repos.values()].filter((repo) => repo.owner === LOGIN);
        const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
        const items = all.slice((page - 1) * perPage, page * perPage).map(repoJson);
        const link = paginationLink(url, page, perPage, all.length);
        sendJson(res, 200, items, link ? { link } : {}); return;
      }
      if (root) {
        const owner = decodePath(root[1]!);
        const name = decodePath(root[2]!);
        const rest = root[3] ?? '';
        const repo = repos.get(`${owner}/${name}`);
        if (!repo || owner !== LOGIN) { error(res, 404, 'Not Found'); return; }
        if (!rest) {
          if (req.method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
          if (req.method === 'PATCH') {
            if (typeof body?.description === 'string') repo.description = body.description;
            if (typeof body?.private === 'boolean') repo.private = body.private;
            sendJson(res, 200, repoJson(repo)); return;
          }
          if (req.method === 'DELETE') {
            repos.delete(`${owner}/${name}`);
            res.writeHead(204, { 'x-github-request-id': `FORGE${String(++requestIds.value).padStart(8, '0')}` }); res.end(); return;
          }
        }
        if (req.method === 'GET' && rest === 'branches') {
          sendJson(res, 200, [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({
            name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
            protected: false,
          }))); return;
        }
        const branchRef = rest.match(/^git\/refs\/heads\/(.+)$/);
        if (req.method === 'GET' && branchRef) {
          const ref = `refs/heads/${decodePath(branchRef[1]!)}`;
          const sha = repo.refs.get(ref);
          if (!sha) { error(res, 404, 'Not Found'); return; }
          sendJson(res, 200, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } }); return;
        }
        if (req.method === 'POST' && rest === 'git/refs') {
          const ref = String(body?.ref ?? ''), sha = String(body?.sha ?? '');
          if (!ref.startsWith('refs/heads/') || !repo.objects.has(sha)) { error(res, 422, 'Invalid ref or object'); return; }
          if (repo.refs.has(ref)) { error(res, 422, 'Reference already exists'); return; }
          repo.refs.set(ref, sha);
          sendJson(res, 201, { ref, node_id: ref, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } }); return;
        }
        if (req.method === 'GET' && rest === 'commits') {
          const ref = url.searchParams.get('sha') ?? `refs/heads/${repo.default_branch}`;
          const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
          const commits: Array<Record<string, unknown>> = [];
          let cursor = tip;
          while (cursor) {
            const parsed = parseCommit(repo, cursor);
            if (!parsed) break;
            commits.push({
              sha: cursor, commit: { message: commitMessage(repo, cursor), author: { name: 'GitHub Forge', date: FIXED_DATE }, committer: { name: 'GitHub Forge', date: FIXED_DATE } },
              parents: parsed.parents.map((sha) => ({ sha })),
            });
            cursor = parsed.parents[0];
          }
          sendJson(res, 200, commits); return;
        }
        const contentMatch = rest.match(/^contents\/(.+)$/);
        if (contentMatch) {
          const filePath = decodePath(contentMatch[1]!);
          const branch = url.searchParams.get('branch') ?? (typeof body?.branch === 'string' ? body.branch : null);
          const ref = url.searchParams.get('ref') ?? branch ?? repo.default_branch;
          const commit = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? null;
          const existingSha = shaForPath(repo, commit, filePath);
          if (req.method === 'GET') {
            const content = contentAt(repo, commit, filePath);
            if (content === null) { error(res, 404, 'Not Found'); return; }
            sendJson(res, 200, content); return;
          }
          if (req.method === 'PUT') {
            if (existingSha && body?.sha !== existingSha) { error(res, 409, 'sha does not match'); return; }
            if (!existingSha && body?.sha) { error(res, 409, 'sha does not match'); return; }
            const message = String(body?.message ?? 'Update file');
            const encoded = String(body?.content ?? '').replace(/\s/g, '');
            let data: Buffer;
            try { data = Buffer.from(encoded, 'base64'); }
            catch { error(res, 400, 'Invalid base64 content'); return; }
            const blobSha = putObject(repo, 'blob', data);
            const files = commit ? filesAtCommit(repo, commit) : new Map<string, { mode: string; sha: string }>();
            files.set(filePath, { mode: '100644', sha: blobSha });
            const newSha = makeCommit(repo, commit, message, files);
            const branchName = branch ?? repo.default_branch;
            repo.refs.set(`refs/heads/${branchName}`, newSha);
            if (!branch && !repo.refs.has(`refs/heads/${repo.default_branch}`)) repo.refs.set(`refs/heads/${repo.default_branch}`, newSha);
            sendJson(res, existingSha ? 200 : 201, {
              content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
              commit: { sha: newSha, message, tree: { sha: parseCommit(repo, newSha)?.tree }, parents: commit ? [{ sha: commit }] : [] },
            }); return;
          }
          if (req.method === 'DELETE') {
            if (!existingSha) { error(res, 404, 'Not Found'); return; }
            if (body?.sha !== existingSha) { error(res, 409, 'sha does not match'); return; }
            const files = filesAtCommit(repo, commit!);
            files.delete(filePath);
            const newSha = makeCommit(repo, commit, String(body?.message ?? 'Delete file'), files);
            repo.refs.set(`refs/heads/${branch ?? repo.default_branch}`, newSha);
            sendJson(res, 200, { commit: { sha: newSha, message: String(body?.message ?? 'Delete file') }, content: null }); return;
          }
        }
        if (req.method === 'POST' && rest === 'labels') {
          const label = String(body?.name ?? '');
          if (!label) { error(res, 422, 'Label name required'); return; }
          const value = { name: label, color: String(body?.color ?? 'ededed') };
          repo.labels.set(label, value); sendJson(res, 201, value); return;
        }
        if (rest === 'issues' && req.method === 'POST') {
          const labels = Array.isArray(body?.labels) ? body.labels.map(String) : [];
          if (labels.some((label) => !repo.labels.has(label))) { error(res, 422, 'Validation Failed: label does not exist'); return; }
          const issue: Issue = { number: repo.issues.length + 1, title: String(body?.title ?? ''), body: String(body?.body ?? ''), state: 'open', labels, comments: [] };
          repo.issues.push(issue); sendJson(res, 201, issueJson(repo, issue)); return;
        }
        if (rest === 'issues' && req.method === 'GET') {
          let issues = [...repo.issues];
          const state = url.searchParams.get('state');
          if (state && state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (url.searchParams.get('sort') === 'created' && url.searchParams.get('direction') === 'desc') issues.reverse();
          sendJson(res, 200, issues.map((issue) => issueJson(repo, issue))); return;
        }
        const issueRoute = rest.match(/^issues\/(\d+)(?:\/(comments))?$/);
        if (issueRoute) {
          const issue = repo.issues.find((item) => item.number === Number(issueRoute[1]));
          if (!issue) { error(res, 404, 'Not Found'); return; }
          if (issueRoute[2] === 'comments') {
            if (req.method === 'GET') { sendJson(res, 200, issue.comments.map((comment) => ({ ...comment, user: { login: LOGIN }, created_at: FIXED_DATE }))); return; }
            if (req.method === 'POST') {
              const comment = { id: issue.comments.length + 1, body: String(body?.body ?? '') };
              issue.comments.push(comment); sendJson(res, 201, { ...comment, user: { login: LOGIN }, created_at: FIXED_DATE }); return;
            }
          }
          if (req.method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
          if (req.method === 'PATCH') {
            if (body?.state === 'closed' || body?.state === 'open') issue.state = body.state;
            if (typeof body?.title === 'string') issue.title = body.title;
            if (typeof body?.body === 'string') issue.body = body.body;
            sendJson(res, 200, issueJson(repo, issue)); return;
          }
        }
        if (rest === 'pulls' && req.method === 'POST') {
          const head = String(body?.head ?? '').split(':').pop()!;
          const base = String(body?.base ?? repo.default_branch);
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) { error(res, 422, 'Head or base branch not found'); return; }
          const pull: Pull = {
            number: repo.pulls.length + 1, title: String(body?.title ?? ''), body: String(body?.body ?? ''),
            state: 'open', merged: false, head, base, headSha, baseSha, mergeSha: null,
          };
          repo.pulls.push(pull); sendJson(res, 201, pullJson(repo, pull)); return;
        }
        if (rest === 'pulls' && req.method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          sendJson(res, 200, repo.pulls.filter((pull) => state === 'all' || pull.state === state).map((pull) => pullJson(repo, pull))); return;
        }
        const pullRoute = rest.match(/^pulls\/(\d+)(?:\/(files|merge))?$/);
        if (pullRoute) {
          const pull = repo.pulls.find((item) => item.number === Number(pullRoute[1]));
          if (!pull) { error(res, 404, 'Not Found'); return; }
          if (pullRoute[2] === 'files' && req.method === 'GET') { sendJson(res, 200, changedFiles(repo, pull)); return; }
          if (pullRoute[2] === 'merge' && req.method === 'PUT') {
            const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
            const baseFiles = filesAtCommit(repo, baseSha);
            const headFiles = filesAtCommit(repo, pull.headSha);
            const originalBaseFiles = filesAtCommit(repo, pull.baseSha);
            const conflicting = [...headFiles].some(([filePath, entry]) => {
              const original = originalBaseFiles.get(filePath);
              const current = baseFiles.get(filePath);
              return original?.sha !== current?.sha && current?.sha !== entry.sha;
            });
            if (conflicting || !isAncestor(repo, pull.baseSha, pull.headSha)) { error(res, 405, 'Pull request cannot be merged'); return; }
            const mergedFiles = new Map(baseFiles);
            for (const [filePath, entry] of headFiles) {
              if (originalBaseFiles.get(filePath)?.sha !== entry.sha) mergedFiles.set(filePath, entry);
            }
            const mergeSha = makeCommit(repo, baseSha, `Squash merge pull request #${pull.number}`, mergedFiles);
            repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
            pull.merged = true; pull.state = 'closed'; pull.mergeSha = mergeSha;
            sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }); return;
          }
          if (req.method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
        }
        error(res, 404, 'Not Found'); return;
      }
      error(res, 404, 'Not Found'); return;
    }
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\//);
    if (gitMatch) {
      const auth = process.env.MAKEFUN_SHOP_TOKEN;
      if (!auth || req.headers.authorization !== `Bearer ${auth}`) { error(res, 401, 'Requires authentication'); return; }
      const repo = repos.get(`${decodePath(gitMatch[1]!)}/${decodePath(gitMatch[2]!)}`) ?? null;
      const body = await readBody(req);
      handleGitRequest(req, res, repo, path, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  };
}

export function createApp(): Server {
  const repos = new Map<string, Repository>();
  const handler = makeRouteHandler(repos);
  return createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.destroy();
    });
  });
}
