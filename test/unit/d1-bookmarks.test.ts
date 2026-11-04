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
  it('advances an opted-in floor only for successful writes and explicit fresh reads', async () => {
    const seen: Array<{ path: string; floor: string | null }> = [];
    const data = new Map<string, string>();
    const storage = { getItem:(key: string) => data.get(key) ?? null, setItem:(key: string, value: string) => { data.set(key, value); } };
    const responseFor = (bookmark: string, status = 200) => new Response(null, { status, headers: { 'X-Dee-Wan-D1-Bookmarks': JSON.stringify({ [id]:bookmark }) } });
    const replies = [responseFor('001'), responseFor('002'), responseFor('003', 409), responseFor('004'), responseFor('005'), responseFor('006'), responseFor('007'), responseFor('008'), responseFor('009')];
    const wrapped = createD1BookmarkFetch(async (input) => {
      const request = new Request(input);
      seen.push({ path:new URL(request.url).pathname, floor:request.headers.get('X-Dee-Wan-D1-Bookmarks') });
      const response = replies.shift();
      if (!response) throw new Error('unexpected request');
      return response;
    }, { storage, advanceOn:'mutations-and-fresh-reads', freshnessHeader:'X-Dee-Wan-Fresh', excludedPaths:['/api/presence', '/api/presence/*', '/api/working-drafts'] });
    const get = (path: string, init?: RequestInit) => wrapped(`https://one.test${path}`, init);
    const first = await get('/api/read');
    expect(first.headers.get('X-Dee-Wan-D1-Bookmarks')).toBe(JSON.stringify({ [id]:'001' }));
    await get('/api/other', { headers:{ 'Cache-Control':'no-cache' } });
    await get('/api/content', { method:'POST' });
    await get('/api/content', { method:'POST' });
    await get('/api/read');
    await get('/api/presence/session', { method:'POST' });
    await get('/api/working-drafts', { headers:{ 'X-Dee-Wan-Fresh':'1' } });
    await get('/api/read', { headers:{ 'X-Dee-Wan-Fresh':'1' } });
    await get('/api/read');
    const floors = seen.map(({ floor }) => floor ? JSON.parse(floor) : null);
    expect(floors).toEqual([null, null, null, null, { [id]:'004' }, { [id]:'004' }, { [id]:'004' }, { [id]:'004' }, { [id]:'008' }]);
    expect(JSON.parse(data.get('dee-wan:d1-bookmarks:https://one.test') ?? '{}')).toEqual({ [id]:'008' });
  });

  it('retains caller-supplied and stored floors even for excluded reads and transport failures', async () => {
    const data = new Map<string, string>();
    const storage = { getItem:(key: string) => data.get(key) ?? null, setItem:(key: string, value: string) => { data.set(key, value); } };
    const seen: Array<string | null> = [];
    const wrapped = createD1BookmarkFetch(async (input) => {
      seen.push(new Request(input).headers.get('X-Dee-Wan-D1-Bookmarks'));
      if (seen.length === 1) throw new Error('network');
      return new Response(null, { headers:{ 'X-Dee-Wan-D1-Bookmarks':JSON.stringify({ [id]:'999' }) } });
    }, { storage, advanceOn:'mutations-and-fresh-reads', freshnessHeader:'X-Dee-Wan-Fresh', excludedPaths:['/api/presence/*'] });
    const supplied = JSON.stringify({ [id]:'012' });
    await expect(wrapped('https://one.test/api/presence/a', { headers:{ 'X-Dee-Wan-D1-Bookmarks':supplied } })).rejects.toThrow('network');
    const restored = createD1BookmarkFetch(async (input) => {
      seen.push(new Request(input).headers.get('X-Dee-Wan-D1-Bookmarks'));
      return new Response();
    }, { storage, advanceOn:'mutations-and-fresh-reads', freshnessHeader:'X-Dee-Wan-Fresh' });
    await wrapped('https://one.test/api/presence/a', { method:'POST' });
    await restored('https://one.test/api/other');
    expect(seen).toEqual([supplied, supplied, supplied]);
  });

  it('does not advance an opted-in floor for a refused explicit fresh read', async () => {
    const seen: Array<string | null> = [];
    const wrapped = createD1BookmarkFetch(async (input) => {
      seen.push(new Request(input).headers.get('X-Dee-Wan-D1-Bookmarks'));
      return new Response(null, { status: seen.length === 1 ? 409 : 200, headers:{ 'X-Dee-Wan-D1-Bookmarks':JSON.stringify({ [id]:'999' }) } });
    }, { advanceOn:'mutations-and-fresh-reads', freshnessHeader:'X-Dee-Wan-Fresh' });
    await wrapped('https://one.test/api/read', { headers:{ 'X-Dee-Wan-Fresh':'1' } });
    await wrapped('https://one.test/api/read');
    expect(seen).toEqual([null, null]);
  });

  it('keeps a caller-only floor request-local in the default mode', async () => {
    const seen: Array<string | null> = [];
    const wrapped = createD1BookmarkFetch(async (input) => {
      seen.push(new Request(input).headers.get('X-Dee-Wan-D1-Bookmarks'));
      return new Response();
    });
    const supplied = JSON.stringify({ [id]:'123' });
    await wrapped('https://one.test/api/read', { headers:{ 'X-Dee-Wan-D1-Bookmarks':supplied } });
    await wrapped('https://one.test/api/read');
    expect(seen).toEqual([supplied, null]);
  });

});
