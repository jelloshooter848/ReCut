# Quit is stuck for ever when the renderer dies or hangs after acking the quit request

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | app lifecycle (main process quit flow) |
| Reported by / date | Claude (agent), 2026-10-08 (follow-up of 2026-10-08-e2e-close-hangs-on-quit-prompt.md) |
| Found on commit | 888c4d2 |
| Environment | Linux 6.18 (xvfb), Electron 33.4.11, source build |

## Report

### Summary
Main asks the renderer before quitting (`ev:beforeQuit`) and drops its 3 s hung-renderer fallback as soon as the
renderer acks, because the renderer may then show Save / Don't Save / Cancel. If the renderer process crashes or
hangs after the ack, `quitPending` stays true: the app neither quits nor can be asked again (every further quit
request returns early), and the user has to kill it.

### Steps to reproduce
1. Make an edit (the project is dirty).
2. Quit: the "Save changes?" prompt is up (the renderer acked).
3. Crash the renderer (`webContents.forcefullyCrashRenderer()`, or a GPU / OOM crash).
4. Quit again (menu, window close).

Automated: tests/e2e/quit.spec.ts "the renderer crashes while its quit prompt is up: the app exits".

### Expected
The app quits (nothing is left that could save or lose work; an autosave, if any, is offered on the next launch).

### Actual
```
✘ quit.spec.ts › the renderer crashes while its quit prompt is up: the app exits (16.0s)
  Error: the app did not quit after its renderer crashed
```

### Suspected cause (hypothesis)
electron/main.ts `requestQuit` / `ackQuit`: nothing clears `quitPending` except `quitCancel` from the renderer, and
main does not listen to `render-process-gone`, `unresponsive` or the window's `closed` for the quit.

### Scope
Any renderer death or hang after the ack: crash, kill, OOM, a page reload while the prompt is up, a renderer stuck
in a long task.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 888c4d2 |
| Verdict | confirmed |

The e2e test fails on 888c4d2 as under Actual: 15 s after the crash the process is still running. The hypothesis
was right.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | branch `claude/fix-quit-save-robustness` |
| Files changed | electron/quitFlow.ts (new), electron/main.ts, docs/ARCHITECTURE.md, tests/unit/quit-flow.test.ts (new), tests/e2e/quit.spec.ts |
| Regression test | tests/unit/quit-flow.test.ts (all); tests/e2e/quit.spec.ts › the renderer crashes while its quit prompt is up: the app exits; › a second quit request while a live renderer shows its prompt does not quit behind it |

### Root cause
The quit request's state lived in main.ts flags that only the renderer could clear after its ack (`quit(true)` or
`quitCancel`). A renderer that died or hung after the ack could do neither, and main never looked at the renderer's
health.

### Fix
The quit flow is a small pure state machine, electron/quitFlow.ts (idle → asked → acked), driven by main.ts with
Electron events instead of timeouts:
- `render-process-gone` (any reason) or the window's `closed` while a quit is pending → finish the quit at once.
  Nobody is left to answer the prompt or to save; work not in the file is whatever the last autosave holds.
  A quit request while the renderer is gone (no quit pending) also quits at once instead of waiting 3 s.
- `unresponsive` after the ack → main asks "ReCut is not responding. Quit anyway?" (Wait / Quit, default Wait).
  Never decided for the user: a busy renderer may come back to its prompt. `responsive` withdraws the question
  (closed through its AbortSignal; a late "Quit" is ignored), and so do quit(true) / quitCancel.
- A second quit request after the ack: with the renderer alive (its prompt is up) it only brings the window
  forward, however long the prompt waits; with the renderer unresponsive it asks "Quit anyway?" again.
- `did-finish-load` (a reloaded page) while a quit is pending asks the new page again (its handler is gone).
- Unchanged: the 3 s fallback before the ack, `quit(true)`, `quitCancel`, force quits (smoke test, last window
  closed).

### Before / after
Before: renderer crash after the ack → the app keeps running, quit requests are ignored. After: the app exits as
soon as the renderer is gone (the e2e test passes in 0.9 s, launch included). With a live renderer and its
prompt up, repeated quit requests still never quit behind it (e2e: the app is alive 4 s after the second request,
past the 3 s fallback, prompt asked once; Don't Save then quits).

### Regression test proof
On 888c4d2 (quit.spec.ts against the old build):
```
✘ 2 tests/e2e/quit.spec.ts:105:5 › the renderer crashes while its quit prompt is up: the app exits (16.0s)
    Error: the app did not quit after its renderer crashed
✓ 3 tests/e2e/quit.spec.ts:116:5 › a second quit request while a live renderer shows its prompt does not quit behind it (5.3s)
```
The second test guards the "never quit behind a live prompt" rule and passes before and after. With the fix both
pass; tests/unit/quit-flow.test.ts 18/18 (the module is new).

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 115 files, 2011 passed, 2 skipped (tests/unit/quit-flow.test.ts 18/18).
- e2e (Linux, xvfb): quit.spec.ts 3/3, lifecycle.spec.ts 9/9 (incl. "quit prompt: Cancel keeps the app open past the
  3 s fallback; the next quit prompts again"), project.spec.ts 8/8, teardown.spec.ts 1/1, gauntlet.spec.ts 4/4
  (its mid-test real quits and relaunches).

### Changed existing assertions
None.

### Compatibility risks
None for files. Behaviour: a renderer that is unresponsive while quitting now gets a main-process question; e2e
helpers that stub `dialog.showMessageBox` pass boxes without a "Don't Save" button through to the real one.

### Follow-ups
None.
