/**
 * OCR language status in the renderer (src/state/ocrStatus.ts) and the jobs router's 'download' route: a settled
 * install job refreshes the list once and toasts its outcome. Also the "OCR Languages…" command.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ocrLanguages = vi.fn();
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = globalThis;
});

import type { JobInfo } from '../../shared/model';
import type { OcrLanguageState } from '../../shared/ocr';
import { formatOcrSize, installedSummary, useOcrStatus } from '../../src/state/ocrStatus';
import { routeJobs, resetJobsRouter } from '../../src/app/jobsRouter';
import { getToasts } from '../../src/components/ui/toastStore';
import { useOcrUi } from '../../src/ocr/ocrUi';
import { registerEditingCommands, EXTRA_COMMAND_IDS } from '../../src/app/commands';
import { getCommand, runCommand } from '../../src/keyboard/shortcuts';

const eng = (installed: boolean, jobId?: string): OcrLanguageState => ({ code: 'eng', name: 'English', bytes: 4113088, installed, ...(jobId ? { jobId } : {}) });
const fra = (installed: boolean): OcrLanguageState => ({ code: 'fra', name: 'French', bytes: 1130365, installed });

beforeEach(() => {
  (window as unknown as { recut: unknown }).recut = { ocrLanguages };
  ocrLanguages.mockReset();
  useOcrStatus.setState({ languages: null, error: null });
  resetJobsRouter();
});

describe('ocrStatus store', () => {
  it('refresh() loads the list; installed() filters it', async () => {
    ocrLanguages.mockResolvedValue([eng(true), fra(false)]);
    expect(useOcrStatus.getState().installed()).toEqual([]);
    await useOcrStatus.getState().refresh();
    expect(useOcrStatus.getState().languages).toHaveLength(2);
    expect(useOcrStatus.getState().installed().map((l) => l.code)).toEqual(['eng']);
  });

  it('keeps the latest of overlapping refreshes and records errors', async () => {
    let first!: (v: OcrLanguageState[]) => void;
    ocrLanguages.mockImplementationOnce(() => new Promise((r) => { first = r; })).mockResolvedValueOnce([eng(true)]);
    const a = useOcrStatus.getState().refresh();
    await useOcrStatus.getState().refresh();
    first([eng(false)]);
    await a;
    expect(useOcrStatus.getState().languages?.[0].installed).toBe(true);
    ocrLanguages.mockRejectedValueOnce(new Error('boom'));
    await useOcrStatus.getState().refresh();
    expect(useOcrStatus.getState().error).toBe('boom');
  });

  it('is a no-op outside the desktop app', async () => {
    (window as unknown as { recut: unknown }).recut = undefined;
    await useOcrStatus.getState().refresh();
    expect(useOcrStatus.getState().languages).toBeNull();
  });

  it('summarizes installed languages for Preferences', () => {
    expect(installedSummary(null)).toBe('None');
    expect(installedSummary([eng(false)])).toBe('None');
    expect(installedSummary([eng(true), fra(true)])).toBe(`English, French (${formatOcrSize(4113088 + 1130365)})`);
    expect(formatOcrSize(4113088)).toBe('4.1 MB');
  });
});

describe('jobs router: download jobs', () => {
  const job = (patch: Partial<JobInfo>): JobInfo => ({ id: 'd1', kind: 'download', title: 'Install English OCR data (4.1 MB)', status: 'running', progress: 0.3, ...patch });
  const lastToast = () => getToasts().at(-1);

  it('refreshes the language list once when an install finishes', async () => {
    ocrLanguages.mockResolvedValue([eng(false, 'd1')]);
    routeJobs([job({})]);
    expect(ocrLanguages).not.toHaveBeenCalled();
    ocrLanguages.mockResolvedValue([eng(true)]);
    routeJobs([job({ status: 'done', progress: 1, result: { code: 'eng', bytes: 4113088 } })]);
    expect(lastToast()).toMatchObject({ kind: 'ok', text: 'English OCR language installed' });
    await vi.waitFor(() => expect(useOcrStatus.getState().installed().map((l) => l.code)).toEqual(['eng']));
    routeJobs([job({ status: 'done', progress: 1 })]);
    expect(ocrLanguages).toHaveBeenCalledTimes(1);
  });

  it('toasts failures and cancels, and refreshes after each', async () => {
    ocrLanguages.mockResolvedValue([eng(false)]);
    routeJobs([job({ id: 'd2', status: 'failed', error: 'checksum mismatch: the downloaded file is not the expected one' })]);
    expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/^Could not install English OCR data: checksum mismatch/) });
    routeJobs([job({ id: 'd3', status: 'canceled' })]);
    expect(lastToast()).toMatchObject({ kind: 'info', text: 'English OCR download canceled' });
    expect(ocrLanguages).toHaveBeenCalledTimes(2);
  });
});

describe('OCR Languages… command', () => {
  it('opens the OCR Languages dialog', () => {
    registerEditingCommands();
    expect(getCommand(EXTRA_COMMAND_IDS.ocrLanguages)?.title).toBe('OCR Languages…');
    expect(useOcrUi.getState().languagesOpen).toBe(false);
    runCommand(EXTRA_COMMAND_IDS.ocrLanguages);
    expect(useOcrUi.getState().languagesOpen).toBe(true);
  });
});
