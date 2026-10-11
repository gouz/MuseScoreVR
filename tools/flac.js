// Audio without ffmpeg: read the WAV MuseScore exports, encode mono 16-bit FLAC.
// The FLAC encoder uses fixed predictors (orders 0-4) and Rice-coded residuals, like `flac -2`:
// a bit larger than libFLAC's default, but small, dependency-free and identical on every platform.

// WAV (PCM 16/24/32-bit or float 32, any channel count) -> mono Int16Array at `rate` Hz
export function wavToMono(buf, rate = 44100) {
  const v = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
  const tag = o => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + o, 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('pas un fichier WAV');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= v.byteLength; o += 8 + v.getUint32(o + 4, true) + (v.getUint32(o + 4, true) & 1)) {
    if (tag(o) === 'fmt ') fmt = o + 8;
    if (tag(o) === 'data') { data = [o + 8, Math.min(v.getUint32(o + 4, true), v.byteLength - o - 8)]; break; }
  }
  if (fmt === null || !data) throw new Error('WAV incomplet');
  let format = v.getUint16(fmt, true);
  const channels = v.getUint16(fmt + 2, true), srcRate = v.getUint32(fmt + 4, true), bits = v.getUint16(fmt + 14, true);
  if (format === 0xfffe) format = v.getUint16(fmt + 24, true); // WAVE_FORMAT_EXTENSIBLE: sub-format GUID starts with the format code
  const bytes = bits / 8, frames = Math.floor(data[1] / (bytes * channels));
  const read = format === 3 && bits === 32 ? o => v.getFloat32(o, true)
    : format === 1 && bits === 16 ? o => v.getInt16(o, true) / 32768
    : format === 1 && bits === 24 ? o => ((v.getUint8(o) | v.getUint8(o + 1) << 8 | v.getInt8(o + 2) << 16)) / 8388608
    : format === 1 && bits === 32 ? o => v.getInt32(o, true) / 2147483648
    : null;
  if (!read) throw new Error(`format WAV non géré (${format}, ${bits} bits)`);
  const mono = new Float32Array(frames);
  for (let i = 0, o = data[0]; i < frames; i++) {
    let s = 0; for (let c = 0; c < channels; c++, o += bytes) s += read(o);
    mono[i] = s / channels;
  }
  // ponytail: linear resampling, only used if MuseScore is set to export at another rate than the player's
  const n = Math.floor(frames * rate / srcRate), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * srcRate / rate, j = Math.floor(x), f = x - j;
    const s = srcRate === rate ? mono[i] : mono[j] * (1 - f) + (mono[Math.min(j + 1, frames - 1)] * f);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
  }
  return out;
}

// --- FLAC ----------------------------------------------------------------
const BLOCK = 4096, MAXP = 6; // samples per frame, max Rice partition order

const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? (c << 1 ^ 0x07) & 0xff : c << 1 & 0xff; CRC8[i] = c;
  let d = i << 8; for (let k = 0; k < 8; k++) d = d & 0x8000 ? (d << 1 ^ 0x8005) & 0xffff : d << 1 & 0xffff; CRC16[i] = d;
}

class Bits { // MSB-first bit writer
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; this.acc = 0; this.n = 0; }
  byte(b) { if (this.len === this.buf.length) { const g = new Uint8Array(this.buf.length * 2); g.set(this.buf); this.buf = g; } this.buf[this.len++] = b; }
  put(v, n) { // n <= 24
    this.acc = this.acc << n | v; this.n += n;
    while (this.n >= 8) { this.n -= 8; this.byte(this.acc >>> this.n & 0xff); }
    this.acc &= (1 << this.n) - 1;
  }
  zeros(q) { while (q > 24) { this.put(0, 24); q -= 24; } this.put(0, q); }
  align() { if (this.n) this.put(0, 8 - this.n); }
}

const RES = new Int32Array(BLOCK);
function residual(x, order, out) { // fixed predictors, FLAC spec 9.2.5
  for (let i = order; i < x.length; i++) out[i - order] =
    order === 0 ? x[i] : order === 1 ? x[i] - x[i - 1] : order === 2 ? x[i] - 2 * x[i - 1] + x[i - 2]
    : order === 3 ? x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3] : x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
  return x.length - order;
}

