import { createHash } from 'node:crypto';

export const TOKEN_OWNER = 'adaiversen';
export const ZERO_OID = '0000000000000000000000000000000000000000';

// A fixed set of repositories makes conformance runs deterministic: the same
// names, descriptions and visibility flags appear in every trial.
const SEEDED_REPOSITORIES = [
  ['amber-thistle', 'the tooling behind the thing', false],
  ['happy-willow', 'a sandbox for the next idea', false],
  ['happy-ember', 'fixtures, generators and the odd benchmark', false],
  ['crisp-thistle', 'the parts that must not break', true],
  ['nimble-delta', 'the parts that must not break', false],
  ['tidy-harbor', 'a small service with a sharp edge', false],
  ['quiet-orchid', 'what the prototype became', false],
  ['gentle-quartz', 'fixtures, generators and the odd benchmark', false],
  ['happy-nebula', 'what the prototype became', false],
  ['witty-thistle', 'fixtures, generators and the odd benchmark', false],
  ['upbeat-yarrow', 'what the prototype became', true],
  ['faint-falcon', 'a small service with a sharp edge', false],
  ['quick-juniper', 'the parts that must not break', false],
  ['tidy-umber', 'notes and experiments, kept until they are not', false],
  ['eager-pebble', 'fixtures, generators and the odd benchmark', false],
  ['warm-raven', 'a sandbox for the next idea', false],
  ['idle-badger', 'what the prototype became', false],
  ['calm-orchid', 'a reference implementation, for reading', true],
  ['tidy-ember', 'the tooling behind the thing', false],
  ['brisk-cedar', 'what the prototype became', false],
  ['steady-meadow', 'what the prototype became', false],
  ['idle-lantern', 'the tooling behind the thing', false],
  ['quick-raven', 'the tooling behind the thing', false],
  ['plain-cedar', 'a small service with a sharp edge', false],
  ['calm-quartz', 'the tooling behind the thing', true],
  ['tidy-lantern', 'the tooling behind the thing', false],
  ['happy-thistle', 'a sandbox for the next idea', false],
  ['crisp-zephyr', 'the parts that must not break', false],
  ['keen-glade', 'fixtures, generators and the odd benchmark', false],
  ['amber-badger', 'a small service with a sharp edge', false],
];

const COMMIT_STAMP = '1735689600 +0000';

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

export function hashObject(type, data) {
  const body = toBuffer(data);
  const header = Buffer.from(`${type} ${body.length}\0`);
  return sha1(Buffer.concat([header, body]));
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1] ?? null;
  const parents = [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]);
  return { tree, parents, message };
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const object = /^object ([0-9a-f]{40})$/m.exec(text)?.[1] ?? null;
  return { object };
}

export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function isDirectoryMode(mode) {
  return mode === '40000' || mode === '040000';
}

function treeSortKey(entry) {
  const suffix = isDirectoryMode(entry.mode) ? '/' : '\0';
  return `${entry.name}${suffix}`;
}

function encodeTree(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(
    Buffer.from(treeSortKey(a), 'utf8'),
    Buffer.from(treeSortKey(b), 'utf8'),
  ));
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function object(repo, oid) {
  return repo.objects.get(oid);
}

function objectType(repo, oid) {
  const found = object(repo, oid);
  return found ? found.type : null;
}

function putObject(repo, type, data) {
  const bytes = toBuffer(data);
  const oid = hashObject(type, bytes);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data: bytes });
  }
  return oid;
}

function flattenTree(repo, treeOid, prefix = '', files = new Map()) {
  const tree = object(repo, treeOid);
  if (!tree || tree.type !== 'tree') return files;

  for (const entry of parseTree(tree.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isDirectoryMode(entry.mode)) {
      flattenTree(repo, entry.oid, path, files);
      continue;
    }
    const blob = object(repo, entry.oid);
    if (blob) {
      files.set(path, { oid: entry.oid, mode: entry.mode, type: blob.type, data: blob.data });
    }
  }
  return files;
}

function emptyTreeNode() {
  return { files: new Map(), dirs: new Map() };
}

function insertIntoTree(root, path, entry) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return;
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (!node.dirs.has(part)) {
      node.dirs.set(part, emptyTreeNode());
    }
    node = node.dirs.get(part);
  }
  node.files.set(parts[parts.length - 1], entry);
}

function writeTreeNode(repo, node) {
  const entries = [];
  for (const [name, value] of node.files) {
    const oid = value.oid ?? putObject(repo, value.type ?? 'blob', value.data);
    entries.push({ mode: value.mode ?? '100644', name, oid });
  }
  for (const [name, child] of node.dirs) {
    entries.push({ mode: '40000', name, oid: writeTreeNode(repo, child) });
  }
  return putObject(repo, 'tree', encodeTree(entries));
}

function treeFromFiles(repo, files) {
  const root = emptyTreeNode();
  for (const [path, entry] of files) {
    insertIntoTree(root, path, entry);
  }
  return writeTreeNode(repo, root);
}

