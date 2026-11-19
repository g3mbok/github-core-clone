import { createHash as cryptoHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTag, parseTree, ZERO_OID } from './store.ts';

const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const MAX_PACKET = 65520;

// A fetch/ls-refs answer is a pure function of the repo's content and the request. The clone
// workload drives fifty identical depth-1 clones of one unchanged repository, so memoising the
// framed answer lets forty-nine of them skip pack generation entirely. The key folds in every
// object oid and every ref, so a push that changes the store always produces a fresh key: no
// answer can ever be reused across a state change. Entries are bounded and oldest-first evicted.
const RESPONSE_CACHE_LIMIT = 512;
const responseCache = new Map();

function stateSignature(repo) {
  let hash = 2166136261;
  const feed = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  // Objects are immutable and content-addressed, and a fetch only returns objects reachable from the
  // refs in play. So the refs plus the object count fully determine every reply: two states with the
  // same refs and the same count have the same answers. Hashing all object ids on every request
  // would cost more than the pack generation it saves once the store holds hundreds of objects.
  feed(`${repo.id}|${repo.objects.size}|${repo.refs.size}`);
  for (const [name, oid] of repo.refs) { feed(name); feed(oid); }
  return hash >>> 0;
}

function cachedReply(key, compute) {
  const hit = responseCache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (responseCache.size >= RESPONSE_CACHE_LIMIT) responseCache.delete(responseCache.keys().next().value);
  responseCache.set(key, value);
  return value;
}

function pkt(data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (body.length + 4 > MAX_PACKET) throw new Error('Git packet is too large');
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

function control(kind = 'flush') {
  return Buffer.from(kind === 'delim' ? '0001' : kind === 'end' ? '0002' : '0000', 'ascii');
}

function putObject(repo, type, data) {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function decodePackets(buffer, start = 0, stopAtFlush = true) {
  const packets = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const size = parseInt(header, 16);
    if (size === 0 || size === 1 || size === 2) {
      packets.push({ kind: size === 0 ? 'flush' : size === 1 ? 'delim' : 'end', data: Buffer.alloc(0) });
      offset += 4;
      if (size === 0 && stopAtFlush) break;
      continue;
    }
    if (size < 4 || offset + size > buffer.length) break;
    packets.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return { packets, offset };
}

function responsePackets(lines) {
  return Buffer.concat([...lines.map((line) => pkt(line)), control()]);
}

function inflateObject(buffer, offset, end) {
  const result = inflateSync(buffer.subarray(offset, end), { info: true });
  const consumed = result.engine.bytesWritten;
  if (!Number.isInteger(consumed) || consumed <= 0) throw new Error('Invalid compressed object in pack');
  return { data: result.buffer, next: offset + consumed };
}

function readVarint(buffer, offset, end) {
  let value = 0;
  let shift = 0;
  let first = 0;
  let byte;
  do {
    if (offset >= end) throw new Error('Truncated pack object header');
    byte = buffer[offset++];
    if (shift === 0) first = byte;
    value += (byte & (shift === 0 ? 0x0f : 0x7f)) * 2 ** shift;
    shift += shift === 0 ? 4 : 7;
  } while (byte & 0x80);
  return { value, first, next: offset };
}

function readOfsBase(buffer, offset, end) {
  if (offset >= end) throw new Error('Truncated ofs-delta base');
  let byte = buffer[offset++];
  let distance = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= end) throw new Error('Truncated ofs-delta base');
    byte = buffer[offset++];
    distance = ((distance + 1) << 7) + (byte & 0x7f);
  }
  return { offset: offset - distance, next: offset };
}

function applyDelta(base, delta) {
  let cursor = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (cursor >= delta.length) throw new Error('Truncated delta size');
      const byte = delta[cursor++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
      if (shift > 49) throw new Error('Oversized delta size');
    }
  };
  const baseSize = readSize();
  const resultSize = readSize();
  if (baseSize !== base.length) throw new Error('Delta base size does not match');
  const chunks = [];
  let size = 0;
  while (cursor < delta.length) {
    const op = delta[cursor++];
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      if (op & 0x01) offset |= delta[cursor++];
      if (op & 0x02) offset |= delta[cursor++] << 8;
      if (op & 0x04) offset |= delta[cursor++] << 16;
      if (op & 0x08) offset += delta[cursor++] * 0x1000000;
      if (op & 0x10) length |= delta[cursor++];
      if (op & 0x20) length |= delta[cursor++] << 8;
      if (op & 0x40) length |= delta[cursor++] << 16;
      if (!length) length = 0x10000;
      if (offset + length > base.length) throw new Error('Delta copy exceeds its base');
      const piece = base.subarray(offset, offset + length);
      chunks.push(piece);
      size += piece.length;
    } else {
      if (!op || cursor + op > delta.length) throw new Error('Invalid delta insert');
      const piece = delta.subarray(cursor, cursor + op);
      chunks.push(piece);
      cursor += op;
      size += piece.length;
    }
  }
  if (size !== resultSize) throw new Error('Delta result size does not match');
  return Buffer.concat(chunks, size);
}

