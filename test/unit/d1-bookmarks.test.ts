import { describe, expect, it } from 'vitest';
import { createD1BookmarkFetch } from '../../src/client';
import { parseD1Bookmarks, serializeD1Bookmarks } from '../../src/d1/bookmarks';

const id = '01234567-89ab-cdef-0123-456789abcdef';

describe('D1 bookmark transport', () => {
  it('rejects malformed and oversized maps', () => {
    expect(parseD1Bookmarks('{"not-a-uuid":"bookmark"}')).toEqual({});
    expect(parseD1Bookmarks(JSON.stringify({ [id]:'first-primary' }))).toEqual({});
    expect(parseD1Bookmarks(JSON.stringify({ [id]:'first-unconstrained' }))).toEqual({});
    expect(parseD1Bookmarks(JSON.stringify({ [id]: 'x'.repeat(513) }))).toEqual({});
    expect(serializeD1Bookmarks({ [id]: 'a' })).toBe(`{"${id}":"a"}`);
  });

  it('merges out-of-order responses using the greatest bookmark', async () => {
    const pending: Array<(response: Response) => void> = [];
    const seen: Array<string | null> = [];
    const wrapped = createD1BookmarkFetch((input) => {
      seen.push(new Request(input).headers.get('X-Dee-Wan-D1-Bookmarks'));
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    const first = wrapped('https://example.com/first');
    const second = wrapped('https://example.com/second');
    pending[1]?.(new Response(null, { headers: { 'X-Dee-Wan-D1-Bookmarks': JSON.stringify({ [id]: '002' }) } }));
    await second;
    pending[0]?.(new Response(null, { headers: { 'X-Dee-Wan-D1-Bookmarks': JSON.stringify({ [id]: '001' }) } }));
    await first;
    const third = wrapped('https://example.com/third');
    expect(JSON.parse(seen[2] ?? '{}')).toEqual({ [id]: '002' });
    pending[2]?.(new Response());
    await third;
  });
  it('keeps bookmark state separate for each origin', async () => {
    const seen: Array<string | null> = [];
    const wrapped = createD1BookmarkFetch(async (input) => {
      const request = new Request(input);
      seen.push(request.headers.get('X-Dee-Wan-D1-Bookmarks'));
      return new Response(null, { headers:request.url.startsWith('https://one.test/') ? { 'X-Dee-Wan-D1-Bookmarks':JSON.stringify({ [id]:'001' }) } : {} });
    });
    await wrapped('https://one.test/');
    await wrapped('https://two.test/');
    await wrapped('https://one.test/again');
    expect(seen).toEqual([null, null, JSON.stringify({ [id]:'001' })]);
  });
  it('restores stored bookmarks across helper instances and merges newer stored replies', async () => {
    const data = new Map<string, string>();
    const storage = { getItem:(key: string) => data.get(key) ?? null, setItem:(key: string, value: string) => { data.set(key, value); } };
    const pending: Array<(response: Response) => void> = [];
    const observed: Array<string | null> = [];
    const fetcher: typeof fetch = (input) => {
      observed.push(new Request(input).headers.get('X-Dee-Wan-D1-Bookmarks'));
      return new Promise<Response>((resolve) => pending.push(resolve));
    };
    const one = createD1BookmarkFetch(fetcher, { storage });
    const two = createD1BookmarkFetch(fetcher, { storage });
    const first = one('https://one.test/');
    const second = two('https://one.test/');
    pending[1]?.(new Response(null, { headers:{ 'X-Dee-Wan-D1-Bookmarks':JSON.stringify({ [id]:'002' }) } }));
    await second;
    pending[0]?.(new Response(null, { headers:{ 'X-Dee-Wan-D1-Bookmarks':JSON.stringify({ [id]:'001' }) } }));
    await first;
    const restored = createD1BookmarkFetch(fetcher, { storage });
    const third = restored('https://one.test/');
    expect(JSON.parse(observed[2] ?? '{}')).toEqual({ [id]:'002' });
    pending[2]?.(new Response());
    await third;
  });
});
