# Whisper model downloads refused: Hugging Face now redirects to us.aws.cdn.hf.co, not the one allowed host

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (Transcription Models › Install fails for every model on every platform; **Install from file…** works) |
| Area | speech-to-text / downloads (electron/net/download.ts, shared/whisper.ts) |
| Reported by / date | GitHub issue #102, 2026-10-09 |
| Found on commit | 8830704 (ReCut 0.8.0) |
| Environment | Reporter: macOS Tahoe 26.6.2, Apple Silicon, ReCut 0.8.0 dmg. Reproduced on GitHub Actions ubuntu-22.04 and macos-14 (arm64 and x64 legs) |

## Report

### Summary
File › Transcription Models… › **Install** fails with an error for every model. Reported on macOS (Apple Silicon); the
cause is not macOS-specific, so Windows and Linux are affected the same way.

### Steps to reproduce
1. ReCut 0.8.0, File › Transcription Models….
2. Select any model, click **Install**.

### Expected
The model downloads (progress in the job), its SHA-256 is checked and it is installed.

### Actual
The job fails at once. The reporter's screenshot could not be fetched (403), so the exact text is not on record; on
0.8.0 the toast reads "Could not install the <Model> transcription model: refusing redirect to https://<host>", where
<host> is the storage host Hugging Face redirected to (us.aws.cdn.hf.co from GitHub's US runners).

### Evidence
`scripts/check-model-redirects.mjs` (added for this bug) requests the first byte of every pinned model with the app's
own redirect loop and policy. Run on the 0.8.0 policy in
[windows.yml run 37943851579](https://github.com/jelloshooter848/ReCut/actions/runs/37943851579), 2026-10-09 14:24 UTC,
identical on all three runners (Linux x64 job 113864882544; macOS arm64 job 113864883096; macOS x64 leg, which runs
Node arm64 on the same Apple Silicon runner, job 113864883274):

```
Whisper model tiny: https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin
  hop 1  HTTP 302  huggingface.co                     allowed  https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c.../ggml-tiny.bin
  hop 2  HTTP 206  us.aws.cdn.hf.co                   REFUSED by the app policy  https://us.aws.cdn.hf.co/xet-bridge-us/641ab5d15d107c5c5f346372/518970a2...
  app: FAILED: refusing redirect to https://us.aws.cdn.hf.co
... (the same two hops for base, base.en, small, small.en, medium, large-v3-turbo)
OCR language eng:     hop 1  HTTP 206  raw.githubusercontent.com  allowed; app: ok, size 4113088
OCR language chi_sim: hop 1  HTTP 206  raw.githubusercontent.com  allowed; app: ok, size 2469156
7 of 9 downloads FAILED the app's download policy (linux x64).      [and (darwin arm64) on both macOS legs]
```

### Suspected cause (hypothesis)
The cross-host redirect allow-list was one exact host, `WHISPER_REDIRECT_HOSTS = ['cas-bridge.xethub.hf.co']`
(shared/whisper.ts), enforced by `isAllowedRedirect` (electron/net/download.ts).

### Scope
OCR language downloads use the same downloader with a same-origin-only policy; raw.githubusercontent.com answers
directly (no redirect), so they are unaffected (see the evidence). No stall timeout: a download that stops receiving
data hangs forever.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-09 |
| Verified on commit | 50f1f94 (8830704 plus the check script, policy unchanged) |
| Verdict | confirmed |

Hugging Face's `resolve/` URL for every pinned model answers `302` to `https://us.aws.cdn.hf.co/xet-bridge-us/...`
from GitHub's US runners (Linux and macOS), and the 0.8.0 policy refuses that host. The previously allowed
`cas-bridge.xethub.hf.co` no longer appears in the chain. The storage host depends on region and changes over time,
so a reporter elsewhere may see another `*.hf.co` host; every such host was refused too. The other hypotheses (a
network error, the macOS engine check) were not needed: the refusal happens on every runner before any data flows.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-09 |
| Fix | branch claude/fix-whisper-model-download |
| Files changed | shared/whisper.ts, electron/net/download.ts, electron/whisper/models.ts, scripts/check-model-redirects.mjs, .github/workflows/windows.yml, tests/unit/whisper-models.test.ts, docs/USER-GUIDE.md, docs/ARCHITECTURE.md |
| Regression test | tests/unit/whisper-models.test.ts::Hugging Face redirects through the production policy (issue #102) > installs a model Hugging Face redirects to us.aws.cdn.hf.co (the old exact-host list refused it); CI: scripts/check-model-redirects.mjs in the linux and macos jobs |

### Root cause
The Whisper download policy allowed exactly one redirect host, `cas-bridge.xethub.hf.co`. Hugging Face moved its
model storage redirects to regional CDN hosts (`us.aws.cdn.hf.co` from the US), so the downloader refused the
redirect before downloading anything. Nothing caught it: the unit and e2e tests use a loopback server, and CI fetched
its test model with curl, which follows any redirect.

### Fix
- `DownloadPolicy.redirectDomains` (electron/net/download.ts): a redirect may go over https, on the default port,
  without credentials, to a domain or any subdomain of it. `isHostInDomain` compares at a label boundary
  (`h === d || h.endsWith('.' + d)`, no empty labels, no trailing dot), so `huggingface.co.evil.com`, `evilhf.co`
  and `xhuggingface.co` are refused. Same-origin redirects, the 5-redirect limit, the http-downgrade refusal and the
  pinned size and SHA-256 (the real integrity guarantee) are unchanged.
- The Whisper policy allows `huggingface.co` and `hf.co` and their subdomains (`WHISPER_REDIRECT_DOMAINS`), which
  covers us.aws.cdn.hf.co, cas-bridge.xethub.hf.co, cdn-lfs*.hf.co / cdn-lfs.huggingface.co and future regional or
  Xet hosts. The OCR policy is unchanged (same-origin only; it does not share the flaw).
- Plain-words errors (job error and toast): "Hugging Face redirected the download to <host>, which ReCut doesn't
  allow (refusing redirect to <origin>)", "… <host> over plain http …", "… redirected the download more than 5
  times", "download failed: HTTP 404 Not Found from <host>", "network error: could not reach <host> (…)". A refusal
  is a `DownloadRefusedError`.
- Stall timeout: a download attempt that receives nothing (no response while connecting or between redirects, no body
  bytes) for 60 s (`DOWNLOAD_STALL_MS`, injectable as `stallTimeoutMs`) aborts the request and fails with "network
  error: the download stalled (no data for 60 s)", keeping the `.part` so **Resume** continues it. Cancel still wins
  and removes the `.part`.
- `openFollowingRedirects` (the redirect loop, now exported) is what `scripts/check-model-redirects.mjs` runs in the
  linux and macos CI jobs against the real servers (first byte only, retries a network error or 5xx once, never a
  refusal), so a storage move on Hugging Face's side fails CI before users hit it.

### Before / after
Before: every model install fails with "refusing redirect to https://us.aws.cdn.hf.co"; the check script reports
7 of 9 downloads failing on Linux and both macOS legs. After: the chain huggingface.co → us.aws.cdn.hf.co is accepted
and the model installs (see the CI run of the fix commit, step "Download redirect check").

### Regression test proof
With the 0.8.0 policy (`redirectHosts: ['cas-bridge.xethub.hf.co']`) restored in electron/whisper/models.ts:

```
× Hugging Face redirects through the production policy (issue #102) > installs a model Hugging Face redirects to us.aws.cdn.hf.co (the old exact-host list refused it)
  → The server redirected the download to us.aws.cdn.hf.co, which ReCut doesn't allow (refusing redirect to https://us.aws.cdn.hf.co): expected 'failed' to be 'done'
```

With the fix: passes. The test drives the real installer (`startModelInstallJob`, no `baseUrl`, so the real pinned
https URL and the production policy without the loopback allowance) through a fetch with a fake DNS that maps
`https://<host>/<path>` to a loopback server answering like Hugging Face (302 to us.aws.cdn.hf.co, then the file).

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 120 files, 2056 passed, 3 skipped.
- `tests/e2e/whisper.spec.ts` (xvfb, locally built engine): 3/3. `tests/e2e/ocr*.spec.ts` (same downloader): 4/4.
- CI: windows.yml on claude/fix-whisper-model-download (see the branch's latest run).

### Changed existing assertions
tests/unit/whisper-models.test.ts "download policy": `WHISPER_REDIRECT_HOSTS` equalled `['cas-bridge.xethub.hf.co']`
and `https://cdn-lfs.huggingface.co/x` and `https://evil.xethub.hf.co/x` were asserted refused. Those assertions
encoded the bug (Hugging Face's own hosts refused); they now assert `WHISPER_REDIRECT_DOMAINS` and that every
`*.hf.co` / `*.huggingface.co` host is accepted, while look-alikes, http, other ports and credentials stay refused.

### Compatibility risks
None for projects or exports. A partial download left by 0.8.0 (none can exist: it failed before writing) resumes as
before. The policy is wider (any Hugging Face subdomain), but the file is still accepted only with the pinned size
and SHA-256.

### Follow-ups
None filed. If the reporter's error turns out to be something else (the issue's screenshot), reopen with its text.
