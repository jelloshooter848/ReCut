/**
 * Transcript search → Source → Insert → Subtitles panel → export, against the real Electron app.
 * Run: npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/transcript.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, ROOT } from './helpers';

interface SourceClip { mediaId: string; inPoint: number | null; outPoint: number | null; time: number }
interface Clip { id: string; mediaId: string; start: number; duration: number; sourceIn: number; originLabel?: string }
interface SeqCue { id: string; clipId?: string; srcStart?: number; srcEnd?: number; offset: number; text: string }
interface SeqState { fps: { num: number; den: number }; clips: Clip[]; tracks: { id: string; language: string; cues: SeqCue[] }[]; playhead: number }

async function sequenceState(page: Page): Promise<SeqState> {
  return getState<SeqState>(page, `(s) => {
    const seq = s.project.sequences[s.project.activeSequenceId];
    return {
      fps: seq.fps,
      clips: [...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.clips).map((c) => ({ id: c.id, mediaId: c.mediaId, start: c.start, duration: c.duration, sourceIn: c.sourceIn, originLabel: c.originLabel })),
      tracks: seq.subtitleTracks.map((t) => ({ id: t.id, language: t.language, cues: t.cues.map((c) => ({ id: c.id, clipId: c.clipId, srcStart: c.srcStart, srcEnd: c.srcEnd, offset: c.offset, text: c.text })) })),
      playhead: seq.view.playhead,
    };
  }`);
}

async function openPanel(page: Page, title: 'Transcript' | 'Subtitles') {
  const tab = page.locator('.zone-tab', { hasText: title }).first();
  await tab.click();
  await expect(page.getByTestId(title === 'Transcript' ? 'transcript-panel' : 'subtitles-panel')).toBeVisible();
}

test.describe('Transcript search and Subtitles', () => {
  test('find a line across episodes, load it, insert it, edit and export the sequence subtitles', async () => {
    const { app, page, tmp } = await launchApp();
    try {
      const dir = makeTestMedia(tmp, 'short');
      const episodes = [MEDIA.ep1, MEDIA.ep2, MEDIA.ep3].map((p) => path.join(dir, p));
      const ids = await importMedia(page, episodes);
      expect(ids).toHaveLength(3);

      // Attach the matching SRT to each episode through the real import path.
      for (let i = 0; i < ids.length; i++) {
        const srt = path.join(dir, MEDIA.srt(path.basename(episodes[i], '.mp4')));
        expect(fs.existsSync(srt)).toBe(true);
        const res = await page.evaluate(([id, p]) => {
          const w = window as unknown as { __recut: { actions: { importSubtitleFile(id: string, p: string): Promise<{ trackId: string | null; warnings: string[] }> } } };
          return w.__recut.actions.importSubtitleFile(id, p);
        }, [ids[i], srt] as const);
        expect(res.trackId).toBeTruthy();
      }

      // ---- Transcript panel: search "doctor" across the project
      await openPanel(page, 'Transcript');
      await expect(page.getByTestId('transcript-stats')).toContainText('3 media with transcripts');
      await expect(page.getByTestId('transcript-stats')).toContainText('9 cues');
      const search = page.getByTestId('transcript-search');
      await search.fill('doctor');
      await expect(page.getByTestId('transcript-scope')).toHaveValue('project');
      await expect(page.getByTestId('transcript-count')).toHaveText(/4 results in 3 media/);

      const results = page.getByTestId('transcript-result');
      await expect(results).toHaveCount(4);
      const mediaIds = new Set<string>();
      for (let i = 0; i < 4; i++) mediaIds.add((await results.nth(i).getAttribute('data-media-id'))!);
      expect(mediaIds.size).toBeGreaterThanOrEqual(2);
      expect(await page.locator('.tr-group').count()).toBe(3);

      // Timecodes at the media rate (24 fps): E01 cues start at 5s and 9s, E02/E03 at 1s.
      const tcs = await page.getByTestId('transcript-result-tc').allTextContents();
      expect(tcs).toEqual(['00:00:05:00', '00:00:09:00', '00:00:01:00', '00:00:01:00']);
      const texts = await page.getByTestId('transcript-result-text').allTextContents();
      expect(texts).toEqual(['Where is the doctor?', 'The doctor is in the lab.', 'The doctor has a secret.', 'Nobody trusts the doctor now.']);
      await expect(results.first().locator('mark')).toHaveText('doctor');

      // ---- Click a result → loads in Source with in/out around the cue
      const first = results.first();
      const ep1Id = (await first.getAttribute('data-media-id'))!;
      await first.click();
      const sc = await getState<SourceClip | null>(page, '(s) => s.ui.sourceClip');
      expect(sc).not.toBeNull();
      expect(sc!.mediaId).toBe(ep1Id);
      expect(sc!.time).toBeCloseTo(5, 1); // the Source player may snap to the decoded frame
      expect(sc!.inPoint).toBeCloseTo(5, 3);
      expect(sc!.outPoint).toBeCloseTo(7.5, 3);
      expect(await getState<string>(page, '(s) => s.ui.activePanel')).toBe('source');

      // Scope switches to the Source clip narrow the results
      const scope = page.getByTestId('transcript-scope');
      await scope.selectOption(`media:${ep1Id}`);
      await expect(results).toHaveCount(2);
      await scope.selectOption('project');
      await expect(results).toHaveCount(4);

      // Keyboard: Down moves selection, Enter loads
      await search.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const sc2 = await getState<SourceClip>(page, '(s) => s.ui.sourceClip');
      expect(sc2.time).toBeCloseTo(9, 1);
      expect(sc2.inPoint).toBeCloseTo(9, 3);

      // ---- Insert at playhead → clip + carried subtitle cue
      const before = await sequenceState(page);
      expect(before.clips).toHaveLength(0);
      expect(before.playhead).toBe(0);
      await first.hover();
      await first.getByLabel('Insert at playhead', { exact: false }).click();
      // BUG-2: the transcript insert goes through the shared Source edit path, so an empty sequence whose
      // settings differ from the clip asks to conform first (same as `,` / `.` and drag & drop).
      await expect(page.getByTestId('conform-dialog')).toBeVisible();
      await page.getByTestId('conform-keep').click();
      await expect.poll(async () => (await sequenceState(page)).clips.length).toBeGreaterThanOrEqual(1);
      const after = await sequenceState(page);
      expect(after.clips.length).toBeGreaterThanOrEqual(1);
      const video = after.clips.find((c) => c.mediaId === ep1Id)!;
      expect(video).toBeTruthy();
      expect(video.sourceIn).toBeCloseTo(5, 6);
      expect(video.start).toBe(0);
      expect(video.originLabel).toBe('transcript');
      expect(video.duration).toBe(Math.round(2.5 * after.fps.num / after.fps.den));
      expect(after.tracks).toHaveLength(1);
      expect(after.tracks[0].cues).toHaveLength(1);
      expect(after.tracks[0].cues[0].text).toBe('Where is the doctor?');
      expect(after.tracks[0].cues[0].clipId).toBe(video.id);
      expect(after.tracks[0].cues[0].srcStart).toBeCloseTo(5, 6);
      // Playhead advanced past the inserted clip.
      expect(after.playhead).toBe(video.duration);

      // Sequence scope reports the timeline position of the inserted moment.
      const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
      await scope.selectOption(`sequence:${seqId}`);
      await expect(results).toHaveCount(1);
      await expect(results.first().locator('.tr-tl')).toHaveText(/▸ 00:00:00:00/);
      await scope.selectOption('project');

      await page.screenshot({ path: path.join(ROOT, 'docs/screenshots/transcript.png') });

      // ---- Subtitles panel
      await openPanel(page, 'Subtitles');
      const row = page.getByTestId('subtitle-cue');
      await expect(row).toHaveCount(1);
      await expect(page.getByTestId('subtitle-cue-text')).toHaveValue('Where is the doctor?');
      await expect(page.getByTestId('subtitle-cue-start')).toHaveText('00:00:00:00');
      await expect(row.first().locator('.st-origin')).toContainText('Station Eleven S01E01');
      await expect(page.getByTestId('subtitle-count')).toHaveText('1 cue');

      await row.first().getByLabel('Nudge later', { exact: false }).click();
      const nudged = await sequenceState(page);
      expect(nudged.tracks[0].cues[0].offset).toBe(1);
      await expect(page.getByTestId('subtitle-cue-start')).toHaveText('00:00:00:01');

      // Edit the text inline
      const textarea = page.getByTestId('subtitle-cue-text');
      await textarea.fill('Where is the doctor? (edited)');
      await textarea.press('Enter');
      expect((await sequenceState(page)).tracks[0].cues[0].text).toBe('Where is the doctor? (edited)');

      // ---- Export SRT directly (no native dialog)
      const outPath = path.join(tmp, 'export.srt');
      const res = await page.evaluate((p) => {
        const w = window as unknown as { __recut: { subtitles: { exportSequenceSubtitles(o: { path: string }): Promise<{ ok: boolean; count?: number; error?: string }> } } };
        return w.__recut.subtitles.exportSequenceSubtitles({ path: p });
      }, outPath);
      expect(res.ok).toBe(true);
      expect(res.count).toBe(1);
      const srt = fs.readFileSync(outPath, 'utf8');
      // 1 frame offset at 23.976 → 0.042s; cue end 2.5s → 60 frames + 1 → 2.544s
      expect(srt).toMatch(/^1\n00:00:00,04\d --> 00:00:02,5\d\d\nWhere is the doctor\? \(edited\)\n/);

      const vttPath = path.join(tmp, 'export.vtt');
      const res2 = await page.evaluate((p) => {
        const w = window as unknown as { __recut: { subtitles: { exportSequenceSubtitles(o: { path: string; format: 'vtt' }): Promise<{ ok: boolean }> } } };
        return w.__recut.subtitles.exportSequenceSubtitles({ path: p, format: 'vtt' });
      }, vttPath);
      expect(res2.ok).toBe(true);
      expect(fs.readFileSync(vttPath, 'utf8')).toMatch(/^WEBVTT\n\n00:00:00\.04\d --> 00:00:02\.5\d\d\n/);

      // ---- Orphan handling: a cue attached to a clip that no longer exists (e.g. from an older project file)
      // is not resolved; the panel counts it and "Clean up" removes it.
      await page.evaluate(() => {
        const w = window as unknown as { __recut: { store: { getState(): { project: { activeSequenceId: string }; commit(label: string, recipe: (d: { sequences: Record<string, { subtitleTracks: { cues: unknown[] }[] }> }) => void): boolean } } } };
        const s = w.__recut.store.getState();
        s.commit('Simulate orphan cue', (d) => {
          d.sequences[s.project.activeSequenceId].subtitleTracks[0].cues.push({ id: 'scue-ghost', clipId: 'clip-gone', srcStart: 0, srcEnd: 1, start: 0, duration: 24, offset: 0, text: 'ghost' });
        });
      });
      await expect(page.getByTestId('subtitle-count')).toHaveText('1 cue');
      await expect(page.locator('.st-panel .badge')).toHaveText('1 orphan');
      await page.getByRole('button', { name: 'Clean up' }).click();
      await expect(page.locator('.st-panel .badge')).toHaveCount(0);
      const cleaned = await sequenceState(page);
      expect(cleaned.tracks[0].cues).toHaveLength(1);
      expect(cleaned.tracks[0].cues[0].text).toBe('Where is the doctor? (edited)');
    } finally {
      await app.close();
    }
  });
});
