/**
 * Exact rational numbers (BigInt) for interchange times: FCPXML writes every time as `N/Ds` and must never round
 * through a float (a 23.976 timeline drifts a frame within minutes). Pure.
 */
import type { Rational } from '../model';

const babs = (a: bigint) => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint): bigint {
  a = babs(a); b = babs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

export class Q {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new RangeError('Q: zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  static int(v: number): Q { return new Q(BigInt(Math.round(v))); }
  static frac(n: number, d: number): Q { return new Q(BigInt(Math.round(n)), BigInt(Math.round(d))); }
  /** A decimal number kept to `digits` decimals (keyframe frames, speeds): exact for the decimals it has. */
  static dec(v: number, digits = 6): Q {
    const s = 10 ** digits;
    return new Q(BigInt(Math.round(v * s)), BigInt(s));
  }
  /** Duration of one frame at `fps`, in seconds. */
  static frameDuration(fps: Rational): Q { return Q.frac(fps.den, fps.num); }
  /** `frames` frames at `fps`, in seconds. */
  static frames(frames: number, fps: Rational): Q { return Q.frameDuration(fps).mul(Q.int(frames)); }
  add(o: Q): Q { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Q): Q { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Q): Q { return new Q(this.n * o.n, this.d * o.d); }
  div(o: Q): Q { return new Q(this.n * o.d, this.d * o.n); }
  cmp(o: Q): number { const x = this.n * o.d - o.n * this.d; return x < 0n ? -1 : x > 0n ? 1 : 0; }
  isZero(): boolean { return this.n === 0n; }
  toNumber(): number { return Number(this.n) / Number(this.d); }
  /** FCPXML time value: "0s", "5s" or "1001/24000s". */
  toTime(): string { return this.d === 1n ? `${this.n}s` : `${this.n}/${this.d}s`; }
}
