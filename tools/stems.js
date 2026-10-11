// Render a .mscz into a MuseScoreVR project using MuseScore's CLI (MuseSounds included).
//
// usage: bun tools/stems.js score.mscz project.zip   (needs MuseScore 4 with MuseSounds)
// The project is an uncompressed zip: <partId>/<k>.flac (CHUNK-second dry mono slices, silent slices skipped)
// plus project.json. Slices let the player decode only what is about to play instead of whole tracks.
// Music stands: scores/full/ (conductor's score) and scores/<partId>/ (the part, when the score has generated parts):
// page SVGs plus sheet.json (page turns, note timings; see sheet.js).
import { $ } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { readZip, writeZip, crc32 } from '../proto/zip.js';
import { sheet } from './sheet.js';
import { wavToMono, encodeFlac } from './flac.js';
import { t } from '../proto/i18n.js';

const CHUNK = 10; // seconds per slice
const SILENT = 30; // peak below this (16-bit, ~ -60 dBFS) = slice not written
const RATE = 44100; // Hz, the player's AudioContext rate
// MuseScore 4 CLI when run from the command line; set MSCORE if it lives elsewhere (the plugin passes its own)
// ponytail: Linux default assumes a packaged `mscore` on PATH; AppImage/Flatpak users set MSCORE
const MSCORE_DEFAULT = process.env.MSCORE ?? {
  darwin: '/Applications/MuseScore 4.app/Contents/MacOS/mscore',
  win32: 'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe',
}[process.platform] ?? 'mscore';

// <Part id="N"> ... first <trackName> is the part's display name; Map keeps score order.
// Parts hidden in MuseScore (<show>0</show>, written before <trackName>) are left out.
export const partNames = mscx => new Map([...mscx.matchAll(/<Part id="(\d+)">([\s\S]*?)<trackName>([^<]*)/g)]
  .filter(m => !m[2].includes('<show>0</show>')).map(m => [m[1], m[3]]));

// instrument id -> [family id, family display name, rank] from the score's <Order> block.
// The order lists families front to back (woodwinds, brass, percussion...); families it doesn't list rank last.
export function families(mscx) {
  const order = mscx.match(/<Order\b[\s\S]*?<\/Order>/)?.[0];
  if (!order) return {};
  const ranks = new Map([...order.matchAll(/<family>([^<]+)<\/family>/g)].map((m, i) => [m[1], i]));
  return Object.fromEntries([...order.matchAll(/<instrument id="([^"]+)">\s*<family id="([^"]+)">([^<]*)<\/family>/g)]
    .map(([, inst, fid, name]) => [inst, [fid, name, ranks.get(fid) ?? ranks.size]]));
}

