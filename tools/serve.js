// MuseScoreVR server. The MuseScore plugin starts it (compiled into plugin/bin by tools/build-plugin.js)
// and stops it; `bun run serve` runs it from the repository while developing.
//
// usage: musescorevr [--web dir] [--data dir] [--mscore path]   (defaults: proto/, the repository, MuseScore's usual place)
//   Wi-Fi, HTTPS (WebXR needs a secure origin; self-signed certificate created on first run in <data>/.cert):
//     GET  /               headset page (<web>/index.html)
//     GET  /api/project    the last project sent
//     WS   /api/events     headsets listen here: { project: n } = fetch it, { cmd } = play|pause|stop
//   This PC only, HTTP (Qt refuses self-signed certificates), for the plugin:
//     GET  /api/status     { headsets, urls, job, project }   job: render progress; project: the one being configured
//     POST /api/render     { path }   render a .mscz into <data>/projects/, or reuse the last render of the same file
//     POST /api/send       { parts: [{ id, count }], seats, sections, reverb, directivity }   save, send to the headsets
//     POST /api/control    { cmd }
import { resolve, sep, join, basename } from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';
import { render } from './stems.js';
import { readZip, writeZip, crc32 } from '../proto/zip.js';

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
let job = null; // render in progress: { title, msg, done, total, error }
let open = null; // { file, meta }: the rendered project being configured in the plugin

const lan = Bun.serve({
  port: 8443,
  hostname: '0.0.0.0',
  tls: { cert: Bun.file(join(certs, 'cert.pem')), key: Bun.file(join(certs, 'key.pem')) },
  async fetch(req, server) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === '/api/events') return server.upgrade(req) ? undefined : new Response('WebSocket attendu', { status: 400 });
    if (path === '/api/project') return current ? new Response(current, { headers: { 'content-type': 'application/zip' } }) : new Response('Aucun projet', { status: 404 });
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
const slug = name => name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().replace(/\s+/g, '-').toLowerCase() || 'partition';

async function startRender(src, title) {
  const out = join(projects, slug(title) + '.zip');
  // same score content -> same render (an export from MuseScore changes the zip's dates, not its entries)
  const source = Bun.hash([...await readZip(Bun.file(src))].filter(([n]) => !n.startsWith('Thumbnails/')).map(([n, e]) => n + e.crc).join()).toString(16);
  const meta = await readMeta(out).catch(() => null);
  if (meta?.source === source) { open = { file: out, meta }; job = null; return; }
  await mkdir(projects, { recursive: true });
  open = null; job = { title, msg: 'Rendu par MuseScore…', done: 0, total: 1 };
  render(src, out, (msg, done, total) => Object.assign(job, { msg, done, total }), { title, source, mscore: arg('--mscore') })
    .then(async () => { open = { file: out, meta: await readMeta(out) }; job = null; })
    .catch(e => { job.error = e.message; });
}

async function send(cfg) { // write the configuration into the project file, then hand it to the headsets
  const counts = new Map((cfg.parts ?? []).map(p => [String(p.id), Math.max(0, Math.min(8, p.count | 0))]));
  const meta = { ...open.meta, parts: open.meta.parts.map(p => ({ ...p, count: counts.get(p.id) ?? p.count })),
    seats: (cfg.seats ?? []).map(s => ({ part: String(s.part), copy: s.copy | 0, x: +s.x || 0, y: +s.y || 0 })),
    sections: cfg.sections === 'raw' ? 'raw' : 'decor', reverb: Math.max(0, Math.min(1, +cfg.reverb || 0)), directivity: cfg.directivity !== false };
  // Bun drops Bun.file() parts inside a new Blob: entries are read into memory before the file is replaced
  const files = [];
  for (const [name, e] of await readZip(Bun.file(open.file)))
    if (name !== 'project.json') files.push({ name, crc: e.crc, data: new Blob([await (await e.blob()).arrayBuffer()]) });
  const json = new TextEncoder().encode(JSON.stringify(meta, null, 2));
  files.push({ name: 'project.json', crc: crc32(json), data: new Blob([json]) });
  await Bun.write(open.file + '.tmp', writeZip(files)); await rename(open.file + '.tmp', open.file);
  open.meta = meta; current = Bun.file(open.file); version++;
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
        if (job && !job.error) return new Response('Un rendu est déjà en cours', { status: 409 });
        const { path: src, title } = await body();
        if (!src || !(await Bun.file(src).exists())) return new Response('Partition introuvable', { status: 400 });
        await startRender(src, title || basename(src, '.mscz')); return Response.json({ ok: true });
      }
      if (path === '/api/send' && req.method === 'POST') {
        if (!open) return new Response('Aucun projet', { status: 409 });
        await send(await body()); return Response.json({ headsets: headsets() });
      }
      if (path === '/api/control' && req.method === 'POST') {
        const { cmd } = await body();
        if (!['play', 'pause', 'stop'].includes(cmd)) return new Response('Commande inconnue', { status: 400 });
        lan.publish('headsets', JSON.stringify({ cmd })); return Response.json({ headsets: headsets() });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) { return new Response(e.message, { status: 500 }); }
  },
});

// started by the plugin: stop with it. MuseScore holds our stdin open; it closes when MuseScore (or the plugin) goes away.
if (plugin) { process.stdin.on('end', () => process.exit(0)); process.stdin.on('close', () => process.exit(0)); process.stdin.resume(); }
console.log(`casque : ${ips.map(ip => `https://${ip}:${lan.port}/`).join(' ')} · plugin : http://127.0.0.1:8480`);
