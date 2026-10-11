// Shared by the configurator (config.html) and the headset player (index.html):
// project open/save, seat layout, streamed spatial audio, per-part level meters.
import { readZip, writeZip, crc32 } from './zip.js';
import { arrange, radiation } from './layout.js';

export const ctx = new AudioContext({ sampleRate: 44100 });
// mutable state the pages read; change it through the functions below
export const S = { project: null, parts: [], seats: [], listener: null, playing: false, duration: 0, sections: 'decor', reverb: 0.35, directivity: true, room: null, headTracked: false };
let zip = null, startAt = null, offset = 0, CHUNK = 10;

// --- audio graph ---------------------------------------------------------
const master = ctx.createGain(); master.connect(ctx.destination);
const revSend = ctx.createGain(), revGain = ctx.createGain(); revSend.gain.value = 0.15; revGain.connect(master);
const synthetic = (() => { // default hall: 2.2 s decaying stereo noise
  const len = 2.2 * ctx.sampleRate, b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / len) * 0.25; }
  return b;
})();
// the room is a convolution with an impulse response; the convolver normalises its level, so any hall fits
let reverb = null, roomBlob = null;
function useIR(buffer) { // a fresh node each time: some browsers refuse to change a convolver's buffer
  reverb?.disconnect(); reverb = new ConvolverNode(ctx, { buffer });
  revSend.disconnect(); revSend.connect(reverb).connect(revGain);
}
useIR(synthetic);
// blob: an impulse response file (wav, flac…) or null for the synthetic hall; stored in the project on save
export async function setRoom(blob, name) {
  useIR(blob ? await ctx.decodeAudioData(await blob.arrayBuffer()) : synthetic);
  roomBlob = blob; S.room = blob ? name : null;
}
export function setReverb(v) { S.reverb = v; revGain.gain.value = v; }
setReverb(S.reverb);

// --- streaming: tracks come as CHUNK-second FLAC slices, decoded just before they play,
// so memory stays at a few slices per part whatever the length of the piece
const cache = new Map(); // slice name -> Promise<AudioBuffer>
const load = name => { if (!cache.has(name)) cache.set(name, zip.get(name).blob().then(b => b.arrayBuffer()).then(b => ctx.decodeAudioData(b))); return cache.get(name); };
const LOOKAHEAD = 12; // seconds scheduled ahead of the playhead
const nodes = new Set(); // live sources & LFOs (sources leave on 'ended' so their buffers can be freed)
let gen = 0, next = 0, chains = [];

async function start() {
  stopNodes(); const my = gen; S.playing = true;
  const k0 = Math.floor(offset / CHUNK);
  await Promise.all(S.parts.map(p => p.count && p.chunks[k0] && load(p.chunks[k0])));
  if (my !== gen) return; // paused / sought while loading
  for (const s of S.seats) {
    const g = ctx.createGain(), pan = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 0.3, rolloffFactor: 1 });
    let out = g;
    if (S.sections === 'decor' && s.copy > 0) { // copy 0 stays exact so a solo part sounds unchanged
      // slowly modulated delay: timing offset + ~±10 cent pitch wobble that never accumulates
      g.gain.value = 10 ** ((Math.random() * 3 - 1.5) / 20);
      const d = ctx.createDelay(0.1), lfo = ctx.createOscillator(), depth = ctx.createGain();
      d.delayTime.value = 0.01 + Math.random() * 0.02;
      lfo.frequency.value = 0.1 + Math.random() * 0.2; depth.gain.value = 0.002 + Math.random() * 0.003;
      lfo.connect(depth).connect(d.delayTime); lfo.start(); nodes.add(lfo);
      out = g.connect(d);
    }
    out.connect(pan).connect(master); g.connect(revSend);
    s.in = g; s.pan = pan; chains.push(g, pan);
    if (s.copy === 0) { const an = ctx.createAnalyser(); an.fftSize = 1024; g.connect(an); s.part.an = an; chains.push(an); }
  }
  startAt = ctx.currentTime + 0.1; next = k0; placeAll(); pump();
}
function pump() {
  if (startAt == null) return;
  const my = gen;
  while (next * CHUNK < S.duration && startAt + next * CHUNK - offset < ctx.currentTime + LOOKAHEAD) {
    const k = next++, when = startAt + k * CHUNK - offset;
    for (const p of S.parts) if (p.count && p.chunks[k]) load(p.chunks[k]).then(buf => {
      if (my !== gen) return;
      const at = Math.max(when, startAt, ctx.currentTime + 0.02); // decoded late: join mid-slice, stay in sync
      for (const s of S.seats) if (s.part === p) {
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(s.in);
        src.onended = () => nodes.delete(src); src.start(at, at - when); nodes.add(src);
      }
    });
  }
  const cur = Math.floor(now() / CHUNK); // drop slices already played
  for (const p of S.parts) for (let k = 0; k < cur; k++) cache.delete(p.chunks[k]);
}
function stopNodes() {
  gen++; startAt = null;
  nodes.forEach(n => { try { n.stop(); } catch {} }); nodes.clear();
  chains.forEach(n => n.disconnect()); chains = []; S.parts.forEach(p => p.an = null);
}

