# Bug reports

One Markdown file per bug. Agents and people file reports here; whoever fixes or disproves a bug closes the same file.

```
bugs/
  TEMPLATE.md   copy this to start a report
  open/         reported, not yet resolved
  closed/       fixed, disproven, duplicate or won't fix
```

## Filing a bug

1. Check `open/` and `closed/` for an existing report (search for the file, function or symptom). Add to it instead of
   filing a duplicate.
2. Copy `TEMPLATE.md` to `open/YYYY-MM-DD-short-slug.md`, e.g. `open/2026-10-05-sidecar-overwrites-srt.md`. The file
   name is the bug's ID. Dates and slugs keep IDs unique when several agents file at once.
3. Fill in the **Report** section only. Leave **Verification** and **Resolution** empty.
4. Set `Status: open`.

A good report:
- Names the commit it was found on (`git rev-parse --short HEAD`), the OS and the FFmpeg version when media is
  involved.
- Gives steps someone else can follow, ideally a failing test or a script (put long repros in a fenced block or under
  `tests/` and link it). "Sometimes" is not a repro; say how often and under what load.
- Separates what you observed from what you think the cause is. The suspected cause is a hypothesis, not a fact.
- Picks a severity from the table below and says what a user would lose or see.

| Severity | Meaning |
|---|---|
| critical | Data loss or corruption: source media, project files or exports destroyed; crash on launch. |
| high | A core workflow is broken or produces wrong output (wrong frames, A/V drift, wrong timecode), no workaround. |
| medium | Wrong behaviour with a workaround, or a crash in an uncommon path. |
| low | Cosmetic, misleading text, minor inconsistency, edge case with no real-world impact. |

## Working a bug

1. Set `Status: in-progress` and fill **Verification**: reproduce it on the current branch and record the verdict.
   Treat the report as a hypothesis. If it does not reproduce, say exactly what you tried.
2. Write a regression test that fails before the fix, and record the failing output.
3. Make the smallest correct fix. Never weaken, skip or delete an existing test to get green; if an existing assertion
   encoded the bug, change it and say so in the resolution.
4. Run `npm run typecheck` and `npm test`, plus any suite that covers the area (see `docs/DEVELOPMENT.md`).

## Closing a bug

1. Fill **Resolution** completely: root cause, fix, regression test, before/after, tests run, compatibility risks.
2. Set `Status` to one of: `fixed`, `disproven`, `cannot-reproduce`, `duplicate` (link the other report),
   `wont-fix` (say why).
3. Move the file: `git mv bugs/open/<file> bugs/closed/<file>`, in the same commit or PR as the fix.

A bug is closed only when its regression test is merged with the fix. `disproven` and `cannot-reproduce` need the
evidence that shows it, for example the test you wrote that passes on the current code.
