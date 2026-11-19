import { commonAncestor, filesAt, makeCommit } from './store.ts';

// Git objects and REST payloads need stable timestamps; deriving them from the
// clock would make two replays of the same trial diverge byte for byte.
const FIXED_TIME = '2025-01-01T00:00:00Z';
const ISSUE_PREFIX = 'Issue:';

function asText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function nonBlankLineCount(text) {
  const lines = asText(text).split('\n');
  let count = 0;
  for (const line of lines) {
    if (line.length > 0) count += 1;
  }
  return count;
}

function labelObjects(repo, labels) {
  if (!Array.isArray(labels)) return [];
  const result = [];
  for (const name of labels) {
    const label = repo.labels.get(asText(name));
    if (label) result.push(label);
  }
  return result;
}

function ownerOf(repo) {
  return { login: repo.owner };
}

function emptyUrls() {
  return { blob_url: '', raw_url: '', contents_url: '' };
}

export function globalId(kind, id) {
  const raw = `${kind}:${id}`;
  return Buffer.from(raw).toString('base64');
}

function issueRecord(store, repo, input) {
  return {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title: asText(input.title),
    body: asText(input.body),
    state: 'open',
    labels: labelObjects(repo, input.labels),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    comments: [],
    user: ownerOf(repo),
  };
}

export function createIssue(store, repo, input) {
  const issue = issueRecord(store, repo, input);
  repo.issues.set(issue.number, issue);
  return issue;
}

function commentRecord(store, issue, body) {
  return {
    id: store.nextCommentId++,
    body: asText(body),
    user: { login: issue.user.login },
    created_at: FIXED_TIME,
  };
}

export function createComment(store, issue, body) {
  const comment = commentRecord(store, issue, body);
  issue.comments.push(comment);
  return comment;
}

function branchName(value, defaultBranch) {
  const text = asText(value) || defaultBranch;
  const colon = text.indexOf(':');
  if (colon < 0) return text;
  return text.slice(colon + 1);
}

function refOid(repo, value) {
  const branch = branchName(value, repo.defaultBranch);
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function pullRecord(store, repo, input, headRef, baseRef, headSha, baseSha) {
  return {
    id: store.nextPullId++,
    number: repo.nextPull++,
    title: asText(input.title),
    body: asText(input.body),
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: headRef, sha: headSha, repo },
    base: { ref: baseRef, sha: baseSha, repo },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    user: ownerOf(repo),
  };
}

export function createPull(store, repo, input) {
  const headRef = branchName(input.head, repo.defaultBranch);
  const baseRef = branchName(input.base, repo.defaultBranch);
  const headSha = refOid(repo, headRef);
  const baseSha = refOid(repo, baseRef);
  const pull = pullRecord(store, repo, input, headRef, baseRef, headSha, baseSha);
  repo.pulls.set(pull.number, pull);
  return pull;
}

function removedChange(path, before) {
  const oldText = before.data.toString('utf8');
  const deletions = Math.max(1, nonBlankLineCount(oldText));
  return {
    filename: path,
    status: 'removed',
    additions: 0,
    deletions,
    changes: deletions,
    sha: before.oid,
    ...emptyUrls(),
  };
}

function presentChange(path, status, before, after) {
  const oldText = before ? before.data.toString('utf8') : '';
  const newText = after.data.toString('utf8');
  const oldLines = nonBlankLineCount(oldText);
  const newLines = nonBlankLineCount(newText);
  const additions = Math.max(1, newLines - oldLines + 1);
  const deletions = before ? Math.max(0, oldLines - newLines) : 0;
  return {
    filename: path,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    sha: after.oid,
    ...emptyUrls(),
  };
}

function changeEntry(path, status, before, after) {
  if (status === 'removed') return removedChange(path, before);
  return presentChange(path, status, before, after);
}

export function pullChangedFiles(repo, pull) {
  if (!pull.head.sha || !pull.base.sha) return [];
  const baseFiles = filesAt(repo, pull.base.sha);
  const headFiles = filesAt(repo, pull.head.sha);
  const changed = [];

  for (const [path, headFile] of headFiles) {
    const baseFile = baseFiles.get(path);
    if (baseFile?.oid === headFile.oid) continue;
    const status = baseFile ? 'modified' : 'added';
    changed.push(changeEntry(path, status, baseFile, headFile));
  }

  for (const [path, baseFile] of baseFiles) {
    if (headFiles.has(path)) continue;
    changed.push(changeEntry(path, 'removed', baseFile, null));
  }
  return changed;
}

function oidOf(files, path) {
  return files.get(path)?.oid ?? null;
}

function conflictAt(path, ancestorFiles, baseFiles, headFiles) {
  const ancestor = oidOf(ancestorFiles, path);
  const base = oidOf(baseFiles, path);
  const head = oidOf(headFiles, path);
  return base !== ancestor && head !== ancestor && base !== head;
}

function hasConflicts(allPaths, ancestorFiles, baseFiles, headFiles) {
  for (const path of allPaths) {
    if (conflictAt(path, ancestorFiles, baseFiles, headFiles)) return true;
  }
  return false;
}

function mergedFileSet(ancestorFiles, baseFiles, headFiles) {
  const merged = new Map(baseFiles);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = oidOf(ancestorFiles, path);
    const head = oidOf(headFiles, path);
    if (head === ancestor) continue;
    if (head === null) merged.delete(path);
    else merged.set(path, headFiles.get(path));
  }
  return merged;
}

function mergeHeads(repo, pull) {
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseHead = repo.refs.get(baseRef) ?? pull.base.sha;
  const headHead = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  if (!baseHead || !headHead) {
    return { status: 405, error: 'Pull request has no commit history' };
  }
  return { status: 200, baseRef, baseHead, headHead };
}

function markMerged(pull, mergeSha, headHead) {
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = FIXED_TIME;
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = FIXED_TIME;
  pull.head.sha = headHead;
  pull.base.sha = mergeSha;
}

export function mergePull(repo, pull) {
  if (!pull || pull.state !== 'open') {
    return { status: 405, error: 'Pull request cannot be merged' };
  }

  const heads = mergeHeads(repo, pull);
  if (heads.status !== 200) return heads;
  const { baseRef, baseHead, headHead } = heads;

  const mergeBase = commonAncestor(repo, baseHead, headHead);
  const ancestorFiles = mergeBase ? filesAt(repo, mergeBase) : new Map();
  const baseFiles = filesAt(repo, baseHead);
  const headFiles = filesAt(repo, headHead);
  const allPaths = new Set([
    ...ancestorFiles.keys(),
    ...baseFiles.keys(),
    ...headFiles.keys(),
  ]);

  if (hasConflicts(allPaths, ancestorFiles, baseFiles, headFiles)) {
    pull.mergeable = false;
    return { status: 405, error: 'Merge conflict' };
  }

  const merged = mergedFileSet(ancestorFiles, baseFiles, headFiles);
  const message = `Merge pull request #${pull.number}: ${pull.title}`;
  const mergeSha = makeCommit(repo, baseRef, merged, message, { parent: baseHead });
  markMerged(pull, mergeSha, headHead);
  return { status: 200, sha: mergeSha, message: 'Pull request successfully merged' };
}

function decodePrefixedId(encoded, prefix) {
  let decoded = '';
  try {
    decoded = Buffer.from(asText(encoded), 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(prefix)) return null;
  const id = Number(decoded.slice(prefix.length));
  return Number.isFinite(id) ? id : null;
}

export function decodeIssueGlobalId(encoded) {
  return decodePrefixedId(encoded, ISSUE_PREFIX);
}