export function filesAt(repo, refOrOid) {
  const oid = repo.refs.get(refOrOid) ?? refOrOid;
  const commit = object(repo, oid);
  if (!commit || commit.type !== 'commit') return new Map();
  const parsed = parseCommit(commit.data);
  if (!parsed.tree) return new Map();
  return flattenTree(repo, parsed.tree);
}

function commitAuthor() {
  return `${TOKEN_OWNER} <${TOKEN_OWNER}@users.noreply.github.com>`;
}

function commitBody(tree, parent, message) {
  const author = commitAuthor();
  const headers = [`tree ${tree}`];
  if (parent) headers.push(`parent ${parent}`);
  headers.push(`author ${author} ${COMMIT_STAMP}`);
  headers.push(`committer ${author} ${COMMIT_STAMP}`);
  const text = `${headers.join('\n')}\n\n${message || 'Update repository'}\n`;
  return Buffer.from(text, 'utf8');
}

export function makeCommit(repo, ref, files, message, options = {}) {
  const current = repo.refs.get(ref) ?? null;
  const parent = options.parent === undefined ? current : options.parent;
  const tree = treeFromFiles(repo, files);
  const body = commitBody(tree, parent, message);
  const commit = putObject(repo, 'commit', body);
  repo.refs.set(ref, commit);
  return commit;
}

export function isAncestor(repo, ancestor, descendant) {
  if (ancestor === ZERO_OID) return true;
  if (ancestor === descendant) return true;

  const pending = [descendant];
  const seen = new Set();
  while (pending.length) {
    const oid = pending.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const entry = object(repo, oid);
    if (!entry || entry.type !== 'commit') continue;
    for (const parent of parseCommit(entry.data).parents) {
      if (parent === ancestor) return true;
      pending.push(parent);
    }
  }
  return false;
}

function collectAncestors(repo, start, into) {
  const pending = [start];
  while (pending.length) {
    const oid = pending.pop();
    if (into.has(oid)) continue;
    into.add(oid);
    const entry = object(repo, oid);
    if (entry?.type === 'commit') {
      pending.push(...parseCommit(entry.data).parents);
    }
  }
}

export function commonAncestor(repo, left, right) {
  const ancestors = new Set();
  collectAncestors(repo, left, ancestors);

  const pending = [right];
  const seen = new Set();
  while (pending.length) {
    const oid = pending.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const entry = object(repo, oid);
    if (entry?.type === 'commit') {
      pending.push(...parseCommit(entry.data).parents);
    }
  }
  return null;
}

function initialRepo(owner, name, options, seeded) {
  return {
    id: options.id,
    owner,
    name,
    seeded,
    description: options.description ?? '',
    private: options.private === true,
    defaultBranch: options.defaultBranch || 'main',
    createdAt: '2025-01-01T00:00:00Z',
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
  };
}

export class ForgeStore {
  constructor() {
    this.repos = new Map();
    this.nextRepoId = 10000;
    this.nextIssueId = 1;
    this.nextCommentId = 1;
    this.nextPullId = 1;

    for (let index = 0; index < SEEDED_REPOSITORIES.length; index += 1) {
      const [name, description, isPrivate] = SEEDED_REPOSITORIES[index];
      this.createRepo(TOKEN_OWNER, name, {
        id: 5000 + index,
        description,
        private: isPrivate,
      });
    }
  }

  key(owner, name) {
    const normalizedOwner = String(owner).toLowerCase();
    const normalizedName = String(name).toLowerCase();
    return `${normalizedOwner}/${normalizedName}`;
  }

  getRepo(owner, name) {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(owner, name, options = {}) {
    const normalizedOwner = String(owner || TOKEN_OWNER);
    const normalizedName = String(name || '');
    if (!normalizedName) return null;

    const key = this.key(normalizedOwner, normalizedName);
    if (this.repos.has(key)) return null;

    const repo = initialRepo(normalizedOwner, normalizedName, {
      id: options.id ?? this.nextRepoId++,
      description: options.description,
      private: options.private,
      defaultBranch: options.defaultBranch,
    }, options.id !== undefined);
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner, name) {
    return this.repos.delete(this.key(owner, name));
  }

  putObject(repo, type, data) {
    const bytes = toBuffer(data);
    const oid = hashObject(type, bytes);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data: bytes });
    }
    return oid;
  }

  refName(repo, branch) {
    if (branch.startsWith('refs/')) return branch;
    const selected = branch || repo.defaultBranch;
    return `refs/heads/${selected}`;
  }

  headOid(repo, branch = repo.defaultBranch) {
    return repo.refs.get(this.refName(repo, branch)) ?? null;
  }
}

export function seededRepositoryNames() {
  return SEEDED_REPOSITORIES.map(([name]) => name);
}

export function isKnownObjectType(repo, oid, type) {
  return objectType(repo, oid) === type;
}
