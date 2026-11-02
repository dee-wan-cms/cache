import { responseEntry, type JsonResponseEntry } from './json-read';
import { regionalKey, regionalRead, regionalWrite } from './regional';

export interface RegionalResponseOptions {
  namespace: string;
  ttlMs: number;
  waitUntil?: (promise: Promise<void>) => void;
}

const sensitive = /^(?:cookie|authorization|proxy-authorization|(?:x-)?api-key|(?:x-)?site-token|(?:x-)?site-key|(?:x-)?capability(?:-token)?|x-preview|preview)$/i;
const ephemeral = /^(?:cf-ray|x-request-id|traceparent|tracestate|cf-connecting-ip|x-forwarded-for)$/i;
const hop = /^(?:connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i;
const conditional = /^(?:range|if-match|if-none-match|if-modified-since|if-unmodified-since|if-range)$/i;

function identity(request: Request): unknown | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (/(?:^|\/)(?:capability|capabilities)(?:\/|$)/i.test(url.pathname)) return null;
  if ([...url.searchParams.keys()].some((name) => /^(?:preview|token|capability|capability_token)$/i.test(name))) return null;
  if ((request.headers.get('cache-control') ?? '').split(',').some((part) => /^\s*(?:no-cache|no-store)(?:\s*=|\s*$)/i.test(part))) return null;
  const headers: [string, string][] = [];
  for (const [name, value] of request.headers) {
    if (sensitive.test(name) || conditional.test(name) || /(?:^|[-_])(?:capability|preview)(?:[-_]|$)/i.test(name)) return null;
    if (!ephemeral.test(name)) headers.push([name, value]);
  }
  headers.sort(([a], [b]) => a.localeCompare(b));
  return [url.toString(), headers];
}

function eligible(headers: Headers): boolean {
  const control = headers.get('cache-control') ?? '';
  const directives = control.split(',').map((part) => part.trim());
  if (!directives.some((part) => /^public$/i.test(part)) || directives.some((part) => /^(?:private|no-store|no-cache)(?:\s*=|$)/i.test(part))) return false;
  if (!directives.some((part) => /^s-maxage\s*=\s*"?[1-9]\d*"?$/i.test(part))) return false;
  for (const [name] of headers) if (hop.test(name)) return false;
  const vary = headers.get('vary');
  return !vary || vary.split(',').every((part) => {
    const name = part.trim();
    return !!name && name !== '*' && !sensitive.test(name) && !ephemeral.test(name) && !conditional.test(name) && !hop.test(name) && !/(?:^|[-_])(?:capability|preview)(?:[-_]|$)/i.test(name);
  });
}

function reconstruct(value: unknown): Response | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<JsonResponseEntry>;
  if (entry.status !== 200 || typeof entry.statusText !== 'string' || typeof entry.body !== 'string' || !Array.isArray(entry.headers) || !entry.headers.every((header) => Array.isArray(header) && header.length === 2 && typeof header[0] === 'string' && typeof header[1] === 'string')) return null;
  try {
    if (new TextEncoder().encode(entry.body).byteLength > 1_000_000) return null;
    JSON.parse(entry.body);
    const headers = new Headers(entry.headers);
    const length = headers.get('content-length');
    if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) !== new TextEncoder().encode(entry.body).byteLength)) return null;
    if (!eligible(headers) || headers.has('set-cookie') || headers.has('content-disposition') || headers.has('content-encoding') || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) return null;
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
    return new Response(entry.body, { status:200, statusText:entry.statusText, headers });
  } catch { return null; }
}

export async function cacheRegionalResponse(request: Request, options: RegionalResponseOptions, load: () => Promise<Response>): Promise<Response> {
  let requestIdentity: unknown | null;
  try { requestIdentity = identity(request); } catch { return load(); }
  if (requestIdentity === null || typeof options.namespace !== 'string' || !options.namespace.trim()) return load();
  const key = await regionalKey(options.ttlMs, ['http-response', options.namespace, options.ttlMs, requestIdentity]);
  if (!key) return load();
  const cached = await regionalRead(key, options.ttlMs);
  if (cached) {
    const response = reconstruct(cached.value);
    if (response) return response;
  }
  const started = Date.now();
  const response = await load();
  if (!eligible(response.headers)) return response;
  let entry: JsonResponseEntry | null;
  try { entry = await responseEntry(response); } catch { return response; }
  if (!entry) return response;
  const output = reconstruct(entry);
  if (!output) return response;
  const sharedAge = (response.headers.get('cache-control') ?? '').split(',').map((part) => /^\s*s-maxage\s*=\s*"?([1-9]\d*)"?\s*$/i.exec(part)).filter((match): match is RegExpExecArray => match !== null).map((match) => Number(match[1]));
  const fill = regionalWrite(key, Math.min(options.ttlMs, ...sharedAge.map((age) => age * 1000)), started, entry);
  if (options.waitUntil) {
    try { options.waitUntil(fill); } catch { await fill; }
  } else await fill;
  return output;
}
