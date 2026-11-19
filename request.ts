const BEARER = 'Bearer ';

function objectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function headerValue(headers, name) {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function bearerValue(headers) {
  const raw = headerValue(headers, 'authorization');
  if (typeof raw !== 'string' || !raw.startsWith(BEARER)) return null;
  return raw.slice(BEARER.length);
}

export function bearerMatches(headers, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return bearerValue(headers) === expected;
}

export function decodePayload(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

export function bufferText(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
}

export async function readJsonRequest(req, collect) {
  const body = await collect(req);
  const decoded = decodePayload(bufferText(body));
  if (!decoded.ok) throw new Error('Parse error');
  return decoded.value;
}

export function argumentBag(value) {
  return objectLike(value) ? value : {};
}

export function blankArgument(value) {
  return value === undefined || value === null || value === '';
}

export function firstArgument(args, names, fallback = '') {
  for (const name of names) {
    const value = args[name];
    if (!blankArgument(value)) return String(value);
  }
  return fallback;
}

export function integerArgument(args, name, fallback = 0) {
  const raw = args[name];
  if (blankArgument(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function missingKeys(required, args) {
  return required.filter((name) => blankArgument(args[name]));
}

export function namedTool(tools, name) {
  return tools.find((tool) => tool.name === name) ?? null;
}

export function textArgument(args, name, fallback = '') {
  const value = args[name];
  return blankArgument(value) ? fallback : String(value);
}
