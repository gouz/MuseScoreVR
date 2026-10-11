// MuseScoreVR server. The MuseScore plugin starts it (compiled into plugin/bin by tools/build-plugin.js)
// and stops it; `bun run serve` runs it from the repository while developing.
//
// usage: musescorevr [--web dir] [--data dir] [--mscore path]   (defaults: proto/, the repository, MuseScore's usual place)
//   Wi-Fi, HTTPS (WebXR needs a secure origin; self-signed certificate created on first run in <data>/.cert):
//     GET  /               headset page (<web>/index.html)
//     GET  /api/project    the last project sent
//     WS   /api/events     headsets listen here: { project: n } = fetch it, { cmd } = play|pause|stop
//   This PC only, HTTP (Qt refuses self-signed certificates), for the plugin:
//     GET  /api/status     { headsets, urls, job, project }   job: render progress { title, tasks, error }; project: the one being configured
//     POST /api/render     { path } or { names }, lang   render a .mscz into <data>/projects/, or reuse the last render of the same file;
//                          names: the open score's names, looked up in MuseScore's recent files (a plugin can't save a .mscz)
//     POST /api/send       { parts: [{ id, count }], seats, preset, sections, reverb, directivity }   save, send to the headsets
//     POST /api/config     same body as /api/send: saved for this score (<data>/projects/<slug>.json), kept across re-renders
//     POST /api/control    { cmd }
import { resolve, sep, join, basename } from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { networkInterfaces, homedir } from 'node:os';
import selfsigned from 'selfsigned';
import { render } from './stems.js';
import { readZip, writeZip, crc32 } from '../proto/zip.js';
import { t } from '../proto/i18n.js';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const plugin = arg('--data') !== undefined, repo = resolve(import.meta.dir, '..');
const web = resolve(arg('--web') ?? join(repo, 'proto')), data = resolve(arg('--data') ?? repo);
const projects = join(data, plugin ? 'projects' : 'proto/projects'), certs = join(data, '.cert');
const ips = Object.values(networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address); // no link-local

if (!(await Bun.file(join(certs, 'cert.pem')).exists())) {
  // ponytail: the PC's addresses at creation time; the Quest only warns about a mismatch if the address changes
  const pem = selfsigned.generate([{ name: 'commonName', value: 'musescorevr' }], { keySize: 2048, days: 3650, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...ips.map(ip => ({ type: 7, ip }))] }] });
  await mkdir(certs, { recursive: true });
  await Bun.write(join(certs, 'key.pem'), pem.private); await Bun.write(join(certs, 'cert.pem'), pem.cert);
}

let current = null, version = 0; // the project the headsets get
let job = null; // render in progress: { title, tasks, error }
let open = null; // { file, meta }: the rendered project being configured in the plugin
let lang = 'en'; // the plugin's, sent with each render

const lan = Bun.serve({
  port: 8443,
  hostname: '0.0.0.0',
  tls: { cert: Bun.file(join(certs, 'cert.pem')), key: Bun.file(join(certs, 'key.pem')) },
  async fetch(req, server) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === '/api/events') return server.upgrade(req) ? undefined : new Response('WebSocket expected', { status: 400 });
    if (path === '/api/project') return current ? new Response(current, { headers: { 'content-type': 'application/zip' } }) : new Response('No project', { status: 404 });
    const file = resolve(web, '.' + (path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(web + sep)) return new Response('Forbidden', { status: 403 }); // seen from the network: stay inside the web folder
    const f = Bun.file(file);
    return (await f.exists()) ? new Response(f) : new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) { ws.subscribe('headsets'); if (current) ws.send(JSON.stringify({ project: version })); },
    message() {},
  },
});
const headsets = () => lan.subscriberCount('headsets');

const readMeta = async file => JSON.parse(await (await (await readZip(Bun.file(file))).get('project.json').blob()).text());
const slug = name => name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().replace(/\s+/g, '-').toLowerCase() || 'score';

// MuseScore's recent files, most recent first: the score open in MuseScore is there once it has been saved
const RECENT = join({ darwin: join(homedir(), 'Library/Application Support'), win32: process.env.LOCALAPPDATA ?? '' }[process.platform]
  ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'MuseScore/MuseScore4/recent_files.json');
async function findScore(names) {
  const recent = await Bun.file(RECENT).json().catch(() => []);
  for (const r of recent) {
    const path = typeof r === 'string' ? r : r.path, shown = typeof r === 'string' ? '' : r.displayName;
    if (names.some(n => n && (n === shown || n === basename(path, '.mscz'))) && await Bun.file(path).exists()) return path;
  }
}

