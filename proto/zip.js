// Minimal ZIP, no zip64. Writes stored (uncompressed) entries only: project audio is already FLAC, and storing
// lets the player slice entries straight out of the File without loading it. Reads stored and deflated entries
// (a .mscz is deflated).

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
export function crc32(bytes) { let c = ~0; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; }

// returns Map name -> { crc, size, blob() }; blob() is the uncompressed content
export async function readZip(file) {
  const tailLen = Math.min(file.size, 22 + 0xffff); // end record + max comment
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let e = tailLen - 22;
  while (e >= 0 && tail.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = new Map(), utf8 = new TextDecoder();
  for (let i = 0, p = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip');
    const method = cd.getUint16(p + 10, true), crc = cd.getUint32(p + 16, true), size = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const off = cd.getUint32(p + 42, true), name = utf8.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported compression ${method}`);
    entries.set(name, {
      crc, size,
      async blob() { // local header's name/extra lengths can differ from the central directory's
        const h = new DataView(await file.slice(off, off + 30).arrayBuffer());
        const start = off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
        const raw = file.slice(start, start + size);
        return method === 8 ? new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob() : raw;
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// files: [{ name, data: Blob, crc }] -> Blob (data blobs are referenced, not copied)
export function writeZip(files) {
  const utf8 = new TextEncoder(), out = [], central = [];
  const rec = (fields, name) => { // fields: [bytes, value][]
    const b = new DataView(new ArrayBuffer(fields.reduce((n, [s]) => n + s, 0)));
    let p = 0; for (const [s, v] of fields) { s === 2 ? b.setUint16(p, v, true) : b.setUint32(p, v, true); p += s; }
    return [b, name];
  };
  let off = 0;
  for (const f of files) {
    const name = utf8.encode(f.name), size = f.data.size;
    // version, flags (utf-8 names), method stored, time, date 1980-01-01, crc, sizes, name length, extra length
    const common = [[2, 0x800], [2, 0], [2, 0], [2, 0x21], [4, f.crc], [4, size], [4, size], [2, name.length], [2, 0]];
    const local = rec([[4, 0x04034b50], [2, 20], ...common], name);
    out.push(...local, f.data);
    central.push(...rec([[4, 0x02014b50], [2, 20], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, off]], name));
    off += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, x) => n + x.byteLength, 0);
  const end = rec([[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, cdSize], [4, off], [2, 0]]);
  return new Blob([...out, ...central, end[0]], { type: 'application/zip' });
}
