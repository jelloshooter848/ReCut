import React from 'react';

export interface TooltipProps { text: string; shortcut?: string; children: React.ReactElement }

/** Lightweight tooltip: uses the native title attribute (dense UI, zero layout cost). */
export function Tooltip({ text, shortcut, children }: TooltipProps) {
  const title = shortcut ? `${text} (${shortcut})` : text;
  return React.cloneElement(children, { title });
}