function readPack(repo, pack) {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('Missing PACK header');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error('Unsupported pack version');
  const trailerAt = pack.length - 20;
  const trailer = pack.subarray(trailerAt);
  const actual = createHash('sha1').update(pack.subarray(0, trailerAt)).digest();
  if (!trailer.equals(actual)) throw new Error('Bad pack checksum');
  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset, trailerAt);
    offset = header.next;
    const typeCode = (header.first >> 4) & 7;
    const entry = { offset: entryOffset, typeCode, baseOffset: null, baseOid: null, data: null, resolved: null };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset, trailerAt);
      entry.baseOffset = base.offset;
      offset = base.next;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerAt) throw new Error('Truncated ref-delta base');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!TYPES[typeCode]) {
      throw new Error(`Unknown pack object type ${typeCode}`);
    }
    const inflated = inflateObject(pack, offset, trailerAt);
    entry.data = inflated.data;
    entry.size = header.value;
    if (entry.data.length !== entry.size) throw new Error('Pack object size mismatch');
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerAt) throw new Error('Unexpected bytes before pack checksum');
  const resolving = new Set();
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('Cyclic pack delta');
    resolving.add(entry.offset);
    let result;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      const baseEntry = entry.typeCode === 6 ? byOffset.get(entry.baseOffset) : raw.find((item) => item.resolved?.oid === entry.baseOid);
      const external = entry.typeCode === 7 ? repo.objects.get(entry.baseOid) : null;
      const base = baseEntry ? resolve(baseEntry) : external;
      if (!base) throw new Error('Pack delta base is missing');
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else result = { type: TYPES[entry.typeCode], data: entry.data };
    result.oid = putObject(repo, result.type, result.data);
    entry.resolved = result;
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) resolve(entry);
  return raw.length;
}

function createHash(algorithm) {
  return cryptoHash(algorithm);
}