// the orchestra configured for a score, saved beside its render (<slug>.json): it outlives re-renders of an edited score
const configFile = zip => zip.replace(/\.zip$/, '.json');
const loadConfig = async zip => applyConfig(await readMeta(zip), await Bun.file(configFile(zip)).json().catch(() => ({})));
function applyConfig(meta, cfg) { // parts gone from the score are dropped, new ones keep their automatic count and seat
  const counts = new Map((cfg.parts ?? []).map(p => [String(p.id), Math.max(0, Math.min(8, p.count | 0))]));
  const has = k => cfg[k] !== undefined;
  return { ...meta, parts: meta.parts.map(p => ({ ...p, count: counts.get(p.id) ?? p.count })),
    seats: Array.isArray(cfg.seats) ? cfg.seats.map(s => ({ part: String(s.part), copy: s.copy | 0, x: +s.x || 0, y: +s.y || 0 })) : meta.seats,
    preset: typeof cfg.preset === 'string' ? cfg.preset : meta.preset, sections: has('sections') ? (cfg.sections === 'raw' ? 'raw' : 'decor') : meta.sections,
    reverb: has('reverb') ? Math.max(0, Math.min(1, +cfg.reverb || 0)) : meta.reverb, directivity: has('directivity') ? cfg.directivity !== false : meta.directivity };
}
async function saveConfig(cfg) { // parts left out of this render (muted in MuseScore...) keep their saved count and chairs
  open.meta = applyConfig(open.meta, cfg);
  const old = await Bun.file(configFile(open.file)).json().catch(() => ({})), here = new Set(open.meta.parts.map(p => p.id));
  cfg = { ...cfg, parts: [...(cfg.parts ?? []), ...(old.parts ?? []).filter(p => !here.has(String(p.id)))],
    seats: [...(cfg.seats ?? []), ...(old.seats ?? []).filter(s => !here.has(String(s.part)))] };
  await Bun.write(configFile(open.file), JSON.stringify(cfg, null, 2));
}

async function startRender(src, title) {
  const out = join(projects, slug(title) + '.zip');
  // same score content -> same render (an export from MuseScore changes the zip's dates, not its entries)
  const source = Bun.hash([...await readZip(Bun.file(src))].filter(([n]) => !n.startsWith('Thumbnails/')).map(([n, e]) => n + e.crc).join()).toString(16);
  const meta = await readMeta(out).catch(() => null);
  if (meta?.source === source) { open = { file: out, meta: await loadConfig(out) }; job = null; return; }
  await mkdir(projects, { recursive: true });
  open = null; job = { title, tasks: [] };
  render(src, out, tasks => { job.tasks = tasks; }, { title, source, mscore: arg('--mscore'), lang })
    .then(async () => { open = { file: out, meta: await loadConfig(out) }; job = null; })
    .catch(e => { job.error = e.message; });
}

async function send(cfg) { // save the configuration, write it into the project file, then hand it to the headsets
  await saveConfig(cfg);
  // Bun drops Bun.file() parts inside a new Blob: entries are read into memory before the file is replaced
  const files = [];
  for (const [name, e] of await readZip(Bun.file(open.file)))
    if (name !== 'project.json') files.push({ name, crc: e.crc, data: new Blob([await (await e.blob()).arrayBuffer()]) });
  const json = new TextEncoder().encode(JSON.stringify(open.meta, null, 2));
  files.push({ name: 'project.json', crc: crc32(json), data: new Blob([json]) });
  await Bun.write(open.file + '.tmp', writeZip(files)); await rename(open.file + '.tmp', open.file);
  current = Bun.file(open.file); version++;
  lan.publish('headsets', JSON.stringify({ project: version }));
}

Bun.serve({
  port: 8480,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname, body = () => req.json().catch(() => ({}));
    try {
      if (path === '/api/status') return Response.json({ headsets: headsets(), urls: ips.map(ip => `https://${ip}:${lan.port}/`), job,
        project: open && { ...open.meta, parts: open.meta.parts.map(({ chunks, ...p }) => p) } });
      if (path === '/api/render' && req.method === 'POST') {
        const { path, names = [], title, lang: l } = await body();
        if (l) lang = l;
        if (job && !job.error) return new Response(t(lang, 'busy'), { status: 409 });
        const src = path ?? await findScore(names);
        if (!src || !(await Bun.file(src).exists())) return new Response(t(lang, 'notFound'), { status: 400 });
        await startRender(src, title || basename(src, '.mscz')); return Response.json({ ok: true });
      }
      if (path === '/api/send' && req.method === 'POST') {
        if (!open) return new Response(t(lang, 'noProject'), { status: 409 });
        await send(await body()); return Response.json({ headsets: headsets() });
      }
      if (path === '/api/config' && req.method === 'POST') { // autosave from the plugin; nothing goes to the headsets
        if (!open) return new Response(t(lang, 'noProject'), { status: 409 });
        await saveConfig(await body()); return Response.json({ ok: true });
      }
      if (path === '/api/control' && req.method === 'POST') {
        const { cmd } = await body();
        if (!['play', 'pause', 'stop'].includes(cmd)) return new Response('Unknown command', { status: 400 });
        lan.publish('headsets', JSON.stringify({ cmd })); return Response.json({ headsets: headsets() });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) { return new Response(e.message, { status: 500 }); }
  },
});

// started by the plugin: stop with it. MuseScore holds our stdin open; it closes when MuseScore (or the plugin) goes away.
if (plugin) { process.stdin.on('end', () => process.exit(0)); process.stdin.on('close', () => process.exit(0)); process.stdin.resume(); }
console.log(`headset: ${ips.map(ip => `https://${ip}:${lan.port}/`).join(' ')} · plugin: http://127.0.0.1:8480`);
