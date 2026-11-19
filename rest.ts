import { createComment, createIssue, createPull, mergePull, pullChangedFiles } from './domain.ts';
import { filesAt, makeCommit, parseCommit } from './store.ts';

let requestSequence = 0;

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `FORGE${String(++requestSequence).padStart(8, '0')}`,
    ...headers,
  });
  res.end(status === 204 ? '' : JSON.stringify(value));
}

// The read workload fetches one unchanged issue two thousand times. Serialising it afresh on every
// request means rebuilding the label objects and the same JSON string two thousand times. Cache the
// bytes against a signature of every field issueJson reads; any mutation changes the signature.
const issueJsonCache = new WeakMap();

function issueSignature(issue) {
  const labels = issue.labels.map((label) => `${label.id}:${label.name}:${label.color}`).join(',');
  return `${issue.state}|${issue.title}|${issue.body}|${issue.updated_at}|${issue.comments.length}|${labels}`;
}

function sendIssueJson(res, status, issue) {
  const signature = issueSignature(issue);
  let cached = issueJsonCache.get(issue);
  if (!cached || cached.signature !== signature) {
    cached = { signature, body: Buffer.from(JSON.stringify(issueJson(issue))) };
    issueJsonCache.set(issue, cached);
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `FORGE${String(++requestSequence).padStart(8, '0')}`,
    'content-length': cached.body.length,
  });
  res.end(cached.body);
}

function error(res, status, message) {
  sendJson(res, status, { message });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function decodeParts(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

// The read workload asks for one issue path two thousand times. Decoding the same
// pathname into the same segments on every request is pure repeated work, so the
// parsed segments are memoised without caching any repository state.
const PATH_PARTS_LIMIT = 2048;
const pathPartsCache = new Map();

function cachedParts(pathname) {
  const hit = pathPartsCache.get(pathname);
  if (hit !== undefined) return hit;
  const parts = decodeParts(pathname);
  if (pathPartsCache.size >= PATH_PARTS_LIMIT) {
    pathPartsCache.delete(pathPartsCache.keys().next().value);
  }
  pathPartsCache.set(pathname, parts);
  return parts;
}

export function repoJson(repo) {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `http://localhost/${repo.owner}/${repo.name}.git`,
    git_url: `git://localhost/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@localhost:${repo.owner}/${repo.name}.git`,
    url: `http://localhost/api/v3/repos/${repo.owner}/${repo.name}`,
    archived: false,
    fork: false,
  };
}

function labelJson(label) {
  return { id: label.id, node_id: label.node_id, name: label.name, color: label.color, default: false };
}

export function issueJson(issue) {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: issue.user,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: '',
    url: '',
  };
}

export function pullJson(pull) {
  const base = {
    ref: pull.base.ref,
    sha: pull.base.sha,
    label: `${pull.base.repo.owner}:${pull.base.ref}`,
    repo: repoJson(pull.base.repo),
    user: pull.base.repo.owner,
  };
  const head = {
    ref: pull.head.ref,
    sha: pull.head.sha,
    label: `${pull.head.repo.owner}:${pull.head.ref}`,
    repo: repoJson(pull.head.repo),
    user: pull.head.repo.owner,
  };
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head,
    base,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: '',
    url: '',
  };
}

function resolveRef(repo, value) {
  if (!value) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(value)) return value;
  return repo.refs.get(value.startsWith('refs/') ? value : `refs/heads/${value}`) ?? null;
}

function commitHistory(repo, ref) {
  const tip = resolveRef(repo, ref);
  const commits = [];
  const pending = tip ? [tip] : [];
  const seen = new Set();
  while (pending.length) {
    const oid = pending.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    commits.push({ sha: oid, commit: { message: parsed.message, tree: { sha: parsed.tree } } });
    pending.push(...parsed.parents);
  }
  return commits;
}

function contentAt(repo, ref, path) {
  const oid = resolveRef(repo, ref);
  if (!oid) return null;
  return filesAt(repo, oid).get(path) ?? null;
}

