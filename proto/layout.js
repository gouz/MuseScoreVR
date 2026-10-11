// Seat layout: each family is a block of chairs; blocks sit side by side on arcs ("tiers") facing the
// conductor at (0, 0), front to back in the score's family order. Pure function, no audio, so it is testable in node.
const SEAT = 1.1, ROW = 1.2, GAP = 0.6; // metres: chair to chair, row to row, between blocks
const R0 = 2.5, SPAN = 2.44, MAXCOLS = 4; // first arc radius (m), arc opening (rad, ±70°), block width (chairs)

// Seating presets (names: preset_<id> in i18n.js): arcs front to back, each a list of groups left to right (seen from the podium).
// A group is matched by MuseScore instrument id or family id; anything no group takes goes behind, in score order.
const PERC = ['timpani', 'keyboard-percussion', 'pitched-metal-percussion', 'unpitched-metal-percussion', 'unpitched-wooden-percussion',
  'drums', 'batterie', 'other-percussion', 'roto-toms', 'glass-percussion', 'orff-percussion'];
const VIOLINS = ['violin', 'violins'], VIOLAS = ['viola', 'violas'], CELLOS = ['violoncello', 'violoncellos'], BASSES = ['contrabass', 'contrabasses'];
export const PRESETS = {
  auto: { tiers: [] },
  symphonic: { tiers: [
    [VIOLINS, VIOLAS, CELLOS],
    [['harps', 'keyboards', 'organs'], ['flutes'], ['oboes'], BASSES],
    [['clarinets', 'saxophones'], ['bassoons']],
    [['horns', 'wagner-tubas'], ['trumpets', 'cornets'], ['trombones'], ['tubas', 'cimbassos']],
    [PERC],
  ] },
  band: { tiers: [
    [['flutes'], ['oboes'], ['clarinets']],
    [['bassoons'], ['saxophones'], ['horns']],
    [['trumpets', 'cornets', 'flugelhorns'], ['trombones'], ['euphoniums', 'baritone-horns', 'alto-horns', 'saxhorns'], ['tubas', 'sousaphones'], BASSES],
    [PERC, ['keyboards', 'harps']],
  ] },
  bigband: { tiers: [
    [['drums', 'batterie', 'guitars', 'bass-guitars', 'keyboards', ...BASSES], ['saxophones', 'clarinets', 'flutes']],
    [['trombones']],
    [['trumpets', 'flugelhorns', 'cornets']],
  ] },
};

// parts: [{ id, instrument, family, familyRank, count }], preset id -> seats: [{ part, copy, x, y }] (band at y < 0)
export function arrange(parts, preset = 'auto') {
  const tiers = (PRESETS[preset] ?? PRESETS.auto).tiers;
  const slot = p => { // [tier, group] of the first group that takes this part
    for (let t = 0; t < tiers.length; t++)
      for (let g = 0; g < tiers[t].length; g++) if (tiers[t][g].includes(p.instrument) || tiers[t][g].includes(p.family)) return [t, g];
    return null;
  };
  const groups = new Map(); // block key -> { tier, seats }; parts in score order within a block (stable sort)
  for (const p of [...parts].sort((a, b) => (a.familyRank ?? 0) - (b.familyRank ?? 0))) {
    const at = slot(p), key = at ? at.join(':') : 'f:' + (p.family ?? p.id);
    if (!groups.has(key)) groups.set(key, { tier: at ? at[0] : tiers.length, group: at ? at[1] : 0, seats: [] });
    for (let c = 0; c < p.count; c++) groups.get(key).seats.push({ part: p, copy: c });
  }
  const blocks = [...groups.values()].filter(g => g.seats.length).sort((a, b) => a.tier - b.tier || a.group - b.group) // unmatched keep score order
    .map(({ tier, seats }) => { const rows = Math.ceil(seats.length / MAXCOLS); return { tier, seats, rows, cols: Math.ceil(seats.length / rows) }; });

  let r = R0, tier = [];
  const width = bs => bs.reduce((w, b) => w + b.cols * SEAT, 0) + GAP * Math.max(0, bs.length - 1);
  const place = () => { // centre the tier's blocks on the arc, then move behind its deepest block
    if (tier[0].tier < tiers.length) r = Math.max(r, width(tier) / SPAN); // a preset arc is never split: it widens
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
    // a new preset arc, or this arc is full
    if (tier.length && (b.tier !== tier[0].tier || b.tier === tiers.length && width([...tier, b]) > SPAN * r)) place();
    tier.push(b);
  }
  if (tier.length) place();
  return [].concat(...blocks.map(b => b.seats)); // no flatMap: MuseScore's QML engine lacks it
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