// progress(tasks): called whenever a task moves (the CLI prints it; the server reports it).
//   tasks: [{ name, step, value }], one per part then the music stands; value 0..1, or -1 while MuseScore works (no way to know how far)
// opts: { mscore: MuseScore executable, title, source: id of the score file, kept in project.json, lang: of the messages }
export async function render(src, out, progress = tasks => console.log(tasks.map(t => `${t.name}: ${t.step}`).join(' · ')), opts = {}) {
  const MSCORE = opts.mscore ?? MSCORE_DEFAULT, tr = (key, ...a) => t(opts.lang ?? process.env.LANG, key, ...a);
  if (!src || !out) throw new Error('usage: bun tools/stems.js score.mscz project.zip');
  const tmp = await mkdtemp(join(tmpdir(), 'musescorevr-'));
  try {
    const score = await readZip(Bun.file(src));
    const files = new Map(); // name -> { bytes, crc }
    for (const [name, e] of score) files.set(name, { crc: e.crc, bytes: new Uint8Array(await (await e.blob()).arrayBuffer()) });
    const text = name => new TextDecoder().decode(files.get(name).bytes);
    const mscx = text([...files.keys()].find(n => n.endsWith('.mscx') && !n.includes('/')));
    const names = partNames(mscx), fams = families(mscx);
    // per-part mixer state only exists once MuseScore 4 has saved the score; soloing relies on it
    const tracks = new Map((files.has('audiosettings.json') ? JSON.parse(text('audiosettings.json')).tracks : []).map(t => [t.partId, t]));
    if (!names.size || ![...names.keys()].every(pid => tracks.has(pid))) // MuseScore 3 parts have no id at all
      throw new Error(tr('notMS4', basename(src)));
    const project = [], parts = [];
    let duration = 0;

    const tasks = [...names.values()].map(name => ({ name, step: tr('stepWaiting'), value: 0 }));
    const stands = { name: tr('stands'), step: tr('stepWaiting'), value: 0 };
    tasks.push(stands);
    const set = (t, step, value) => { Object.assign(t, { step, value }); progress(tasks); };
    progress(tasks);
    for (const [i, [pid, name]] of [...names].entries()) { // score order (top to bottom), used to break ties within a family
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
      set(tasks[i], tr('stepRendering'), -1);
      await $`${MSCORE} -o ${join(tmp, 's.wav')} ${join(tmp, 's.mscz')}`.quiet();
      const frames = wavToMono(new Uint8Array(await Bun.file(join(tmp, 's.wav')).arrayBuffer()), RATE); // sliced sample-exact below
      duration = frames.length / RATE;
      const chunks = [], count = Math.ceil(frames.length / (CHUNK * RATE));
      for (let k = 0; k < count; k++) {
        if (k % 8 === 0) { set(tasks[i], tr('stepCompressing'), k / count); await Bun.sleep(0); } // let the server answer meanwhile
        const slice = frames.subarray(k * CHUNK * RATE, (k + 1) * CHUNK * RATE);
        if (!slice.some(x => Math.abs(x) >= SILENT)) { chunks.push(null); continue; }
        const entry = `${pid}/${k}.flac`, bytes = encodeFlac(slice, RATE);
        project.push({ name: entry, data: new Blob([bytes]), crc: crc32(bytes) });
        chunks.push(entry);
      }
      const inst = tracks.get(pid).instrumentId;
      const [family, familyName, familyRank] = fams[inst] ?? [inst, name, Object.keys(fams).length];
      parts.push({ id: pid, name, instrument: inst, family, familyName, familyRank, count: 1, chunks });
      set(tasks[i], tr('stepDone'), 1);
    }

    set(stands, tr('stepLayout'), -1);
    // music stands: one MuseScore batch run exports every page as SVG plus segment timings, in page layout
    const paged = new Map([...files].map(([n, f]) => [n, n.endsWith('.mscx')
      ? { crc: null, bytes: new TextEncoder().encode(new TextDecoder().decode(f.bytes).replace(/\s*<layoutMode>\w+<\/layoutMode>/, '')) } : f]));
    const mscz = list => writeZip([...list].map(([name, f]) => ({ name, crc: f.crc ?? crc32(f.bytes), data: new Blob([f.bytes]) })));
    const sheets = new Map([['full', mscz(paged)]]);
    for (const [n, f] of paged) { // a generated part keeps its <Part id>; it becomes a score of its own
      const ids = [...new TextDecoder().decode(f.bytes).matchAll(/<Part id="(\d+)">/g)].map(m => m[1]);
      if (n.startsWith('Excerpts/') && n.endsWith('.mscx') && ids.length === 1 && names.has(ids[0]))
        sheets.set(ids[0], mscz([['part.mscx', f], ['score_style.mss', paged.get(n.replace(/\.mscx$/, '.mss')) ?? paged.get('score_style.mss')]]));
    }
    const job = [];
    for (const [key, data] of sheets) {
      await Bun.write(join(tmp, `${key}.mscz`), data);
      job.push({ in: join(tmp, `${key}.mscz`), out: [join(tmp, `${key}.svg`), join(tmp, `${key}.spos`)] });
    }
    await Bun.write(join(tmp, 'job.json'), JSON.stringify(job));
    await $`${MSCORE} -j ${join(tmp, 'job.json')}`.quiet();
    set(stands, tr('stepNotes'), 0);
    for (const [k, key] of [...sheets.keys()].entries()) {
      set(stands, tr('stepNotes'), k / sheets.size); await Bun.sleep(0);
      const pages = [...new Bun.Glob(`${key}-*.svg`).scanSync(tmp)].sort((a, b) => parseInt(a.slice(key.length + 1)) - parseInt(b.slice(key.length + 1)));
      if (!pages.length) pages.push(`${key}.svg`); // single page: no number
      const svgs = await Promise.all(pages.map(p => Bun.file(join(tmp, p)).text()));
      const add = (name, bytes) => project.push({ name, data: new Blob([bytes]), crc: crc32(bytes) });
      svgs.forEach((svg, i) => add(`scores/${key}/${i}.svg`, new TextEncoder().encode(svg)));
      add(`scores/${key}/sheet.json`, new TextEncoder().encode(JSON.stringify(sheet(svgs, await Bun.file(join(tmp, `${key}.spos`)).text(), duration))));
    }
    for (const p of parts) if (sheets.has(p.id)) p.sheet = `scores/${p.id}`;
    const missing = parts.filter(p => !p.sheet).map(p => p.name);
    set(stands, missing.length ? tr('noParts', missing.join(', ')) : tr('stepDone'), 1);

    const meta = { version: 1, title: opts.title ?? basename(src, '.mscz').trim(), source: opts.source, chunk: CHUNK, duration, sheet: 'scores/full', parts };
    const json = new TextEncoder().encode(JSON.stringify(meta, null, 2));
    project.push({ name: 'project.json', crc: crc32(json), data: new Blob([json]) });
    await Bun.write(out, writeZip(project)); // stored: the player slices entries out of the file
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) await render(...process.argv.slice(2, 4));
