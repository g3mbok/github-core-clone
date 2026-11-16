import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }
export interface GitRepo { objects: Map<string, GitObject>; refs: Map<string, string>; default_branch: string }
export interface FileEntry { path: string; mode: string; sha: string; size: number }

const zeroOid = '0'.repeat(40);
const typeToCode: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const codeToType: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

export function putObject(repo: GitRepo, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}

export function parseCommit(repo: GitRepo, sha: string): { tree: string; parents: string[]; message: string } | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const text = object.data.toString('utf8');
  const [headers, ...body] = text.split('\n\n');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(headers ?? '')?.[1] ?? '';
  const parents = [...(headers ?? '').matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]!);
  return { tree, parents, message: body.join('\n\n').replace(/\n$/, '') };
}

export function commitMessage(repo: GitRepo, sha: string): string {
  return parseCommit(repo, sha)?.message ?? '';
}

function parseTree(repo: GitRepo, sha: string): Array<{ mode: string; name: string; sha: string }> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'tree') return [];
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let offset = 0;
  while (offset < object.data.length) {
    const space = object.data.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : object.data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > object.data.length) break;
    entries.push({
      mode: object.data.subarray(offset, space).toString('ascii'),
      name: object.data.subarray(space + 1, nul).toString('utf8'),
      sha: object.data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function writeTree(repo: GitRepo, entries: Array<{ mode: string; name: string; sha: string }>): string {
  entries.sort((a, b) => {
    const aa = a.name + (a.mode === '40000' ? '/' : '');
    const bb = b.name + (b.mode === '40000' ? '/' : '');
    return Buffer.compare(Buffer.from(aa), Buffer.from(bb));
  });
  const bytes: Buffer[] = [];
  for (const entry of entries) {
    bytes.push(Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(bytes));
}

export function filesAtCommit(repo: GitRepo, commitSha: string): Map<string, { mode: string; sha: string }> {
  const commit = parseCommit(repo, commitSha);
  const files = new Map<string, { mode: string; sha: string }>();
  if (!commit) return files;
  const walk = (treeSha: string, prefix: string): void => {
    for (const entry of parseTree(repo, treeSha)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.sha, path);
      else files.set(path, { mode: entry.mode, sha: entry.sha });
    }
  };
  walk(commit.tree, '');
  return files;
}

export function listFiles(repo: GitRepo, commitSha: string): FileEntry[] {
  return [...filesAtCommit(repo, commitSha)].map(([path, file]) => ({
    path, mode: file.mode, sha: file.sha, size: repo.objects.get(file.sha)?.data.length ?? 0,
  }));
}

export function makeCommit(
  repo: GitRepo,
  parent: string | null,
  message: string,
  files: Map<string, { mode: string; sha: string }>,
): string {
  const dirs = new Map<string, Array<{ mode: string; name: string; sha: string }>>();
  const ensure = (path: string) => {
    let node = dirs.get(path);
    if (!node) { node = []; dirs.set(path, node); }
    return node;
  };
  ensure('');
  for (const [path, file] of files) {
    const segments = path.split('/');
    const name = segments.pop()!;
    const parentPath = segments.join('/');
    ensure(parentPath).push({ mode: file.mode, name, sha: file.sha });
    let prefix = '';
    for (const segment of segments) {
      const next = prefix ? `${prefix}/${segment}` : segment;
      if (!ensure(prefix).some((entry) => entry.name === segment && entry.mode === '40000')) {
        ensure(prefix).push({ mode: '40000', name: segment, sha: '' });
      }
      prefix = next;
      ensure(prefix);
    }
  }
  const directoryShas = new Map<string, string>();
  for (const path of [...dirs.keys()].sort((a, b) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return b.split('/').length - a.split('/').length;
  })) {
    const entries = dirs.get(path)!;
    for (const entry of entries) {
      if (entry.mode === '40000') {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        entry.sha = directoryShas.get(childPath) ?? writeTree(repo, []);
      }
    }
    directoryShas.set(path, writeTree(repo, entries));
  }
  const tree = directoryShas.get('')!;
  const ident = 'GitHub Forge <forge@example.invalid> 1767225600 +0000';
  const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${ident}\ncommitter ${ident}\n\n${message.replace(/\n*$/, '')}\n`;
  return putObject(repo, 'commit', Buffer.from(body));
}

export function isAncestor(repo: GitRepo, older: string, newer: string): boolean {
  if (older === newer) return true;
  const pending = [newer];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of parseCommit(repo, current)?.parents ?? []) {
      if (parent === older) return true;
      pending.push(parent);
    }
  }
  return false;
}

function pkt(payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}
const flush = () => Buffer.from('0000');

function decodePackets(buffer: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (length === 0) { offset += 4; break; }
    if (length === 1) { lines.push(Buffer.alloc(0)); offset += 4; continue; }
    if (length === 2) { offset += 4; break; }
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) break;
    lines.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, rest: buffer.subarray(offset) };
}

function reachable(repo: GitRepo, roots: string[], limits?: { depth: number; shallow: string[]; stopAtShallow?: boolean }): GitObject[] {
  const result: GitObject[] = [];
  const seen = new Set<string>();
  const queue = roots.map((sha) => ({ sha, depth: 1 }));
  while (queue.length) {
    const { sha, depth } = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (!object) continue;
    result.push(object);
    if (object.type === 'commit') {
      const parsed = parseCommit(repo, sha);
      if (!parsed) continue;
      queue.push({ sha: parsed.tree, depth });
      if ((!limits || depth < limits.depth) && !(limits?.stopAtShallow && limits.shallow.includes(sha))) {
        for (const parent of parsed.parents) queue.push({ sha: parent, depth: depth + 1 });
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(repo, sha)) queue.push({ sha: entry.sha, depth });
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'))?.[1];
      if (target) queue.push({ sha: target, depth });
    }
  }
  return result;
}

function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2])];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length);
  parts.push(count);
  for (const object of objects) {
    let size = object.data.length;
    let first = (typeToCode[object.type] << 4) | (size & 0x0f);
    size >>>= 4;
    const header: number[] = [];
    if (size) first |= 0x80;
    header.push(first);
    while (size) {
      let byte = size & 0x7f;
      size >>>= 7;
      if (size) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarInt(data: Buffer, state: { offset: number }): number {
  let value = 0;
  let shift = 0;
  while (state.offset < data.length) {
    const byte = data[state.offset++]!;
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  throw new Error('truncated git delta integer');
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const cursor = { offset: 0 };
  const baseSize = readVarInt(delta, cursor);
  const resultSize = readVarInt(delta, cursor);
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let size = 0;
  while (cursor.offset < delta.length) {
    const opcode = delta[cursor.offset++]!;
    if (opcode & 0x80) {
      let offset = 0, length = 0;
      if (opcode & 0x01) offset |= delta[cursor.offset++]!;
      if (opcode & 0x02) offset |= delta[cursor.offset++]! << 8;
      if (opcode & 0x04) offset |= delta[cursor.offset++]! << 16;
      if (opcode & 0x08) offset |= delta[cursor.offset++]! << 24;
      if (opcode & 0x10) length |= delta[cursor.offset++]!;
      if (opcode & 0x20) length |= delta[cursor.offset++]! << 8;
      if (opcode & 0x40) length |= delta[cursor.offset++]! << 16;
      if (!length) length = 0x10000;
      const chunk = base.subarray(offset, offset + length);
      chunks.push(chunk); size += chunk.length;
    } else {
      const chunk = delta.subarray(cursor.offset, cursor.offset + opcode);
      if (!opcode || chunk.length !== opcode) throw new Error('bad git delta literal');
      cursor.offset += opcode; chunks.push(chunk); size += chunk.length;
    }
  }
  if (size !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

function readPack(repo: GitRepo, pack: Buffer): number {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') return 0;
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const atOffset = new Map<number, string>();
  const pending: Array<{ offset: number; type: number; data: Buffer; baseOffset?: number; baseSha?: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (type === 6) {
      let b = pack[offset++]!;
      let distance = b & 0x7f;
      while (b & 0x80) { b = pack[offset++]!; distance = ((distance + 1) << 7) | (b & 0x7f); }
      baseOffset = entryOffset - distance;
    } else if (type === 7) {
      baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true });
    const data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    if (data.length !== size && type !== 6 && type !== 7) throw new Error('packed git object size mismatch');
    pending.push({ offset: entryOffset, type, data, baseOffset, baseSha });
  }
  for (let pass = 0; pending.length && pass < count; pass += 1) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i]!;
      let type = entry.type;
      let data = entry.data;
      if (type === 6 || type === 7) {
        const baseSha = type === 6 ? atOffset.get(entry.baseOffset!) : entry.baseSha!;
        const base = baseSha ? repo.objects.get(baseSha) : undefined;
        if (!base) continue;
        data = applyDelta(base.data, data);
        type = typeToCode[base.type];
      }
      const objectType = codeToType[type];
      if (!objectType) throw new Error(`unknown git pack object type ${type}`);
      const sha = putObject(repo, objectType, data);
      atOffset.set(entry.offset, sha);
      pending.splice(i, 1);
    }
  }
  if (pending.length) throw new Error('unresolved git pack delta');
  return offset;
}

function refEntries(repo: GitRepo): Array<[string, string]> {
  return [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
}

function peeledTag(repo: GitRepo, sha: string): string | undefined {
  let current = sha;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current === sha ? undefined : current;
    const next = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'))?.[1];
    if (!next) return undefined;
    current = next;
  }
  return undefined;
}

function advertisement(repo: GitRepo, service: 'git-upload-pack' | 'git-receive-pack', version2 = false): Buffer {
  if (version2) {
    return Buffer.concat([
      pkt('version 2\n'),
      pkt('agent=github-forge/1\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done filter\n'),
      pkt('server-option\n'),
      pkt('object-format=sha1\n'),
      flush(),
    ]);
  }
  const lines: Buffer[] = [pkt(`# service=${service}\n`), flush()];
  const caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1 object-format=sha1'
    : 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=github-forge/1 symref=HEAD:refs/heads/main object-format=sha1';
  const refs = refEntries(repo);
  if (refs.length === 0) lines.push(pkt(`${zeroOid} capabilities^{}\0${caps}\n`));
  else {
    for (let i = 0; i < refs.length; i += 1) {
      const [name, sha] = refs[i]!;
      lines.push(pkt(`${sha} ${name}${i === 0 ? `\0${caps}` : ''}\n`));
      if (name.startsWith('refs/tags/')) {
        const peeled = peeledTag(repo, sha);
        if (peeled) lines.push(pkt(`${peeled} ${name}^{}\n`));
      }
    }
  }
  lines.push(flush());
  return Buffer.concat(lines);
}

function writeHttp(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

export function handleGitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: GitRepo | null,
  path: string,
  body: Buffer,
): boolean {
  const match = /^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const service = req.url?.includes('service=git-receive-pack') || match[1] === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
  if (!repo) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found'); return true; }
  if (req.method === 'GET' && match[1] === 'info/refs') {
    const v2 = service === 'git-upload-pack' && req.headers['git-protocol']?.includes('version=2') === true;
    writeHttp(res, 200, `application/x-${service}-advertisement`, advertisement(repo, service, v2));
    return true;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return true; }
  if (match[1] === 'git-upload-pack') {
    const v2 = req.headers['git-protocol']?.includes('version=2') === true;
    const decoded = decodePackets(body);
    const lines = decoded.lines.map((line) => line.toString('utf8').trim());
    if (v2) {
      const command = lines.find((line) => line.startsWith('command='))?.slice(8) ?? '';
      if (command === 'ls-refs') {
        const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
        const result: Buffer[] = [];
        for (const [name, sha] of refEntries(repo)) {
          if (prefixes.length && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
          result.push(pkt(`${sha} ${name}\n`));
          if (lines.includes('peel') && name.startsWith('refs/tags/')) {
            const peeled = peeledTag(repo, sha);
            if (peeled) {
              result.pop();
              result.push(pkt(`${sha} ${name} peeled:${peeled}\n`));
            }
          }
        }
        if (lines.includes('symrefs') && (!prefixes.length || prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
          const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
          if (head) result.unshift(pkt(`${head} HEAD symref-target:refs/heads/${repo.default_branch}\n`));
        }
        writeHttp(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([...result, flush()]));
        return true;
      }
      if (command === 'fetch') {
        const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5));
        const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5));
        const deepen = Number(lines.find((line) => line.startsWith('deepen '))?.slice(7) ?? '0');
        const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8));
        const haveObjects = new Set(reachable(repo, haves, shallow.length ? { depth: Number.MAX_SAFE_INTEGER, shallow, stopAtShallow: true } : undefined).map((obj) => hashObject(obj.type, obj.data)));
        const objects = reachable(repo, wants, deepen > 0 ? { depth: deepen, shallow } : undefined)
          .filter((obj) => !haveObjects.has(hashObject(obj.type, obj.data)));
        const out: Buffer[] = [pkt('acknowledgments\n'), pkt(haves.length ? `ACK ${haves[0]}\n` : 'NAK\n'), flush()];
        if (deepen > 0) {
          out.push(pkt('shallow-info\n'));
          const shallowBoundaries: string[] = [];
          const unshallowBoundaries: string[] = [];
          const visited = new Map<string, number>();
          const queue = wants.map((sha) => ({ sha, depth: 1 }));
          while (queue.length) {
            const item = queue.shift()!;
            if (visited.has(item.sha)) continue;
            visited.set(item.sha, item.depth);
            if (shallow.includes(item.sha) && item.depth < deepen) unshallowBoundaries.push(item.sha);
            const parsed = parseCommit(repo, item.sha);
            if (!parsed) continue;
            if (item.depth >= deepen && parsed.parents.length) shallowBoundaries.push(item.sha);
            else for (const parent of parsed.parents) queue.push({ sha: parent, depth: item.depth + 1 });
          }
          for (const sha of unshallowBoundaries) out.push(pkt(`unshallow ${sha}\n`));
          for (const sha of shallowBoundaries) out.push(pkt(`shallow ${sha}\n`));
          out.push(flush());
        }
        out.push(pkt('packfile\n'));
        const pack = writePack(objects);
        for (let offset = 0; offset < pack.length; offset += 60_000) {
          out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + 60_000)])));
        }
        out.push(flush());
        writeHttp(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
        return true;
      }
      writeHttp(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), flush()]));
      return true;
    }
    const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).split(' ')[0]!);
    const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5));
    const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8));
    const haveObjects = new Set(reachable(repo, haves, shallow.length ? { depth: Number.MAX_SAFE_INTEGER, shallow, stopAtShallow: true } : undefined).map((obj) => hashObject(obj.type, obj.data)));
    const objects = reachable(repo, wants).filter((obj) => !haveObjects.has(hashObject(obj.type, obj.data)));
    const report = Buffer.from(haves.length ? `ACK ${haves[0]}\n` : 'NAK\n');
    const pack = writePack(objects);
    const sideband = Buffer.concat([Buffer.from([1]), report, Buffer.from([1]), pack]);
    writeHttp(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pkt(sideband), flush()]));
    return true;
  }
  const parsed = decodePackets(body);
  const commands = parsed.lines.map((line) => {
    const text = line.toString('utf8').trim();
    const [oldSha = zeroOid, newSha = zeroOid, refWithCaps = ''] = text.split(' ');
    const ref = refWithCaps.split('\0')[0]!;
    return { oldSha, newSha, ref };
  });
  const packOffset = body.indexOf(Buffer.from('PACK'));
  const pack = packOffset < 0 ? Buffer.alloc(0) : body.subarray(packOffset);
  try { if (pack.length) readPack(repo, pack); } catch {
    writeHttp(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([pkt('unpack error\n'), flush()]));
    return true;
  }
  const reports = ['unpack ok'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? zeroOid;
    if (command.oldSha !== current) {
      reports.push(`ng ${command.ref} stale info`);
    } else if (command.newSha === zeroOid) {
      repo.refs.delete(command.ref);
      reports.push(`ok ${command.ref}`);
    } else if (!repo.objects.has(command.newSha)) {
      reports.push(`ng ${command.ref} missing object`);
    } else if (current !== zeroOid && !isAncestor(repo, current, command.newSha)) {
      reports.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newSha);
      reports.push(`ok ${command.ref}`);
    }
  }
  const sideband = Buffer.concat([Buffer.from([1]), Buffer.from(`${reports.join('\n')}\n`)]);
  writeHttp(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([pkt(sideband), flush()]));
  return true;
}
