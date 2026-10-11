// bun test — the encoder must be lossless; ffmpeg (only needed by this test) decodes the result
import { test } from 'bun:test';
import assert from 'node:assert';
import { $ } from 'bun';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFlac, wavToMono } from './flac.js';

test.skipIf(!Bun.which('ffmpeg'))('FLAC round trip: tone, silence, noise, odd lengths', async () => {
  for (const n of [100, 4096, 10000, 441000]) {
    const x = new Int16Array(n);
    for (let i = 0; i < n; i++) x[i] = i < n / 3 ? Math.round(12000 * Math.sin(i / 7)) : i < n / 2 ? 0 : Math.round((Math.random() - 0.5) * 60000);
    const file = join(tmpdir(), `musescorevr-test-${n}.flac`);
    await Bun.write(file, encodeFlac(x));
    const y = new Int16Array(await $`ffmpeg -v error -i ${file} -f s16le -`.quiet().arrayBuffer());
    assert.equal(y.length, n);
    assert.ok(y.every((s, i) => s === x[i]), `samples differ (n = ${n})`);
  }
});

test('WAV float stereo -> mono 16-bit', () => {
  const frames = 3, buf = new ArrayBuffer(44 + frames * 8), v = new DataView(buf);
  [...'RIFF'].forEach((c, i) => v.setUint8(i, c.charCodeAt(0))); v.setUint32(4, 36 + frames * 8, true);
  [...'WAVEfmt '].forEach((c, i) => v.setUint8(8 + i, c.charCodeAt(0)));
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true); v.setUint16(34, 32, true);
  [...'data'].forEach((c, i) => v.setUint8(36 + i, c.charCodeAt(0))); v.setUint32(40, frames * 8, true);
  [[0.5, 0.5], [1, -1], [-1, -1]].forEach(([l, r], i) => { v.setFloat32(44 + i * 8, l, true); v.setFloat32(48 + i * 8, r, true); });
  assert.deepEqual([...wavToMono(new Uint8Array(buf))], [16384, 0, -32768]);
});
