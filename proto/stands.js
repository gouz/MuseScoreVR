// Music stands: a score open like a book (two pages side by side) with its noteheads lit while they sound.
// One Sheet per score (shared by every copy of a part); each stand only adds a mesh.
// Data from tools/sheet.js: <dir>/<n>.svg pages + <dir>/sheet.json { size, pages, turns, notes }.
import * as THREE from 'three';

const UNITS_PER_M = 47244; // MuseScore's SVG units: 1200 per inch
const disc = (() => { // soft-edged ellipse laid over each notehead
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.beginPath(); g.ellipse(32, 32, 30, 30, 0, 0, 2 * Math.PI); g.fill();
  return new THREE.CanvasTexture(c);
})();
const quad = new THREE.PlaneGeometry(1, 1);

export class Sheet {
  // file(name) -> Promise<Blob>; px: texture width of the open book; scale: paper size (conductors read a bigger format)
  constructor(dir, data, file, { hue = 0, px = 1536, scale = 1 } = {}) {
    Object.assign(this, { dir, data, file, spread: -1, token: 0 });
    const [w, h] = data.size;
    this.width = 2 * w / UNITS_PER_M * scale; this.height = h / UNITS_PER_M * scale;
    this.canvas = Object.assign(document.createElement('canvas'), { width: px, height: Math.round(px * h / (2 * w)) });
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.anisotropy = 8;
    this.lit = new THREE.MeshBasicMaterial({ map: disc, color: new THREE.Color().setHSL(hue / 360, 0.9, 0.5), transparent: true, opacity: 0.85, depthWrite: false });
    this.max = Math.max(0, ...data.notes.map((n, i) => n.length + (data.notes[i + 1]?.length ?? 0)));
    this.matrices = new THREE.InstancedBufferAttribute(new Float32Array(16 * Math.max(1, this.max)), 16);
    this.boxes = []; this.lits = []; // overlays of every stand showing this sheet
  }
  static async load(dir, file, opts) { return new Sheet(dir, JSON.parse(await (await file(dir + '/sheet.json')).text()), file, opts); }

  page(t) { let p = 0; for (const [u, page] of this.data.turns) { if (u > t) break; p = page; } return p; }

  async open(spread) { // draw pages 2k and 2k+1, and place an overlay on each of their noteheads
    this.spread = spread; const my = ++this.token;
    const [w, h] = this.data.size, g = this.canvas.getContext('2d'), half = this.canvas.width / 2;
    const imgs = await Promise.all([0, 1].map(async i => {
      const p = 2 * spread + i; if (p >= this.data.pages) return null;
      const img = new Image(); img.src = URL.createObjectURL(new Blob([await this.file(`${this.dir}/${p}.svg`)], { type: 'image/svg+xml' }));
      try { await img.decode(); } finally { URL.revokeObjectURL(img.src); }
      return img;
    }));
    if (my !== this.token) return; // turned again meanwhile
    g.fillStyle = '#fbf8f0'; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    imgs.forEach((img, i) => img && g.drawImage(img, i * half, 0, half, this.canvas.height));
    this.texture.needsUpdate = true;
    // noteheads in metres on the book, origin at its centre
    const m = new THREE.Matrix4(), W = this.width, H = this.height;
    this.boxes = [0, 1].flatMap(i => (this.data.notes[2 * spread + i] ?? []).map(([x0, y0, x1, y1, t0, t1]) => {
      const e = m.compose(new THREE.Vector3(((x0 + x1) / 2 + i * w) / (2 * w) * W - W / 2, H / 2 - (y0 + y1) / 2 / h * H, 0.002),
        new THREE.Quaternion(), new THREE.Vector3((x1 - x0) / (2 * w) * W * 1.4, (y1 - y0) / h * H * 1.4, 1)).elements.slice();
      return { e, t0, t1 };
    }));
  }

  update(t) { // once per frame
    const spread = Math.floor(this.page(t) / 2);
    if (spread !== this.spread) this.open(spread);
    let n = 0; const a = this.matrices.array;
    for (const b of this.boxes) if (b.t0 <= t && t < b.t1) a.set(b.e, 16 * n++);
    this.matrices.needsUpdate = true;
    for (const lit of this.lits) lit.count = n;
  }

  // the open book, to put on a stand
  stand() {
    const book = new THREE.Mesh(new THREE.PlaneGeometry(this.width, this.height), new THREE.MeshBasicMaterial({ map: this.texture }));
    const lit = new THREE.InstancedMesh(quad, this.lit, Math.max(1, this.max));
    lit.instanceMatrix = this.matrices; lit.frustumCulled = false; lit.count = 0;
    const back = new THREE.Mesh(book.geometry, new THREE.MeshStandardMaterial({ color: 0x222222 })); back.rotation.y = Math.PI;
    book.add(lit, back); this.lits.push(lit);
    return book;
  }
}
