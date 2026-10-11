// Serve proto/ over HTTPS (the Quest needs it for WebXR) and relay projects from the configurator to headsets.
//
// usage: bun tools/serve.js [--open]   (--open: also opens the configurator on this PC; then open https://<pc-ip>:8443 on the Quest and accept the certificate warning)
// Needs .cert/cert.pem and .cert/key.pem (self-signed, see README).
//   POST /api/project   configurator sends a project zip; every connected headset is told to load it
//   GET  /api/project   the last project sent
//   POST /api/control   {cmd: play|pause|stop} forwarded to every headset
//   WS   /api/events    headsets listen here; on connect they get the current project, if any
import { resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '../proto'), cert = resolve(import.meta.dir, '../.cert');
let current = null, version = 0; // ponytail: last project kept in memory only, lost on restart — the configurator just sends it again

const server = Bun.serve({
  port: 8443,
  hostname: '0.0.0.0',
  maxRequestBodySize: 2 ** 31, // projects are a few hundred MB of FLAC
  tls: { cert: Bun.file(`${cert}/cert.pem`), key: Bun.file(`${cert}/key.pem`) },
  async fetch(req, server) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === '/api/events') return server.upgrade(req) ? undefined : new Response('WebSocket attendu', { status: 400 });
    if (path === '/api/project' && req.method === 'POST') {
      current = await req.blob(); version++;
      server.publish('headsets', JSON.stringify({ project: version }));
      return Response.json({ headsets: server.subscriberCount('headsets') });
    }
    if (path === '/api/control' && req.method === 'POST') {
      const { cmd } = await req.json().catch(() => ({}));
      if (!['play', 'pause', 'stop'].includes(cmd)) return new Response('Commande inconnue', { status: 400 });
      server.publish('headsets', JSON.stringify({ cmd }));
      return Response.json({ headsets: server.subscriberCount('headsets') });
    }
    if (path === '/api/project') return current ? new Response(current, { headers: { 'content-type': 'application/zip' } }) : new Response('Aucun projet', { status: 404 });

    const file = resolve(root, '.' + (path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 }); // stay inside proto/ (LAN-visible)
    const f = Bun.file(file);
    return (await f.exists()) ? new Response(f) : new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe('headsets');
      if (current) ws.send(JSON.stringify({ project: version }));
    },
    message() {},
  },
});
console.log(`https://0.0.0.0:${server.port}`);
if (process.argv.includes('--open')) { // configurator in this PC's browser
  const url = `https://localhost:${server.port}/config.html`;
  Bun.spawn({ darwin: ['open', url], win32: ['cmd', '/c', 'start', '', url] }[process.platform] ?? ['xdg-open', url]);
}
