/**
 * Confirmation / prompt helpers.
 *
 *  - `confirm(opts)` resolves to the index of the pressed button. It uses the native message box
 *    (window.recut.message) when the Electron bridge is present and falls back to window.confirm.
 *  - `confirmInApp(opts)` is the same contract rendered as an in-app React dialog (used where the
 *    answer must be testable / non-blocking, e.g. the startup recovery prompt).
 *  - `promptText(opts)` is an in-app single-line text prompt (Electron has no window.prompt).
 *
 * Mount `<DialogHost />` once (App.tsx) for the in-app variants.
 */
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { PRODUCT_NAME } from '@shared/productIdentity';

export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  /** Button labels; index 0 is the default. Defaults to ['OK', 'Cancel']. */
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  /** Test id for the in-app dialog root. */
  testId?: string;
  /** Per-button test ids for the in-app dialog (default `confirm-button-<i>`). */
  buttonTestIds?: string[];
}

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  testId?: string;
}

interface ConfirmRequest { kind: 'confirm'; id: number; opts: ConfirmOptions; resolve(i: number): void }
interface PromptRequest { kind: 'prompt'; id: number; opts: PromptOptions; resolve(v: string | null): void }
type Request = ConfirmRequest | PromptRequest;

interface DialogQueueState {
  queue: Request[];
  push(r: Request): void;
  shift(): void;
}

const useDialogQueue = create<DialogQueueState>()((set) => ({
  queue: [],
  push: (r) => set((s) => ({ queue: [...s.queue, r] })),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

let nextId = 1;

/** Native (Electron) confirmation when available, else window.confirm. Resolves to the pressed button index. */
export async function confirm(opts: ConfirmOptions): Promise<number> {
  const buttons = opts.buttons ?? ['OK', 'Cancel'];
  const api = typeof window !== 'undefined' ? window.recut : undefined;
  if (api?.message) {
    try {
      return await api.message({
        type: opts.type ?? 'question', title: opts.title, message: opts.message, detail: opts.detail,
        buttons, defaultId: opts.defaultId ?? 0, cancelId: opts.cancelId ?? buttons.length - 1,
      });
    } catch { /* fall through to the in-app dialog */ }
  }
  if (typeof document !== 'undefined') return confirmInApp(opts);
  if (typeof globalThis.confirm === 'function') return globalThis.confirm(opts.message) ? 0 : (opts.cancelId ?? buttons.length - 1);
  return opts.cancelId ?? buttons.length - 1;
}

/** In-app confirmation dialog. Resolves to the pressed button index (cancelId when dismissed). */
export function confirmInApp(opts: ConfirmOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    useDialogQueue.getState().push({ kind: 'confirm', id: nextId++, opts, resolve });
  });
}

/** In-app text prompt. Resolves to the entered text, or null when cancelled. */
export function promptText(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    useDialogQueue.getState().push({ kind: 'prompt', id: nextId++, opts, resolve });
  });
}

function ConfirmView({ req }: { req: ConfirmRequest }) {
  const buttons = req.opts.buttons ?? ['OK', 'Cancel'];
  const cancelId = req.opts.cancelId ?? buttons.length - 1;
  const defaultId = req.opts.defaultId ?? 0;
  const finish = (i: number) => { useDialogQueue.getState().shift(); req.resolve(i); };
  return (
    <Dialog open title={req.opts.title ?? PRODUCT_NAME} onClose={() => finish(cancelId)} width={440} closeOnBackdrop={false} onSubmit={() => finish(defaultId)}
      footer={buttons.map((b, i) => (
        <Button key={b} variant={i === defaultId ? 'primary' : 'default'} onClick={() => finish(i)} data-testid={req.opts.buttonTestIds?.[i] ?? `confirm-button-${i}`} autoFocus={i === defaultId}>{b}</Button>
      ))}>
      <div className="col" style={{ gap: 6 }} data-testid={req.opts.testId ?? 'confirm-dialog'}>
        <div>{req.opts.message}</div>
        {req.opts.detail ? <div className="text-dim text-sm" style={{ whiteSpace: 'pre-wrap' }}>{req.opts.detail}</div> : null}
      </div>
    </Dialog>
  );
}

function PromptView({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.opts.initial ?? '');
  useEffect(() => { setValue(req.opts.initial ?? ''); }, [req.id, req.opts.initial]);
  const finish = (v: string | null) => { useDialogQueue.getState().shift(); req.resolve(v); };
  return (
    <Dialog open title={req.opts.title} onClose={() => finish(null)} width={420} closeOnBackdrop={false} onSubmit={() => finish(value)}
      footer={<>
        <Button onClick={() => finish(null)}>Cancel</Button>
        <Button variant="primary" onClick={() => finish(value)} data-testid="prompt-ok">{req.opts.okLabel ?? 'OK'}</Button>
      </>}>
      <form className="col" style={{ gap: 6 }} data-testid={req.opts.testId ?? 'prompt-dialog'} onSubmit={(e) => { e.preventDefault(); finish(value); }}>
        {req.opts.label ? <label className="text-dim text-sm">{req.opts.label}</label> : null}
        <TextField autoFocus selectOnFocus value={value} onChange={setValue} placeholder={req.opts.placeholder} data-testid="prompt-input" />
      </form>
    </Dialog>
  );
}

/** Renders the head of the in-app dialog queue. Mount once. */
export function DialogHost() {
  const head = useDialogQueue((s) => s.queue[0]);
  if (!head) return null;
  return head.kind === 'confirm' ? <ConfirmView key={head.id} req={head} /> : <PromptView key={head.id} req={head} />;
}
