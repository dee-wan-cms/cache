import type { D1Database } from '@cloudflare/workers-types';
import { cacheD1Read, type D1ReadOptions } from './read';

const MAX_BODY_BYTES = 1_000_000;
const sensitiveHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-site-token', 'x-capability', 'x-capability-token']);
const ephemeralHeaders = new Set(['cf-ray', 'x-request-id', 'traceparent', 'tracestate', 'cf-connecting-ip', 'x-forwarded-for']);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export interface D1JsonReadOptions extends Omit<D1ReadOptions<never>, 'cacheable' | 'regionalTtlMs'> {
  request: Request;
  buffered?: true;
}

export interface JsonResponseEntry {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

function requestIdentity(request: Request): unknown | null {
  if (request.method !== 'GET') return null;
  for (const name of ['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range', 'x-capability', 'x-capability-token', 'x-site-token', 'x-api-key', 'authorization']) if (request.headers.has(name)) return null;
  const url = new URL(request.url);
  if (/(?:^|\/)(?:capability|capabilities)(?:\/|$)/i.test(url.pathname)) return null;
  for (const name of url.searchParams.keys()) if (/^(?:preview|token|capability|capability_token)$/i.test(name)) return null;
  const headers = [...request.headers.entries()].filter(([name]) => !sensitiveHeaders.has(name.toLowerCase()) && !ephemeralHeaders.has(name.toLowerCase())).sort(([a], [b]) => a.localeCompare(b));
  return { url: url.toString(), headers };
}

export async function responseEntry(response: Response): Promise<JsonResponseEntry | null> {
  if (response.status !== 200 || response.headers.has('set-cookie') || response.headers.has('content-disposition') || response.headers.has('transfer-encoding') || response.headers.has('content-encoding')) return null;
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return null;
  const vary = response.headers.get('vary');
  if (vary && vary.split(',').some((name) => name.trim() === '*' || (sensitiveHeaders.has(name.trim().toLowerCase()) || ephemeralHeaders.has(name.trim().toLowerCase())))) return null;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BODY_BYTES)) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('buffered body timeout')), 1000); });
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(next.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
  if (length !== null && size !== Number(length)) return null;
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined);
  try { JSON.parse(body); } catch { return null; }
  const headers: [string, string][] = [...response.headers.entries()].filter(([name]) => !hopHeaders.has(name.toLowerCase()));
  return { status: response.status, statusText: response.statusText, headers, body };
}

export async function cacheD1JsonRead(database: D1Database, options: D1JsonReadOptions, load: () => Promise<Response>): Promise<Response> {
  if (options.buffered !== true) return load();
  let identity: unknown | null;
  try { identity = requestIdentity(options.request); } catch { return load(); }
  if (identity === null) return load();
  let original: Response | undefined;
  const entry = await cacheD1Read<JsonResponseEntry | null>(database, {
    key: ['json-response-v1', options.key, identity],
    scope: options.scope,
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    cacheable: (value) => value !== null,
  }, async () => {
    original = await load();
    try { return await responseEntry(original); } catch { return null; }
  });
  if (original) return original;
  if (!entry || entry.status !== 200 || typeof entry.statusText !== 'string' || typeof entry.body !== 'string' || !Array.isArray(entry.headers) || !entry.headers.every((header) => Array.isArray(header) && header.length === 2 && typeof header[0] === 'string' && typeof header[1] === 'string' && !hopHeaders.has(header[0].toLowerCase()) && header[0].toLowerCase() !== 'set-cookie' && header[0].toLowerCase() !== 'content-disposition')) return load();
  try {
    JSON.parse(entry.body);
    const headers = new Headers(entry.headers);
    if (headers.has('content-encoding') || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) return load();
    const vary = headers.get('vary');
    if (vary && vary.split(',').some((name) => name.trim() === '*' || sensitiveHeaders.has(name.trim().toLowerCase()) || ephemeralHeaders.has(name.trim().toLowerCase()))) return load();
    return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers });
  } catch { return load(); }
}
