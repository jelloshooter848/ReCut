import { describe, expect, it } from 'vitest';
import { cleanOcrText, joinBands } from '../../electron/ocr/postprocess';

describe('postprocess', () => {
  it('standalone | is I', () => {
    expect(cleanOcrText('| think so')).toBe('I think so');
    expect(cleanOcrText('Yes, | know.')).toBe('Yes, I know.');
    expect(cleanOcrText('|')).toBe('I');
    expect(cleanOcrText("|'m here, |'ll go")).toBe("I'm here, I'll go");
    expect(cleanOcrText('-| am.')).toBe('-I am.');
    expect(cleanOcrText('| | |')).toBe('I I I');
    expect(cleanOcrText('a|b ||')).toBe('a|b ||'); // not standalone
  });

  it('collapses whitespace and trims', () => {
    expect(cleanOcrText('  Hello \t  world  ')).toBe('Hello world');
  });

  it('drops empty and punctuation-only lines', () => {
    expect(cleanOcrText('Hello\n\n . , \n-\n—\n"\nWorld')).toBe('Hello\nWorld');
    expect(cleanOcrText('...')).toBe('');
    expect(cleanOcrText('- Yes.\r\n- No!')).toBe('- Yes.\n- No!');
    expect(cleanOcrText('42')).toBe('42');
  });

  it('joins bands with newlines, skipping empty ones', () => {
    expect(joinBands(['THE CASTLE', ' .', '| said\nno'])).toBe('THE CASTLE\nI said\nno');
    expect(joinBands([])).toBe('');
  });
});