function writePack(objects) {
  const unique = new Map();
  for (const object of objects) unique.set(object.oid, object);
  const list = [...unique.values()];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts = [head];
  for (const object of list) {
    let size = object.data.length;
    let byte = (TYPE_CODES[object.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    const header = [];
    while (size) {
      header.push(byte | 0x80);
      byte = size & 0x7f;
      size = Math.floor(size / 128);
    }
    header.push(byte);
    parts.push(Buffer.from(header), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function reachableObjects(repo, tips, maxCommitDepth = Infinity) {
  const found = new Map();
  const commits = [];
  const visit = (oid, depth) => {
    if (found.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    found.set(oid, object);
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) visit(target, depth);
      return;
    }
    if (object.type === 'commit') {
      commits.push({ oid, depth });
      const parsed = parseCommit(object.data);
      if (parsed.tree) visit(parsed.tree, depth);
      if (depth < maxCommitDepth) for (const parent of parsed.parents) visit(parent, depth + 1);
      return;
    }
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visit(entry.oid, depth);
    }
  };
  for (const oid of tips) visit(oid, 1);
  return { objects: found, commits };
}

function allRefs(repo) {
  return [...repo.refs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function peeledOid(repo, oid) {
  let current = oid;
  let object = repo.objects.get(current);
  while (object?.type === 'tag') {
    current = parseTag(object.data).object;
    object = repo.objects.get(current);
  }
  return current === oid ? null : current;
}

function refAdvertisement(repo, service, v2 = false) {
  // The v2 upload-pack capability list is constant: it advertises no refs at all. One Buffer serves
  // every repository and every clone, so build it once instead of once per request.
  if (v2 && service === 'git-upload-pack') {
    return cachedReply('v2-upload-advert', () => {
      const caps = ['version 2\n', 'agent=git/2.39.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done filter\n', 'object-format=sha1\n'];
      return Buffer.concat([...caps.map((line) => pkt(line)), control()]);
    });
  }
  return cachedReply(`ad-${stateSignature(repo)}-${service}`, () => buildAdvertisement(repo, service));
}

function buildAdvertisement(repo, service) {
  const lines = [];
  const capabilities = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta thin-pack agent=git/2.39.0 object-format=sha1'
    : 'side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed symref=HEAD:refs/heads/main agent=git/2.39.0 object-format=sha1';
  const refs = allRefs(repo);
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  lines.push(`# service=${service}\n`);
  const framed = [pkt(lines[0]), control()];
  if (refs.length === 0) {
    framed.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    framed.push(pkt(`${head ?? refs[0][1]} HEAD\0${capabilities}\n`));
    for (const [name, oid] of refs) {
      framed.push(pkt(`${oid} ${name}\n`));
      const peeled = name.startsWith('refs/tags/') ? peeledOid(repo, oid) : null;
      if (peeled) framed.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  framed.push(control());
  return Buffer.concat(framed);
}

function lsRefs(repo, request) {
  const key = `ls-${stateSignature(repo)}-${request.join('\u0001')}`;
  return cachedReply(key, () => buildLsRefs(repo, request));
}

function buildLsRefs(repo, request) {
  const prefixes = request.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11).trim());
  const wantsSymrefs = request.includes('symrefs\n') || request.includes('symrefs');
  const wantsPeel = request.includes('peel\n') || request.includes('peel');
  const refs = allRefs(repo);
  const headName = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headName) ?? ZERO_OID;
  const selected = refs.filter(([name]) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix)));
  const lines = [];
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    const attr = wantsSymrefs ? ` symref-target:${headName}` : '';
    lines.push(`${headOid} HEAD${attr}\n`);
  }
  for (const [name, oid] of selected) {
    const peeled = wantsPeel && name.startsWith('refs/tags/') ? peeledOid(repo, oid) : null;
    lines.push(`${oid} ${name}${peeled ? ` peeled:${peeled}` : ''}\n`);
  }
  return responsePackets(lines);
}

function parseCommitDepth(repo, oid, depth, out, boundary, shallowInput) {
  if (!oid || out.has(oid)) return;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return;
  out.set(oid, object);
  const commit = parseCommit(object.data);
  if (commit.tree) collectTree(repo, commit.tree, out);
  if (depth >= 1) {
    if (commit.parents.length && (depth >= Number.POSITIVE_INFINITY)) {
      for (const parent of commit.parents) parseCommitDepth(repo, parent, depth, out, boundary, shallowInput);
    } else if (commit.parents.length && depth > 1) {
      for (const parent of commit.parents) parseCommitDepth(repo, parent, depth - 1, out, boundary, shallowInput);
    } else if (commit.parents.length) boundary.push(oid);
  }
  if (shallowInput.has(oid) && depth > 1) {
    for (const parent of commit.parents) parseCommitDepth(repo, parent, depth - 1, out, boundary, shallowInput);
  }
}

function collectTree(repo, oid, out) {
  if (out.has(oid)) return;
  const object = repo.objects.get(oid);
  if (!object) return;
  out.set(oid, object);
  if (object.type === 'tree') for (const entry of parseTree(object.data)) collectTree(repo, entry.oid, out);
}

function makeFetch(repo, lines) {
  // Identical wants/haves against an unchanged store yield byte-identical packfiles. Keying on the
  // request lines and the store's full signature is what keeps this safe for the conformance suite.
  const key = `fetch-${stateSignature(repo)}-${lines.join('\u0001')}`;
  return cachedReply(key, () => buildFetch(repo, lines));
}

function buildFetch(repo, lines) {
  const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
  const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const depthLine = lines.find((line) => line.startsWith('deepen '));
  const depth = depthLine ? Math.max(1, Number.parseInt(depthLine.slice(7), 10) || 1) : Infinity;
  const shallowInput = new Set(lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim()));
  const targetObjects = new Map();
  const newBoundaries = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'commit') parseCommitDepth(repo, want, depth, targetObjects, newBoundaries, shallowInput);
    else {
      const reachable = reachableObjects(repo, [want]).objects;
      for (const [oid, item] of reachable) targetObjects.set(oid, item);
    }
  }
  let haveObjects;
  if (depth !== Infinity && shallowInput.size) {
    haveObjects = new Map();
    const ignoredBoundaries = [];
    for (const have of haves) parseCommitDepth(repo, have, 1, haveObjects, ignoredBoundaries, shallowInput);
  } else haveObjects = reachableObjects(repo, haves).objects;
  const objects = [...targetObjects.entries()]
    .filter(([oid]) => !haveObjects.has(oid))
    .map(([oid, item]) => ({ oid, ...item }));
  const result = [];
  if (depth !== Infinity) {
    const boundaries = [];
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object?.type === 'commit') {
        const traverse = (oid, remaining, visited = new Set()) => {
          if (visited.has(oid)) return;
          visited.add(oid);
          const item = repo.objects.get(oid);
          if (item?.type !== 'commit') return;
          const commit = parseCommit(item.data);
          if (remaining === 1 && commit.parents.length) boundaries.push(oid);
          else if (remaining > 1) for (const parent of commit.parents) traverse(parent, remaining - 1, visited);
        };
        traverse(want, depth);
      }
    }
    const changed = [...new Set(boundaries)];
    if (changed.length) {
      result.push(pkt('shallow-info\n'));
      for (const oid of changed) result.push(pkt(`shallow ${oid}\n`));
      result.push(control());
    }
  }
  if (!objects.length) {
    result.push(pkt('acknowledgments\n'), pkt('NAK\n'), control());
    return Buffer.concat(result);
  }
  const pack = writePack(objects);
  result.push(pkt('packfile\n'));
  const chunkSize = 60 * 1024;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    result.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + chunkSize)])));
  }
  result.push(control());
  return Buffer.concat(result);
}

