// Render a .mscz into a MuseScoreVR project using MuseScore's CLI (MuseSounds included).
//
// usage: bun tools/stems.js score.mscz project.zip
// The project is an uncompressed zip: <partId>/<k>.flac (CHUNK-second dry mono slices, silent slices skipped)
// plus project.json. Slices let the player decode only what is about to play instead of whole tracks.
import { $ } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { readZip, writeZip, crc32 } from '../proto/zip.js';

const CHUNK = 10; // seconds per slice
const SILENT = 30; // peak below this (16-bit, ~ -60 dBFS) = slice not written
// ponytail: afconvert is macOS only; swap for ffmpeg to run on Linux/Windows
const MSCORE = process.env.MSCORE ?? '/Applications/MuseScore 4.app/Contents/MacOS/mscore';

// <Part id="N"> ... first <trackName> is the part's display name; Map keeps score order
export const partNames = mscx => new Map([...mscx.matchAll(/<Part id="(\d+)">[\s\S]*?<trackName>([^<]*)/g)].map(m => [m[1], m[2]]));

// instrument id -> [family id, family display name, rank] from the score's <Order> block.
// The order lists families front to back (woodwinds, brass, percussion...); families it doesn't list rank last.
export function families(mscx) {
  const order = mscx.match(/<Order\b[\s\S]*?<\/Order>/)?.[0];
  if (!order) return {};
  const ranks = new Map([...order.matchAll(/<family>([^<]+)<\/family>/g)].map((m, i) => [m[1], i]));
  return Object.fromEntries([...order.matchAll(/<instrument id="([^"]+)">\s*<family id="([^"]+)">([^<]*)<\/family>/g)]
    .map(([, inst, fid, name]) => [inst, [fid, name, ranks.get(fid) ?? ranks.size]]));
}

// mono 16-bit wav -> { rate, frames: Int16Array }; walks the chunks (afconvert adds a FLLR padding chunk)
function readWav(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let rate = 0;
  for (let p = 12; p + 8 <= v.byteLength; ) {
    const id = String.fromCharCode(...buf.subarray(p, p + 4)), len = v.getUint32(p + 4, true);
    if (id === 'fmt ') rate = v.getUint32(p + 12, true);
    if (id === 'data') return { rate, frames: new Int16Array(buf.slice(p + 8, p + 8 + len).buffer) };
    p += 8 + len + (len & 1);
  }
  throw new Error('wav sans données');
}
function wav(frames, rate) { // mono 16-bit PCM
  const out = new Uint8Array(44 + frames.byteLength), v = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '));
  v.setUint32(4, 36 + frames.byteLength, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  out.set(new TextEncoder().encode('data'), 36); v.setUint32(40, frames.byteLength, true);
  out.set(new Uint8Array(frames.buffer, frames.byteOffset, frames.byteLength), 44);
  return out;
}

async function main(src, out) {
  if (!src || !out) throw new Error('usage: bun tools/stems.js score.mscz project.zip');
  const tmp = await mkdtemp(join(tmpdir(), 'musescorevr-'));
  try {
    const score = await readZip(Bun.file(src));
    const files = new Map(); // name -> { bytes, crc }
    for (const [name, e] of score) files.set(name, { crc: e.crc, bytes: new Uint8Array(await (await e.blob()).arrayBuffer()) });
    const text = name => new TextDecoder().decode(files.get(name).bytes);
    const mscx = text([...files.keys()].find(n => n.endsWith('.mscx') && !n.includes('/')));
    const names = partNames(mscx), fams = families(mscx);
    const tracks = new Map(JSON.parse(text('audiosettings.json')).tracks.map(t => [t.partId, t]));
    const project = [], parts = [];
    let duration = 0;

    for (const [pid, name] of names) { // score order (top to bottom), used to break ties within a family
      // solo this part, kill reverb sends -> dry stem
      const settings = JSON.parse(text('audiosettings.json'));
      for (const t of settings.tracks) {
        t.soloMuteState = { mute: t.partId !== pid, solo: t.partId === pid };
        for (const send of t.out?.auxSends ?? []) send.active = false;
      }
      const json = new TextEncoder().encode(JSON.stringify(settings, null, 4));
      const solo = [...files].map(([n, f]) => n === 'audiosettings.json'
        ? { name: n, crc: crc32(json), data: new Blob([json]) } : { name: n, crc: f.crc, data: new Blob([f.bytes]) });
      await Bun.write(join(tmp, 's.mscz'), writeZip(solo));
      await $`${MSCORE} -o ${join(tmp, 's.wav')} ${join(tmp, 's.mscz')}`.quiet();
      await $`afconvert -f WAVE -d LEI16 -c 1 ${join(tmp, 's.wav')} ${join(tmp, 'mono.wav')}`.quiet();

      const { rate, frames } = readWav(new Uint8Array(await Bun.file(join(tmp, 'mono.wav')).arrayBuffer()));
      duration = frames.length / rate;
      const chunks = [];
      for (let k = 0; k * CHUNK * rate < frames.length; k++) {
        const slice = frames.subarray(k * CHUNK * rate, (k + 1) * CHUNK * rate);
        if (!slice.some(x => Math.abs(x) >= SILENT)) { chunks.push(null); continue; }
        const piece = join(tmp, 'piece.wav'), flac = join(tmp, `${pid}-${k}.flac`);
        await Bun.write(piece, wav(slice, rate));
        await $`afconvert -f flac -d flac ${piece} ${flac}`.quiet();
        // in-memory bytes: Bun drops Bun.file() parts inside new Blob([...]), which writeZip relies on
        const entry = `${pid}/${k}.flac`, bytes = new Uint8Array(await Bun.file(flac).arrayBuffer());
        project.push({ name: entry, data: new Blob([bytes]), crc: crc32(bytes) });
        chunks.push(entry);
      }
      const inst = tracks.get(pid).instrumentId;
      const [family, familyName, familyRank] = fams[inst] ?? [inst, name, Object.keys(fams).length];
      parts.push({ id: pid, name, instrument: inst, family, familyName, familyRank, count: 1, chunks });
      console.log(pid.padStart(4), name);
    }

    const meta = { version: 1, title: basename(src, '.mscz').trim(), chunk: CHUNK, duration, parts };
    const json = new TextEncoder().encode(JSON.stringify(meta, null, 2));
    project.push({ name: 'project.json', crc: crc32(json), data: new Blob([json]) });
    await Bun.write(out, writeZip(project)); // stored: the player slices entries out of the file
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(...process.argv.slice(2));