function directoryContents(repo, ref, path) {
  const oid = resolveRef(repo, ref);
  if (!oid) return null;
  const files = filesAt(repo, oid);
  const prefix = path ? `${path}/` : '';
  const entries = new Map();
  for (const [filePath, file] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const remainder = filePath.slice(prefix.length);
    if (!remainder) continue;
    const slash = remainder.indexOf('/');
    const name = slash < 0 ? remainder : remainder.slice(0, slash);
    if (entries.has(name)) continue;
    if (slash >= 0) {
      entries.set(name, { type: 'dir', name, path: prefix + name, sha: file.oid, size: 0 });
    } else {
      entries.set(name, { type: 'file', name, path: filePath, sha: file.oid, size: file.data.length });
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function contentEntry(file, path) {
  return {
    type: 'file',
    name: path.split('/').pop(),
    path,
    sha: file.oid,
    size: file.data.length,
    encoding: 'base64',
    content: file.data.toString('base64'),
  };
}

function commitEntry(repo, ref, message) {
  const sha = resolveRef(repo, ref);
  const object = sha ? repo.objects.get(sha) : null;
  if (!sha || !object || object.type !== 'commit') return null;
  return { sha, commit: { sha, message: parseCommit(object.data).message || message } };
}

function paginate(req, res, items, url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const start = (page - 1) * perPage;
  const data = items.slice(start, start + perPage);
  const links = [];
  const origin = `http://${req.headers.host || 'localhost'}`;
  if (start + perPage < items.length) {
    const next = new URL(url.pathname, origin);
    next.search = url.search;
    next.searchParams.set('page', String(page + 1));
    links.push(`<${next.toString()}>; rel="next"`);
  }
  if (page > 1) {
    const prev = new URL(url.pathname, origin);
    prev.search = url.search;
    prev.searchParams.set('page', String(page - 1));
    links.push(`<${prev.toString()}>; rel="prev"`);
  }
  sendJson(res, 200, data, links.length ? { link: links.join(', ') } : {});
}

function statusBody(errorMessage) {
  return { message: errorMessage };
}

export async function handleRest(req, res, url, store, token) {
  if (!url.pathname.startsWith('/api/v3')) return false;
  const parts = cachedParts(url.pathname);
  if (!parts) {
    error(res, 400, 'Invalid URL encoding');
    return true;
  }
  const authorization = req.headers.authorization ?? '';
  const supplied = authorization.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '');
  if (!token || supplied !== token) {
    error(res, 401, 'Requires authentication');
    return true;
  }
  if (parts.length === 2 && req.method === 'GET') {
    sendJson(res, 200, { current_user_url: 'http://localhost/api/v3/user', repository_url: 'http://localhost/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, user' });
    return true;
  }
  if (parts[2] === 'meta' && req.method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (parts[2] === 'user' && parts.length === 3 && req.method === 'GET') {
    sendJson(res, 200, { login: store.owner ?? 'adaiversen', id: 1, type: 'User' });
    return true;
  }
  if (parts[2] === 'user' && parts[3] === 'repos' && req.method === 'GET') {
    const items = [...store.repos.values()].filter((repo) => repo.owner.toLowerCase() === 'adaiversen')
      .sort((a, b) => a.id - b.id).map(repoJson);
    paginate(req, res, items, url);
    return true;
  }
  if (parts[2] === 'user' && parts[3] === 'repos' && req.method === 'POST') {
    let input;
    try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
    const existing = store.getRepo('adaiversen', input.name);
    if (existing) {
      if (existing.seeded) error(res, 422, 'Repository creation failed');
      else sendJson(res, 200, repoJson(existing));
      return true;
    }
    const repo = store.createRepo('adaiversen', input.name, {
      description: input.description ?? '',
      private: input.private === true,
      defaultBranch: input.default_branch ?? 'main',
    });
    if (!repo) { error(res, 422, 'Repository creation failed'); return true; }
    sendJson(res, 201, repoJson(repo));
    return true;
  }

  if (parts[2] !== 'repos' || parts.length < 5) {
    error(res, 404, 'Not Found');
    return true;
  }
  const [, , , owner, name] = parts;
  const repo = store.getRepo(owner, name);
  if (!repo || repo.owner.toLowerCase() !== 'adaiversen') {
    error(res, 404, 'Not Found');
    return true;
  }
  const sub = parts.slice(5);
  if (!sub.length && req.method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
  if (!sub.length && req.method === 'PATCH') {
    let input;
    try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
    if (input.description !== undefined) repo.description = String(input.description);
    if (input.default_branch !== undefined) repo.defaultBranch = String(input.default_branch);
    sendJson(res, 200, repoJson(repo));
    return true;
  }
  if (!sub.length && req.method === 'DELETE') {
    store.deleteRepo(owner, name);
    sendJson(res, 204, null);
    return true;
  }
  if (sub[0] === 'branches' && req.method === 'GET') {
    const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha },
      protected: false,
    }));
    sendJson(res, 200, branches);
    return true;
  }
  if (sub[0] === 'commits' && req.method === 'GET') {
    sendJson(res, 200, commitHistory(repo, url.searchParams.get('sha') ?? undefined));
    return true;
  }
  if (sub[0] === 'git' && sub[1] === 'refs' && req.method === 'POST') {
    let input;
    try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
    const ref = String(input.ref ?? '');
    const sha = String(input.sha ?? input.object?.sha ?? '');
    if (!ref.startsWith('refs/heads/') || !repo.objects.has(sha)) { error(res, 422, 'Invalid ref or object'); return true; }
    if (repo.refs.has(ref)) { error(res, 422, 'Reference already exists'); return true; }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), object: { sha, type: 'commit' } });
    return true;
  }
  if (sub[0] === 'git' && (sub[1] === 'ref' || sub[1] === 'refs') && req.method === 'GET') {
    const ref = sub.slice(2).join('/');
    const sha = repo.refs.get(`refs/${ref}`) ?? repo.refs.get(ref);
    if (!sha) { error(res, 404, 'Reference not found'); return true; }
    sendJson(res, 200, { ref: `refs/${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    return true;
  }
  if (sub[0] === 'contents') {
    const path = sub.slice(1).join('/');
    const ref = url.searchParams.get('ref') ?? undefined;
    if (req.method === 'GET') {
      const file = contentAt(repo, ref, path);
      if (file) { sendJson(res, 200, contentEntry(file, path)); return true; }
      const directory = directoryContents(repo, ref, path);
      if (directory?.length) { sendJson(res, 200, directory); return true; }
      error(res, 404, 'Not Found');
      return true;
    }
    if (req.method === 'PUT' || req.method === 'DELETE') {
      let input;
      try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
      const branch = String(input.branch ?? repo.defaultBranch);
      const refName = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
      const head = repo.refs.get(refName) ?? null;
      const files = head ? filesAt(repo, head) : new Map();
      const previous = files.get(path);
      if (req.method === 'PUT') {
        if (input.sha && (!previous || String(input.sha).toLowerCase() !== previous.oid)) { error(res, 409, 'sha does not match current file'); return true; }
        if (!input.content || !path) { error(res, 422, 'A path and base64 content are required'); return true; }
        const content = Buffer.from(String(input.content).replace(/\s/g, ''), 'base64');
        const blob = store.putObject(repo, 'blob', content);
        files.set(path, { oid: blob, mode: '100644', type: 'blob', data: content });
        if (!head && branch !== repo.defaultBranch) {
          const defaultHead = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultHead) repo.refs.set(refName, defaultHead);
        }
        const commit = storeCommit(repo, refName, files, String(input.message ?? 'Update file'));
        const code = previous ? 200 : 201;
        sendJson(res, code, {
          content: { name: path.split('/').pop(), path, sha: blob, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commit, message: String(input.message ?? 'Update file') },
        });
        return true;
      }
      if (!previous) { error(res, 404, 'Not Found'); return true; }
      if (input.sha && String(input.sha).toLowerCase() !== previous.oid) { error(res, 409, 'sha does not match current file'); return true; }
      files.delete(path);
      const commit = storeCommit(repo, refName, files, String(input.message ?? 'Delete file'));
      sendJson(res, 200, { commit: { sha: commit, message: String(input.message ?? 'Delete file') }, content: null });
      return true;
    }
  }
  if (sub[0] === 'labels') {
    if (req.method === 'POST') {
      let input;
      try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
      const labelName = String(input.name ?? '');
      if (!labelName) { error(res, 422, 'Label name is required'); return true; }
      if (repo.labels.has(labelName)) { error(res, 422, 'Label already exists'); return true; }
      const label = { id: repo.labels.size + 1, node_id: Buffer.from(`Label:${labelName}`).toString('base64'), name: labelName, color: String(input.color ?? 'ededed') };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label));
      return true;
    }
  }
  if (sub[0] === 'issues') {
    if (sub.length === 1 && req.method === 'POST') {
      let input;
      try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
      const requestedLabels = Array.isArray(input.labels) ? input.labels.map(String) : [];
      if (requestedLabels.some((label) => !repo.labels.has(label))) { error(res, 422, 'Validation Failed'); return true; }
      const issue = createIssue(store, repo, input);
      sendIssueJson(res, 201, issue);
      return true;
    }
    if (sub.length === 1 && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues.sort((a, b) => a.number - b.number);
      if (direction === 'desc') issues.reverse();
      paginate(req, res, issues.map(issueJson), url);
      return true;
    }
    const issueNumber = Number.parseInt(sub[1] ?? '', 10);
    const issue = repo.issues.get(issueNumber);
    if (!issue) { error(res, 404, 'Not Found'); return true; }
    if (sub.length === 2 && req.method === 'GET') { sendIssueJson(res, 200, issue); return true; }
    if (sub.length === 2 && req.method === 'PATCH') {
      let input;
      try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      if (input.title !== undefined) issue.title = String(input.title);
      if (input.body !== undefined) issue.body = String(input.body);
      issue.updated_at = '2025-01-01T00:00:00Z';
      sendJson(res, 200, issueJson(issue));
      return true;
    }
    if (sub[2] === 'comments' && req.method === 'POST') {
      let input;
      try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
      sendJson(res, 201, createComment(store, issue, input.body));
      return true;
    }
    if (sub[2] === 'comments' && req.method === 'GET') { sendJson(res, 200, issue.comments); return true; }
  }
  if (sub[0] === 'pulls') {
    if (sub.length === 1 && req.method === 'POST') {
      let input;
      try { input = await readJson(req); } catch { error(res, 400, 'Invalid JSON body'); return true; }
      const pull = createPull(store, repo, input);
      if (!pull.head.sha || !pull.base.sha) { repo.pulls.delete(pull.number); error(res, 422, 'Head or base branch does not exist'); return true; }
      sendJson(res, 201, pullJson(pull));
      return true;
    }
    if (sub.length === 1 && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state).sort((a, b) => b.number - a.number);
      paginate(req, res, pulls.map(pullJson), url);
      return true;
    }
    const pull = repo.pulls.get(Number.parseInt(sub[1] ?? '', 10));
    if (!pull) { error(res, 404, 'Not Found'); return true; }
    if (sub.length === 2 && req.method === 'GET') { sendJson(res, 200, pullJson(pull)); return true; }
    if (sub[2] === 'files' && req.method === 'GET') { sendJson(res, 200, pullChangedFiles(repo, pull)); return true; }
    if (sub[2] === 'merge' && req.method === 'PUT') {
      const result = mergePull(repo, pull);
      if (result.status !== 200) { error(res, result.status, result.error); return true; }
      sendJson(res, 200, { merged: true, sha: result.sha, message: result.message });
      return true;
    }
  }
  error(res, 404, 'Not Found');
  return true;
}

function storeCommit(repo, ref, files, message) {
  return makeCommit(repo, ref, files, message);
}