function subframe(w, x) {
  if (x.every(s => s === x[0])) { w.put(0, 8); w.put(x[0] & 0xffff, 16); return; } // constant (silence)
  // order: smallest sum of |residual|
  let best = 0, bestSum = Infinity;
  for (let o = 0; o <= Math.min(4, x.length - 1); o++) {
    const n = residual(x, o, RES); let s = 0; for (let i = 0; i < n; i++) s += Math.abs(RES[i]);
    if (s < bestSum) { bestSum = s; best = o; }
  }
  const n = residual(x, best, RES);
  const u = new Uint32Array(n); for (let i = 0; i < n; i++) u[i] = RES[i] >= 0 ? RES[i] * 2 : -RES[i] * 2 - 1; // zigzag
  // partitions: estimated cost n*(k+1) + sum>>k per partition, best order and parameters
  const kOf = (sum, cnt) => { let k = 0, c = Infinity; for (let t = 0; t <= 14; t++) { const b = cnt * (t + 1) + Math.floor(sum / 2 ** t); if (b < c) { c = b; k = t; } } return [k, c]; };
  let plan = null;
  for (let p = 0; p <= MAXP && x.length % (1 << p) === 0 && (x.length >> p) > best; p++) {
    const size = x.length >> p, ks = []; let cost = 0, at = 0;
    for (let q = 0; q < 1 << p; q++) {
      const cnt = q ? size : size - best; let sum = 0; for (let i = at; i < at + cnt; i++) sum += u[i];
      const [k, c] = kOf(sum, cnt); ks.push([k, cnt]); cost += c + 4; at += cnt;
    }
    if (!plan || cost < plan.cost) plan = { p, ks, cost };
  }
  w.put((8 + best) << 1, 8); // 0 | type 001ooo (fixed, order o) | no wasted bits
  for (let i = 0; i < best; i++) w.put(x[i] & 0xffff, 16); // warm-up samples
  w.put(0, 2); w.put(plan.p, 4); // Rice, partition order
  let at = 0;
  for (const [k, cnt] of plan.ks) {
    w.put(k, 4);
    for (let i = at; i < at + cnt; i++) {
      const q = u[i] >>> k;
      if (q + 1 + k <= 24) w.put(1 << k | u[i] & ((1 << k) - 1), q + 1 + k);
      else { w.zeros(q); w.put(1, 1); if (k) w.put(u[i] & ((1 << k) - 1), k); }
    }
    at += cnt;
  }
}

// Int16Array (mono) -> Uint8Array FLAC file
export function encodeFlac(pcm, rate = 44100) {
  const w = new Bits();
  for (const b of [0x66, 0x4c, 0x61, 0x43]) w.byte(b); // fLaC
  w.put(0x80, 8); w.put(34, 24); // last metadata block, STREAMINFO, 34 bytes
  w.put(BLOCK, 16); w.put(BLOCK, 16); w.put(0, 24); w.put(0, 24);
  w.put(rate, 20); w.put(0, 3); w.put(15, 5); // sample rate, channels - 1 (mono), bits per sample - 1
  w.put(0, 4); w.put(pcm.length >>> 16, 16); w.put(pcm.length & 0xffff, 16); // 36-bit total samples
  for (let i = 0; i < 16; i++) w.put(0, 8); // MD5 unknown
  for (let f = 0, start = 0; start < pcm.length; f++, start += BLOCK) {
    const x = pcm.subarray(start, Math.min(start + BLOCK, pcm.length)), at = w.len;
    w.put(0xfff8, 16); // sync, fixed block size
    w.put((x.length === BLOCK ? 0b1100 : 0b0111) << 4 | 0b0000, 8); // block size code, rate from STREAMINFO
    w.put(0b0000 << 4 | 0b100 << 1, 8); // mono, 16 bits
    if (f < 0x80) w.put(f, 8); else w.put(0xc0 | f >> 6, 8), w.put(0x80 | f & 0x3f, 8); // UTF-8 frame number (< 2048 frames)
    if (x.length !== BLOCK) w.put(x.length - 1, 16);
    let c8 = 0; for (let i = at; i < w.len; i++) c8 = CRC8[c8 ^ w.buf[i]]; w.put(c8, 8);
    subframe(w, x);
    w.align();
    let c16 = 0; for (let i = at; i < w.len; i++) c16 = (c16 << 8 & 0xffff) ^ CRC16[c16 >> 8 ^ w.buf[i]]; w.put(c16, 16);
  }
  return w.buf.slice(0, w.len);
}
