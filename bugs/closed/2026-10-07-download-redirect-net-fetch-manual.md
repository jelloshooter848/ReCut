# Verified downloads fail on any HTTP redirect in the app (net.fetch rejects redirect: 'manual')

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (latent for OCR languages: raw.githubusercontent.com does not redirect today; every Whisper model download redirects, so it would have blocked §5) |
| Area | media/FFmpeg · downloads (OCR languages, Whisper models) |
| Reported by / date | claude/whisper agent, 2026-10-07 |
| Found on commit | `2a61a71` (claude/whisper; the downloader is unchanged from 0.6.0) |
| Environment | Linux, Electron 33.4 (the app's `net.fetch`); unpackaged and packaged |

## Report

### Summary
The verified downloader follows redirects by hand: it calls the HTTP client with `redirect: 'manual'` and expects the
3xx response back, so it can check the new host before following it. The app passed Electron's `net.fetch` as that
client. With `redirect: 'manual'`, `net.fetch` does not return the 3xx response: it rejects with "Redirect was
cancelled". Any redirect therefore failed the download with "network error: Redirect was cancelled". The unit tests
did not see it because they pass Node's `fetch`, which returns the 3xx response.

### Steps to reproduce
Run under Electron (`npx electron main.js`):

```js
const { app, net } = require('electron');
const http = require('node:http');
app.whenReady().then(async () => {
  const s = http.createServer((q, r) => { r.writeHead(302, { location: '/t' }); r.end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { await net.fetch(`http://127.0.0.1:${s.address().port}/r`, { redirect: 'manual' }); } catch (e) { console.log(e.message); }
  app.quit();
});
```

### Expected
A response with status 302 and a `location` header (what `fetch` returns in Node and in browsers, as an unfiltered
response for Node).

### Actual
`Redirect was cancelled`

### Scope
Every `downloadVerified` call in the app: OCR language installs (`electron/ocr/languages.ts`) and Whisper model
installs (`electron/whisper/models.ts`; Hugging Face answers every model URL with a redirect to its storage host).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | claude/whisper agent, 2026-10-07 |
| Verified on commit | `2a61a71` |
| Verdict | confirmed |

Reproduced with the script above (prints "Redirect was cancelled").

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | claude/whisper agent, 2026-10-07 |
| Fix | claude/whisper, "Downloads in the app use net.request with manual redirects (net.fetch rejects them)" |
| Files changed | `electron/net/electronFetch.ts` (new), `electron/main.ts` |
| Regression test | `tests/unit/electron-fetch.test.ts` (adapter, fake `net.request`); the e2e specs `tests/e2e/ocr-languages.spec.ts` and `tests/e2e/whisper.spec.ts` install through the app's client |

### Root cause
`net.fetch` implements `redirect: 'manual'` by cancelling the redirect, not by returning it.

### Fix
`manualRedirectFetch` wraps Electron's `net.request` (same network stack, proxy and certificates as `net.fetch`) in
the `fetch` shape the downloader uses: on the `redirect` event it aborts the request and returns a bodyless response
with the 3xx status and `location`; otherwise it returns the response with a pull-based body stream (the socket is
paused while the downloader writes, so memory stays bounded for a 1.6 GB model). main.ts passes it to the media layer
instead of `net.fetch`. The downloader itself is unchanged.

### Before / after
Before: a redirected download failed with "network error: Redirect was cancelled". After (checked inside Electron with
the real `net.request`): a redirect to a host the policy allows is followed and the file verified; one to any other
host is refused ("refusing redirect to http://localhost:…"); a partial file resumes with `Range`; cancel removes the
`.part`.

### Tests run
`npm test`: all passing (see the branch report); `tests/unit/electron-fetch.test.ts` 4/4.

### Changed existing assertions
None.

### Compatibility risks
None for projects. Downloads now go through `net.request`, which shares `net.fetch`'s session, proxy and certificate
handling.

### Follow-ups
None.
