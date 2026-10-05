# <Short title: what goes wrong, where>

<!-- Copy to bugs/open/YYYY-MM-DD-short-slug.md. Fill in Report when filing. Verification and Resolution are filled
     in by whoever works the bug. Delete these comments. -->

| Field | Value |
|---|---|
| Status | open <!-- open · in-progress · fixed · disproven · cannot-reproduce · duplicate · wont-fix --> |
| Severity | <!-- critical · high · medium · low (see bugs/README.md) --> |
| Area | <!-- export · timeline · project I/O · media/FFmpeg · playback · UI · subtitles · packaging · ... --> |
| Reported by / date | <!-- agent or person, YYYY-MM-DD --> |
| Found on commit | <!-- git rev-parse --short HEAD --> |
| Environment | <!-- OS, FFmpeg version (ffmpeg -version), packaged app or source --> |

## Report

### Summary
<!-- One or two sentences: what is wrong and who it affects. -->

### Steps to reproduce
1.
2.
3.

<!-- Prefer a failing test or a script. Link it (tests/...) or paste it in a fenced block. -->

### Expected

### Actual
<!-- Exact error text, wrong values, frame numbers, file sizes. Paste output; don't paraphrase. -->

### Evidence
<!-- Failing test output, logs, ffprobe output, screenshots (path), project file snippet. -->

### Suspected cause (hypothesis)
<!-- Optional. File:line and reasoning. This is not verified until the Verification section says so. -->

### Scope
<!-- Related code paths or variants that may have the same defect. -->

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | |
| Verified on commit | |
| Verdict | <!-- confirmed · partially confirmed · disproven · cannot reproduce · duplicate of <file> --> |

<!-- How it was reproduced (or what was tried), and whether the suspected cause was right. -->

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | |
| Fix | <!-- commit sha and/or PR link --> |
| Files changed | |
| Regression test | <!-- path::test name --> |

### Root cause

### Fix
<!-- What changed and why this is the smallest correct fix. -->

### Before / after
<!-- Behaviour before and after, with numbers where they apply. -->

### Regression test proof
<!-- Output of the new test failing on the old code, and passing on the fix. -->

### Tests run
<!-- Suites and exact counts, e.g. "npm test: 957/957; attack: 102/102". Name any suite that could not run and why. -->

### Changed existing assertions
<!-- None, or each changed assertion and why it encoded the bug. -->

### Compatibility risks
<!-- Effects on saved projects, exports, frame rates, subtitles, file names. "None" if none. -->

### Follow-ups
<!-- Related defects found but not fixed here: file a new report for each and link it. -->
