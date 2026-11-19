import { commonAncestor, filesAt, makeCommit } from './store.ts';

const FIXED_TIME = '2025-01-01T00:00:00Z';

export function globalId(kind, id) {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export function createIssue(store, repo, input) {
  const issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    labels: (Array.isArray(input.labels) ? input.labels : []).map((name) => repo.labels.get(String(name))).filter(Boolean),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    comments: [],
    user: { login: repo.owner },
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createComment(store, issue, body) {
  const comment = { id: store.nextCommentId++, body: String(body ?? ''), user: { login: issue.user.login }, created_at: FIXED_TIME };
  issue.comments.push(comment);
  return comment;
}

function branchName(value, defaultBranch) {
  const text = String(value ?? defaultBranch);
  const colon = text.indexOf(':');
  return colon < 0 ? text : text.slice(colon + 1);
}

function refOid(repo, value) {
  const branch = branchName(value, repo.defaultBranch);
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function createPull(store, repo, input) {
  const headRef = branchName(input.head, repo.defaultBranch);
  const baseRef = branchName(input.base, repo.defaultBranch);
  const headSha = refOid(repo, headRef);
  const baseSha = refOid(repo, baseRef);
  const pull = {
    id: store.nextPullId++,
    number: repo.nextPull++,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: headRef, sha: headSha, repo },
    base: { ref: baseRef, sha: baseSha, repo },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    user: { login: repo.owner },
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function pullChangedFiles(repo, pull) {
  if (!pull.head.sha || !pull.base.sha) return [];
  const baseFiles = filesAt(repo, pull.base.sha);
  const headFiles = filesAt(repo, pull.head.sha);
  const changed = [];
  for (const [path, file] of headFiles) {
    const before = baseFiles.get(path);
    if (before?.oid === file.oid) continue;
    const oldText = before ? before.data.toString('utf8') : '';
    const newText = file.data.toString('utf8');
    const additions = Math.max(1, newText.split('\n').filter(Boolean).length - oldText.split('\n').filter(Boolean).length + 1);
    const deletions = before ? Math.max(0, oldText.split('\n').filter(Boolean).length - newText.split('\n').filter(Boolean).length) : 0;
    changed.push({
      filename: path,
      status: before ? 'modified' : 'added',
      additions,
      deletions,
      changes: additions + deletions,
      sha: file.oid,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  for (const [path, file] of baseFiles) {
    if (!headFiles.has(path)) {
      changed.push({
        filename: path,
        status: 'removed',
        additions: 0,
        deletions: Math.max(1, file.data.toString('utf8').split('\n').filter(Boolean).length),
        changes: Math.max(1, file.data.toString('utf8').split('\n').filter(Boolean).length),
        sha: file.oid,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      });
    }
  }
  return changed;
}

export function mergePull(repo, pull) {
  if (!pull || pull.state !== 'open') return { status: 405, error: 'Pull request cannot be merged' };
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseHead = repo.refs.get(baseRef) ?? pull.base.sha;
  const headHead = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  if (!baseHead || !headHead) return { status: 405, error: 'Pull request has no commit history' };
  const mergeBase = commonAncestor(repo, baseHead, headHead);
  const ancestorFiles = mergeBase ? filesAt(repo, mergeBase) : new Map();
  const baseFiles = filesAt(repo, baseHead);
  const headFiles = filesAt(repo, headHead);
  for (const path of new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()])) {
    const ancestor = ancestorFiles.get(path)?.oid ?? null;
    const base = baseFiles.get(path)?.oid ?? null;
    const head = headFiles.get(path)?.oid ?? null;
    if (base !== ancestor && head !== ancestor && base !== head) {
      pull.mergeable = false;
      return { status: 405, error: 'Merge conflict' };
    }
  }
  const merged = new Map(baseFiles);
  for (const path of new Set([...ancestorFiles.keys(), ...headFiles.keys()])) {
    const ancestor = ancestorFiles.get(path)?.oid ?? null;
    const head = headFiles.get(path)?.oid ?? null;
    if (head === ancestor) continue;
    if (head === null) merged.delete(path);
    else merged.set(path, headFiles.get(path));
  }
  const mergeSha = makeCommit(repo, baseRef, merged, `Merge pull request #${pull.number}: ${pull.title}`, { parent: baseHead });
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = FIXED_TIME;
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = FIXED_TIME;
  pull.head.sha = headHead;
  pull.base.sha = mergeSha;
  return { status: 200, sha: mergeSha, message: 'Pull request successfully merged' };
}