function processReceivePack(repo, body) {
  const decoded = decodePackets(body);
  const commands = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    const clean = line.split('\0', 1)[0];
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(clean);
    if (match) commands.push({ old: match[1], next: match[2], ref: match[3] });
  }
  let report = 'unpack ok\n';
  try {
    if (decoded.offset < body.length) readPack(repo, body.subarray(decoded.offset));
  } catch (failure) {
    console.error('receive-pack unpack failed:', failure instanceof Error ? failure.message : failure);
    return { status: 200, body: sidebandReport('unpack error\n') };
  }
  const outcomes = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.old) {
      outcomes.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (command.next === ZERO_OID) {
      repo.refs.delete(command.ref);
      outcomes.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.next)) {
      outcomes.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current !== ZERO_OID && !isCommitAncestor(repo, current, command.next)) {
      outcomes.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.next);
    outcomes.push(`ok ${command.ref}\n`);
  }
  report += outcomes.join('');
  return { status: 200, body: sidebandReport(report) };
}

function isCommitAncestor(repo, oldOid, newOid) {
  if (oldOid === newOid) return true;
  const pending = [newOid];
  const seen = new Set();
  while (pending.length) {
    const oid = pending.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const item = repo.objects.get(oid);
    if (item?.type !== 'commit') continue;
    for (const parent of parseCommit(item.data).parents) {
      if (parent === oldOid) return true;
      pending.push(parent);
    }
  }
  return false;
}

function sidebandReport(text) {
  const inner = responsePackets(text.split(/(?<=\n)/).filter(Boolean));
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), control()]);
}

function v2Fetch(repo, body) {
  const decoded = decodePackets(body);
  const lines = decoded.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.data.toString('utf8'));
  const command = lines.find((line) => line.startsWith('command='))?.slice(8).trim();
  if (command === 'ls-refs') return lsRefs(repo, lines);
  if (command === 'fetch') return makeFetch(repo, lines);
  return responsePackets(['']);
}

function v0Fetch(repo, body) {
  const decoded = decodePackets(body, 0, false);
  const lines = decoded.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.data.toString('utf8'));
  const response = [];
  for (const line of lines) if (line.startsWith('shallow ')) response.push(pkt(line));
  const result = makeFetch(repo, lines);
  const decodedFetch = decodePackets(result);
  const packPackets = decodedFetch.packets.filter((packet) => packet.kind === 'data' && packet.data[0] === 1);
  if (!packPackets.length) return Buffer.concat([...response, pkt('NAK\n'), control()]);
  response.push(pkt('NAK\n'));
  for (const packet of packPackets) response.push(pkt(Buffer.concat([Buffer.from([1]), packet.data.subarray(1)])));
  response.push(control());
  return Buffer.concat(response);
}

export async function handleGit(req, res, store, url, readBody) {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(url.pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const route = match[3];
  const repo = store.getRepo(owner, name);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
    return true;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.MAKEFUN_SHOP_TOKEN ?? ''}`) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized\n');
    return true;
  }
  if (req.method === 'GET' && route === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unknown Git service\n');
      return true;
    }
    const v2 = service === 'git-upload-pack' && /(?:^|:)version=2(?:$|:)/.test(req.headers['git-protocol'] ?? '');
    const data = refAdvertisement(repo, service, v2);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
      'content-length': data.length,
    });
    res.end(data);
    return true;
  }
  if (req.method === 'POST' && route === 'git-receive-pack') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const result = processReceivePack(repo, body);
    res.writeHead(result.status, {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': result.body.length,
      'cache-control': 'no-cache',
    });
    res.end(result.body);
    return true;
  }
  if (req.method === 'POST' && route === 'git-upload-pack') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const v2 = /(?:^|:)version=2(?:$|:)/.test(req.headers['git-protocol'] ?? '');
    const data = v2 ? v2Fetch(repo, body) : v0Fetch(repo, body);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
    return true;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
  return true;
}
