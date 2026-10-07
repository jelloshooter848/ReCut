/**
 * A tiny, valid whisper.cpp ggml model for tests: the real file format and tensor names, one encoder and one decoder
 * layer of width 64, small pseudo-random weights (seeded, so the file and its SHA-256 are the same on every run).
 * whisper-cli loads it and transcribes with it; the "text" is nonsense, but the whole pipeline (audio extraction,
 * engine, progress, JSON result, cues) runs for real in about a second. About 7 MB, generated on the fly so no model
 * file is kept in the repository.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const GGML_FILE_MAGIC = 0x67676d6c; // "ggml"

export interface TestModelDims { state: number; heads?: number; layers?: number; audioCtx: number; textCtx: number; mels: number; vocab: number; textTokens: number }

// A short text context (whisper.cpp decodes at most half of it per 30 s window) keeps a nonsense decode fast.
const DIMS: TestModelDims = { state: 64, audioCtx: 1500, textCtx: 32, mels: 80, vocab: 51865, textTokens: 50257 };

class Writer {
  parts: Buffer[] = [];
  i32(...v: number[]): void { const b = Buffer.alloc(4 * v.length); v.forEach((x, k) => b.writeInt32LE(x, 4 * k)); this.parts.push(b); }
  u32(v: number): void { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); this.parts.push(b); }
  bytes(b: Buffer): void { this.parts.push(b); }
}

/** Deterministic pseudo-random numbers in [-scale, scale). */
function rng(seed: number): (scale: number) => number {
  let s = seed >>> 0;
  return (scale) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return ((s / 0x100000000) * 2 - 1) * scale;
  };
}

/** IEEE 754 half precision bits of a float (round toward zero; enough for small test weights). */
function toHalf(f: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, f);
  const x = buf.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >>> 13);
}

/** Build the model file contents. */
export function buildTestWhisperModel(dims: TestModelDims = DIMS): Buffer {
  const n = dims.state;
  const w = new Writer();
  const rand = rng(12345);
  w.u32(GGML_FILE_MAGIC);
  // hparams: n_vocab, n_audio_ctx, n_audio_state, n_audio_head, n_audio_layer, n_text_ctx, n_text_state, n_text_head,
  // n_text_layer, n_mels, ftype (1 = f16)
  const heads = dims.heads ?? 1;
  const layers = dims.layers ?? 1;
  w.i32(dims.vocab, dims.audioCtx, n, heads, layers, dims.textCtx, n, heads, layers, dims.mels, 1);
  // mel filters: n_mel, n_fft, n_mel * n_fft floats
  const nFft = 201;
  w.i32(dims.mels, nFft);
  const filters = Buffer.alloc(dims.mels * nFft * 4);
  for (let m = 0; m < dims.mels; m++) filters.writeFloatLE(1, 4 * (m * nFft + Math.min(nFft - 1, 1 + m * 2)));
  w.bytes(filters);
  // vocab: the text tokens; whisper.cpp adds the special tokens itself
  w.i32(dims.textTokens);
  for (let i = 0; i < dims.textTokens; i++) {
    // GPT-2 layout where whisper.cpp looks tokens up by text: printable ASCII first, " " at 220.
    const text = i < 94 ? String.fromCharCode(33 + i) : i === 220 ? ' ' : i % 7 === 0 ? ` w${i}` : `x${i}`;
    const tok = Buffer.from(text, 'utf8');
    w.u32(tok.length);
    w.bytes(tok);
  }
  const tensor = (name: string, ne: number[], f16: boolean, scale = 0.05) => {
    const count = ne.reduce((a, b) => a * b, 1);
    const nameBuf = Buffer.from(name, 'utf8');
    w.i32(ne.length, nameBuf.length, f16 ? 1 : 0);
    w.i32(...ne);
    w.bytes(nameBuf);
    const data = Buffer.alloc(count * (f16 ? 2 : 4));
    for (let k = 0; k < count; k++) {
      const v = rand(scale);
      if (f16) data.writeUInt16LE(toHalf(v), 2 * k); else data.writeFloatLE(v, 4 * k);
    }
    w.bytes(data);
  };
  const ones = (name: string, len: number) => {
    const nameBuf = Buffer.from(name, 'utf8');
    w.i32(1, nameBuf.length, 0, len);
    w.bytes(nameBuf);
    const data = Buffer.alloc(len * 4);
    for (let k = 0; k < len; k++) data.writeFloatLE(1, 4 * k);
    w.bytes(data);
  };
  tensor('encoder.positional_embedding', [n, dims.audioCtx], false);
  tensor('encoder.conv1.weight', [3, dims.mels, n], true);
  tensor('encoder.conv1.bias', [1, n], false);
  tensor('encoder.conv2.weight', [3, n, n], true);
  tensor('encoder.conv2.bias', [1, n], false);
  ones('encoder.ln_post.weight', n);
  tensor('encoder.ln_post.bias', [n], false);
  const block = (p: string, cross: boolean) => {
    ones(`${p}.mlp_ln.weight`, n); tensor(`${p}.mlp_ln.bias`, [n], false);
    tensor(`${p}.mlp.0.weight`, [n, 4 * n], true); tensor(`${p}.mlp.0.bias`, [4 * n], false);
    tensor(`${p}.mlp.2.weight`, [4 * n, n], true); tensor(`${p}.mlp.2.bias`, [n], false);
    for (const a of cross ? ['attn', 'cross_attn'] : ['attn']) {
      ones(`${p}.${a}_ln.weight`, n); tensor(`${p}.${a}_ln.bias`, [n], false);
      tensor(`${p}.${a}.query.weight`, [n, n], true); tensor(`${p}.${a}.query.bias`, [n], false);
      tensor(`${p}.${a}.key.weight`, [n, n], true);
      tensor(`${p}.${a}.value.weight`, [n, n], true); tensor(`${p}.${a}.value.bias`, [n], false);
      tensor(`${p}.${a}.out.weight`, [n, n], true); tensor(`${p}.${a}.out.bias`, [n], false);
    }
  };
  for (let l = 0; l < layers; l++) block(`encoder.blocks.${l}`, false);
  tensor('decoder.positional_embedding', [n, dims.textCtx], false);
  tensor('decoder.token_embedding.weight', [n, dims.vocab], true, 0.5);
  ones('decoder.ln.weight', n);
  tensor('decoder.ln.bias', [n], false);
  for (let l = 0; l < layers; l++) block(`decoder.blocks.${l}`, true);
  return Buffer.concat(w.parts);
}

/** Write the test model to `file` (optionally with other dimensions); returns its size and SHA-256. */
export function writeTestWhisperModel(file: string, dims?: TestModelDims): { bytes: number; sha256: string } {
  const buf = buildTestWhisperModel(dims);
  fs.writeFileSync(file, buf);
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
