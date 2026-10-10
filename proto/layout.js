// Seat layout: each family is a block of chairs; blocks sit side by side on arcs ("tiers") facing the
// conductor at (0, 0), front to back in the score's family order. Pure function, no audio, so it is testable in node.
const SEAT = 1.1, ROW = 1.2, GAP = 0.6; // metres: chair to chair, row to row, between blocks
const R0 = 2.5, SPAN = 2.44, MAXCOLS = 4; // first arc radius (m), arc opening (rad, ±70°), block width (chairs)

// parts: [{ id, family, familyRank, count }] -> seats: [{ part, copy, x, y }] (band at y < 0)
export function arrange(parts) {
  const fams = new Map(); // families front to back, score order within a family (stable sort)
  for (const p of [...parts].sort((a, b) => (a.familyRank ?? 0) - (b.familyRank ?? 0)))
    for (let c = 0; c < p.count; c++) {
      const f = p.family ?? p.id;
      if (!fams.has(f)) fams.set(f, []);
      fams.get(f).push({ part: p, copy: c });
    }
  const blocks = [...fams.values()].map(seats => {
    const rows = Math.ceil(seats.length / MAXCOLS);
    return { seats, rows, cols: Math.ceil(seats.length / rows) };
  });

  let r = R0, tier = [];
  const width = bs => bs.reduce((w, b) => w + b.cols * SEAT, 0) + GAP * Math.max(0, bs.length - 1);
  const place = () => { // centre the tier's blocks on the arc, then move behind its deepest block
    let a = -width(tier) / 2 / r;
    for (const b of tier) {
      b.seats.forEach((s, i) => {
        const rr = r + Math.floor(i / b.cols) * ROW, ang = a + (i % b.cols + 0.5) * SEAT / r;
        s.x = rr * Math.sin(ang); s.y = -rr * Math.cos(ang);
      });
      a += (b.cols * SEAT + GAP) / r;
    }
    r += Math.max(...tier.map(b => b.rows)) * ROW; tier = [];
  };
  for (const b of blocks) {
    if (tier.length && width([...tier, b]) > SPAN * r) place();
    tier.push(b);
  }
  if (tier.length) place();
  return blocks.flatMap(b => b.seats);
}

// Instrument radiation: where the sound mostly goes, relative to a player facing the conductor
// (yaw: + = player's right, pitch: + = up, degrees), cone angles (degrees) and gain outside the cone.
// Broadband approximation of Meyer, "Acoustics and the Performance of Music": real directivity is mostly
// in the highs, so outer gains stay moderate. Keyed by MuseScore instrument id, then family id; anything
// not listed radiates evenly.
// ponytail: ids from MuseScore's instruments.xml as remembered, unmatched ones just stay omni — check against a real orchestral score
const RADIATION = {
  trumpets: [0, 0, 60, 200, 0.35], cornets: [0, 0, 70, 220, 0.4], flugelhorns: [0, 0, 80, 240, 0.45],
  trombones: [0, 0, 60, 200, 0.35],
  horns: [135, 0, 90, 270, 0.4], horn: [135, 0, 90, 270, 0.4], // bell points back-right
  tubas: [0, 80, 90, 270, 0.5], tuba: [0, 80, 90, 270, 0.5], euphonium: [20, 60, 90, 270, 0.5], // bell up
  saxophones: [0, 20, 120, 300, 0.6],
  clarinets: [0, -30, 140, 320, 0.65], oboes: [0, -30, 120, 300, 0.6], // tone holes + bell, down-forward
  bassoons: [0, 60, 140, 320, 0.65],
  flutes: [70, 0, 140, 320, 0.6], // embouchure and holes radiate to the player's right
  violin: [30, 60, 140, 320, 0.6], viola: [30, 60, 140, 320, 0.6], violoncello: [0, 0, 160, 330, 0.7],
  voices: [0, 0, 120, 300, 0.5],
};
// facing: [fx, fz] unit vector the player faces -> { dir: [x, y, z], inner, outer, gain } or null (omni)
export function radiation(part, [fx, fz]) {
  const r = RADIATION[part.instrument] ?? RADIATION[part.family];
  if (!r) return null;
  const [yaw, pitch, inner, outer, gain] = r, y = yaw * Math.PI / 180, p = pitch * Math.PI / 180, h = Math.cos(p);
  // forward = (fx, 0, fz), player's right = (-fz, 0, fx), up = (0, 1, 0)
  return { dir: [h * (Math.cos(y) * fx - Math.sin(y) * fz), Math.sin(p), h * (Math.cos(y) * fz + Math.sin(y) * fx)], inner, outer, gain };
}
