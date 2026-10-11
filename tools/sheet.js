// Turn MuseScore's page SVGs + segment timings (.spos) into what a music stand needs:
// when to show which page, and when each notehead sounds (to colour it while it plays).
//
// MuseScore exports, in one batch run (`mscore -j job.json`): page SVGs (<name>-<n>.svg) and a .spos file,
// whose <element>s are score segments (x, y, size of their system, page; 12 units per SVG unit)
// and whose <event>s give the time (ms) each segment plays — several times when there are repeats.

const SPOS = 12; // .spos units per SVG unit
const num = s => s.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);

// noteheads, rests, multi-measure rests: [class, x0, y0, x1, y1] in page units
function marks(svg) {
  const out = [];
  for (const [, cls, attrs] of svg.matchAll(/<(?:path|polyline) class="(Note|Rest|MMRest)"([^>]*)>/g)) {
    const [a, , , d, e, f] = attrs.match(/transform="matrix\(([^)]*)\)"/) ? num(attrs.match(/transform="matrix\(([^)]*)\)"/)[1]) : [1, 0, 0, 1, 0, 0];
    const pts = num(attrs.match(/ (?:d|points)="([^"]*)"/)[1]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) { // path data here is absolute M/C/L pairs only
      const x = a * pts[i] + e, y = d * pts[i + 1] + f;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    out.push([cls, x0, y0, x1, y1]);
  }
  return out;
}

// staff index of a y, from the page's staff lines (lines closer than 2 line gaps belong to one staff)
function staves(svg) {
  const ys = [...new Set([...svg.matchAll(/class="StaffLines"[^>]*points="[\d.]+,([\d.]+)/g)].map(m => +m[1]))].sort((a, b) => a - b);
  const gap = Math.min(...ys.slice(1).map((y, i) => y - ys[i]));
  const tops = ys.filter((y, i) => !i || y - ys[i - 1] > 2 * gap);
  return y => { let best = 0; for (let i = 0; i < ys.length; i++) if (Math.abs(ys[i] - y) < Math.abs(ys[best] - y)) best = i; return tops.findLastIndex(t => t <= ys[best]); };
}

// svgs: page SVG texts in order; spos: .spos text; end: piece duration (s), when the last notes stop
export function sheet(svgs, spos, end) {
  const segs = new Map([...spos.matchAll(/<element id="(\d+)" x="([-\d.]+)" y="([-\d.]+)" sx="[-\d.e]+" sy="([-\d.e]+)" page="(\d+)"/g)]
    .map(([, id, x, y, h, page]) => [id, { x: x / SPOS, y: y / SPOS, h: h / SPOS, page: +page, times: [] }]));
  for (const [, id, ms] of spos.matchAll(/<event elid="(\d+)" position="(\d+)"/g)) segs.get(id)?.times.push(ms / 1000);
  const byPage = svgs.map((_, p) => [...segs.values()].filter(s => s.page === p));

  // each mark belongs to the last segment starting at or before it, in the nearest system
  const placed = []; // { page, staff, seg, box, note }
  svgs.forEach((svg, page) => {
    const staffOf = staves(svg);
    for (const [cls, x0, y0, x1, y1] of marks(svg)) {
      const cy = (y0 + y1) / 2, dy = s => Math.max(0, s.y - cy, cy - s.y - s.h);
      const near = Math.min(...byPage[page].map(dy));
      // ponytail: a notehead pushed left of its stem (seconds) can sit left of the segment start; half a head of slack covers it
      const seg = byPage[page].filter(s => dy(s) === near && s.x <= x0 + (x1 - x0) / 2).reduce((b, s) => (!b || s.x > b.x ? s : b), null);
      if (seg) placed.push({ page, staff: `${page}:${staffOf(cy)}`, seg, box: [x0, y0, x1, y1], note: cls === 'Note' });
    }
  });

  // a note sounds until the next note or rest on its staff (ponytail: voices sharing a staff cut each other short)
  const stops = new Map(); // staff -> sorted times something starts on it
  for (const m of placed) { const l = stops.get(m.staff) ?? []; l.push(...m.seg.times); stops.set(m.staff, l); }
  for (const l of stops.values()) l.sort((a, b) => a - b);
  // nor past the moment playback leaves its system (a note held over the line is tied: the next notehead takes over)
  const timeline = [...segs.values()].flatMap(s => s.times.map(t => [t, s])).sort((a, b) => a[0] - b[0]);
  const sys = s => `${s.page}:${s.y}`;
  const after = (l, t) => l.find(x => x > t + 1e-6);

  const notes = svgs.map(() => []);
  for (const m of placed) if (m.note) for (const t of m.seg.times) {
    const leave = timeline.find(([u, s]) => u > t + 1e-6 && sys(s) !== sys(m.seg))?.[0];
    const t1 = Math.min(after(stops.get(m.staff), t) ?? end, leave ?? end, end);
    notes[m.page].push([...m.box.map(v => +v.toFixed(1)), +t.toFixed(3), +t1.toFixed(3)]);
  }
  // page shown at a time = page of the last segment played; one entry per page change
  const turns = [];
  for (const [t, { page }] of timeline) if (turns.at(-1)?.[1] !== page) turns.push([+t.toFixed(3), page]);
  const [, , w, h] = num(svgs[0].match(/viewBox="([^"]*)"/)[1]);
  return { size: [w, h], pages: svgs.length, turns, notes };
}
