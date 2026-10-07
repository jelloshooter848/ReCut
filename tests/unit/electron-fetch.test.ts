/**
 * The app's download client (electron/net/electronFetch.ts) with a fake `net.request`: a redirect comes back as a 3xx
 * response with its location (never followed), a body streams with backpressure, headers are passed on, and abort
 * works before and during the body. (Checked against Electron's real net.request during development; Electron's own
 * net.fetch rejects manual redirects, which is why the adapter exists.)
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { manualRedirectFetch, type NetClientRequest, type NetIncomingMessage, type NetRequestFn } from '../../electron/net/electronFetch';

class FakeRes extends EventEmitter {
  paused = 0;
  resumed = 0;
  constructor(public statusCode: number, public headers: Record<string, string | string[]>, public statusMessage = 'OK') { super(); }
  pause() { this.paused++; return this; }
  resume() { this.resumed++; return this; }
}

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  aborted = false;
  ended = false;
  setHeader(k: string, v: string) { this.headers[k] = v; }
  abort() { this.aborted = true; }
  end() { this.ended = true; }
}

function setup() {
  const reqs: { opts: Parameters<NetRequestFn>[0]; req: FakeReq }[] = [];
  const request: NetRequestFn = (opts) => {
    const req = new FakeReq();
    reqs.push({ opts, req });
    return req as unknown as NetClientRequest;
  };
  return { reqs, fetch: manualRedirectFetch(request) };
}

describe('manualRedirectFetch', () => {
  it('returns a redirect as a 3xx response with its location, without following it', async () => {
    const { reqs, fetch } = setup();
    const p = fetch('https://huggingface.co/x', { headers: { range: 'bytes=5-' } });
    const { opts, req } = reqs[0];
    expect(opts).toEqual({ url: 'https://huggingface.co/x', method: 'GET', redirect: 'manual', cache: 'no-store' });
    expect(req.headers).toEqual({ range: 'bytes=5-' });
    expect(req.ended).toBe(true);
    req.emit('redirect', 302, 'GET', 'https://cas-bridge.xethub.hf.co/y?sig=1', { 'x-repo': ['a'] });
    const res = await p;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://cas-bridge.xethub.hf.co/y?sig=1');
    expect(res.headers.get('x-repo')).toBe('a');
    expect(req.aborted).toBe(true);
    expect(reqs).toHaveLength(1);
  });

  it('streams the body with backpressure and passes status and headers on', async () => {
    const { reqs, fetch } = setup();
    const p = fetch('https://x/f');
    const res0 = new FakeRes(206, { 'content-range': 'bytes 0-99/100', 'content-length': '100' }, 'Partial Content');
    reqs[0].req.emit('response', res0 as unknown as NetIncomingMessage);
    const res = await p;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/100');
    for (let i = 0; i < 40; i++) res0.emit('data', Buffer.from([i]));
    expect(res0.paused).toBeGreaterThan(0);
    res0.emit('end');
    const got = new Uint8Array(await res.arrayBuffer());
    expect([...got]).toEqual([...Array(40).keys()]);
    expect(res0.resumed).toBeGreaterThan(0);
  });

  it('aborts before the response (rejects) and during the body (the stream errors)', async () => {
    const { reqs, fetch } = setup();
    const ac = new AbortController();
    const p = fetch('https://x/a', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(reqs[0].req.aborted).toBe(true);

    const ac2 = new AbortController();
    const p2 = fetch('https://x/b', { signal: ac2.signal });
    const r = new FakeRes(200, {});
    reqs[1].req.emit('response', r as unknown as NetIncomingMessage);
    const res = await p2;
    const reader = res.body!.getReader();
    r.emit('data', Buffer.from('abc'));
    expect((await reader.read()).value).toEqual(new Uint8Array([97, 98, 99]));
    ac2.abort();
    await expect(reader.read()).rejects.toThrow(/aborted/);
    expect(reqs[1].req.aborted).toBe(true);

    const ac3 = new AbortController();
    ac3.abort();
    await expect(fetch('https://x/c', { signal: ac3.signal })).rejects.toThrow(/aborted/);
  });

  it('a network error rejects; a connection closed mid-body errors the stream', async () => {
    const { reqs, fetch } = setup();
    const p = fetch('https://x/a');
    reqs[0].req.emit('error', new Error('net::ERR_CONNECTION_RESET'));
    await expect(p).rejects.toThrow('net::ERR_CONNECTION_RESET');
    const p2 = fetch('https://x/b');
    const r = new FakeRes(200, {});
    reqs[1].req.emit('response', r as unknown as NetIncomingMessage);
    const res = await p2;
    r.emit('aborted');
    await expect(res.arrayBuffer()).rejects.toThrow(/closed before the download finished/);
  });
});