// --- transport -----------------------------------------------------------
export function now() { return S.playing && startAt != null ? Math.max(offset, offset + ctx.currentTime - startAt) : offset; }
export function play() { ctx.resume(); if (!S.playing) start(); }
export function pause() { if (S.playing) { offset = now(); S.playing = false; stopNodes(); } }
export function stop() { S.playing = false; stopNodes(); offset = 0; }
export function seek(t) { offset = t; if (S.playing) start(); }
export function restart() { if (S.playing) { offset = now(); start(); } } // after seats or sections changed
setInterval(() => { pump(); if (S.playing && now() >= S.duration) stop(); }, 250);

// --- activity: each part's level drives its cubes; measured on the dry signal, so it ignores where you sit
const wave = new Float32Array(1024);
export function meter() {
  for (const p of S.parts) {
    let v = 0;
    if (p.an) {
      p.an.getFloatTimeDomainData(wave);
      let sum = 0; for (const x of wave) sum += x * x;
      v = Math.min(1, Math.max(0, (10 * Math.log10(sum / wave.length + 1e-12) + 50) / 40)); // -50 dB → 0, -10 dB → 1
    }
    p.level = v > (p.level || 0) ? v : (p.level || 0) * 0.92; // instant attack, ~0.2 s release at 60 fps
  }
}

// --- listener ------------------------------------------------------------
// audio coords = three.js coords: x right, y up, z toward the conductor's back; band sits at z < 0
// unit vector a seat faces: musicians face the conductor, the conductor faces the band
export function facing(seat) {
  if (!seat) return [0, -1];
  const n = Math.hypot(seat.x, seat.y) || 1; return [-seat.x / n, -seat.y / n];
}
export function setHead(x, y, z, fx, fy, fz, ux = 0, uy = 1, uz = 0) {
  const L = ctx.listener; set(L, 'position', x, y, z);
  if (L.forwardX) { L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz; L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz; }
  else L.setOrientation(fx, fy, fz, ux, uy, uz);
}
export function placeAll() {
  const me = S.listener || { x: 0, y: 0 }, [fx, fz] = facing(S.listener);
  if (!S.headTracked) setHead(me.x, 1.2, me.y, fx, 0, fz); // in VR the head drives the listener
  for (const s of S.seats) if (s.pan) {
    // own instrument: ~40 cm in front of the seat, slightly below the ears
    const own = s === S.listener;
    set(s.pan, 'position', own ? me.x + 0.4 * fx : s.x, own ? 1.0 : 1.2, own ? me.y + 0.4 * fz : s.y);
    // own instrument stays omni: a player hears it all around, and it must dominate
    const rad = S.directivity && !own && radiation(s.part, facing(s));
    if (rad) set(s.pan, 'orientation', ...rad.dir);
    Object.assign(s.pan, rad ? { coneInnerAngle: rad.inner, coneOuterAngle: rad.outer, coneOuterGain: rad.gain } : { coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 1 });
  }
}
export function sitAt(seat) { S.listener = seat; placeAll(); } // null = conductor
function set(o, k, x, y, z) { if (o[k + 'X']) { o[k + 'X'].value = x; o[k + 'Y'].value = y; o[k + 'Z'].value = z; } else o['set' + k[0].toUpperCase() + k.slice(1)](x, y, z); }

