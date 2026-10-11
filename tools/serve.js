// Serve proto/ over HTTPS so the Quest browser allows WebXR on the LAN.
//
// usage: bun tools/serve.js   (then open https://<pc-ip>:8443 on the Quest and accept the certificate warning)
// Needs .cert/cert.pem and .cert/key.pem (self-signed, see README).
import { resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '../proto'), cert = resolve(import.meta.dir, '../.cert');
const server = Bun.serve({
  port: 8443,
  hostname: '0.0.0.0',
  tls: { cert: Bun.file(`${cert}/cert.pem`), key: Bun.file(`${cert}/key.pem`) },
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 }); // stay inside proto/ (LAN-visible)
    const f = Bun.file(file);
    return (await f.exists()) ? new Response(f) : new Response('Not found', { status: 404 });
  },
});
console.log(`https://0.0.0.0:${server.port}`);
