export const D1_BOOKMARK_HEADER = 'X-Dee-Wan-D1-Bookmarks';
const MAX_HEADER_LENGTH = 8192;
const MAX_DATABASES = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOOKMARK = /^(?!first-primary$|first-unconstrained$)[\x21-\x7e]{1,512}$/;

export type D1Bookmarks = Record<string, string>;

export function decodeD1Bookmarks(value: string | null): D1Bookmarks | null {
  if (value === null) return {};
  if (!value || value.length > MAX_HEADER_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length > MAX_DATABASES || entries.some(([id, bookmark]) => !UUID.test(id) || typeof bookmark !== 'string' || !BOOKMARK.test(bookmark))) return null;
    return Object.fromEntries(entries);
  } catch { return null; }
}

export function parseD1Bookmarks(value: string | null): D1Bookmarks {
  return decodeD1Bookmarks(value) ?? {};
}

export function mergeD1Bookmarks(target: D1Bookmarks, incoming: D1Bookmarks): boolean {
  for (const [id, bookmark] of Object.entries(incoming)) {
    if (!UUID.test(id) || !BOOKMARK.test(bookmark) || (target[id] && bookmark <= target[id])) continue;
    const previous = target[id];
    target[id] = bookmark;
    if (serializeD1Bookmarks(target) === null) {
      if (previous === undefined) delete target[id];
      else target[id] = previous;
      return false;
    }
  }
  return true;
}

export function serializeD1Bookmarks(bookmarks: D1Bookmarks): string | null {
  const entries = Object.entries(bookmarks).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > MAX_DATABASES || entries.some(([id, bookmark]) => !UUID.test(id) || !BOOKMARK.test(bookmark))) return null;
  const result = JSON.stringify(Object.fromEntries(entries));
  return result.length <= MAX_HEADER_LENGTH ? result : null;
}