// --- layout --------------------------------------------------------------
const key = s => s.part.id + ':' + s.copy;
export const seatName = s => s.part.name + (s.part.count > 1 ? ' #' + (s.copy + 1) : '');
export function layout() { // rebuild seats from part counts; chairs the user moved keep their place
  const prev = new Map(S.seats.map(s => [key(s), s]));
  const list = arrange(S.parts);
  for (const s of list) { const o = prev.get(key(s)); if (o && o.moved) Object.assign(s, { x: o.x, y: o.y, moved: true }); }
  const was = S.listener && key(S.listener);
  S.seats = list; S.listener = S.seats.find(s => key(s) === was) || null;
}

// --- project file --------------------------------------------------------
export async function openProject(file) {
  stop(); cache.clear();
  zip = await readZip(file);
  if (!zip.has('project.json')) throw new Error('project.json absent du zip');
  const project = S.project = JSON.parse(await (await zip.get('project.json').blob()).text());
  S.parts = project.parts; S.duration = project.duration; CHUNK = project.chunk;
  S.parts.forEach(p => p.count ??= 1);
  // one hue per family, spread over the colour wheel in the score's family order
  const fams = [...new Set([...S.parts].sort((a, b) => (a.familyRank ?? 0) - (b.familyRank ?? 0)).map(p => p.family ?? p.id))];
  S.parts.forEach(p => p.hue = fams.indexOf(p.family ?? p.id) * 360 / fams.length);
  S.sections = project.sections === 'raw' ? 'raw' : 'decor';
  setReverb(project.reverb ?? 0.35);
  S.directivity = project.directivity ?? true;
  await setRoom(project.room && zip.has(project.room.file) ? await zip.get(project.room.file).blob() : null, project.room?.name);
  S.seats = []; S.listener = null; layout();
  const saved = new Map((project.seats || []).map(s => [s.part + ':' + s.copy, s]));
  for (const s of S.seats) { const o = saved.get(key(s)); if (o) Object.assign(s, { x: o.x, y: o.y, moved: true }); }
  placeAll();
  return project;
}
export async function saveProject() { // -> Blob; audio entries are referenced from the open file, not copied in memory
  const meta = { ...S.project, parts: S.parts.map(({ an, level, hue, ...p }) => p),
    seats: S.seats.map(s => ({ part: s.part.id, copy: s.copy, x: +s.x.toFixed(2), y: +s.y.toFixed(2) })),
    sections: S.sections, reverb: S.reverb, directivity: S.directivity, room: null };
  const files = [];
  for (const [name, e] of zip) if (name !== 'project.json' && name !== S.project.room?.file) files.push({ name, crc: e.crc, data: await e.blob() });
  if (roomBlob) { // the room may come from the open project or a file just picked: either way, write it again
    const ext = (S.room.match(/\.(wav|flac|ogg|mp3|m4a)$/i)?.[0] ?? '.wav').toLowerCase();
    meta.room = { file: 'room' + ext, name: S.room };
    files.push({ name: meta.room.file, crc: crc32(new Uint8Array(await roomBlob.arrayBuffer())), data: roomBlob });
  }
  const json = new TextEncoder().encode(JSON.stringify(meta, null, 2)); // after meta.room is known
  files.push({ name: 'project.json', crc: crc32(json), data: new Blob([json]) });
  return writeZip(files);
}
export const file = name => zip.get(name).blob(); // any entry of the open project (scores…)
// ?project=projects/x.zip loads a project served next to the page
export async function projectFromUrl() {
  const url = new URLSearchParams(location.search).get('project');
  if (!url) return null;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} : ${r.status}`);
  return r.blob();
}
