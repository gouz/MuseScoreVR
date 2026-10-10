// node proto/layout.test.mjs
import { arrange, radiation } from './layout.js';
import assert from 'node:assert';

const fam = (family, familyRank, ...counts) => counts.map((count, i) => ({ id: family + i, family, familyRank, count }));
const parts = [...fam('trumpets', 6, 3, 3), ...fam('flutes', 0, 1, 1), ...fam('clarinets', 2, 1, 1, 1), ...fam('saxophones', 3, 1, 1, 1, 1), ...fam('drums', 13, 1)];
const seats = arrange(parts);

assert.equal(seats.length, 16);
// no two chairs closer than a chair width
for (const a of seats) for (const b of seats) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 1, 'chairs overlap');
// everyone in front of the conductor, within ±70°
for (const s of seats) assert.ok(s.y < 0 && Math.abs(Math.atan2(s.x, -s.y)) <= 1.23);
// families are blocks: no other family's chair inside a family's angular × radial extent
const box = f => {
  const ss = seats.filter(s => s.part.family === f), ang = ss.map(s => Math.atan2(s.x, -s.y)), rad = ss.map(s => Math.hypot(s.x, s.y));
  return [Math.min(...ang), Math.max(...ang), Math.min(...rad), Math.max(...rad)];
};
for (const f of ['flutes', 'clarinets', 'saxophones', 'trumpets']) {
  const [a0, a1, r0, r1] = box(f);
  for (const s of seats.filter(s => s.part.family !== f)) {
    const a = Math.atan2(s.x, -s.y), r = Math.hypot(s.x, s.y);
    assert.ok(!(a >= a0 && a <= a1 && r >= r0 && r <= r1), `${s.part.id} inside ${f} block`);
  }
}
// front to back: flutes are nearer the conductor than trumpets, drums furthest
const dist = f => Math.min(...seats.filter(s => s.part.family === f).map(s => Math.hypot(s.x, s.y)));
assert.ok(dist('flutes') < dist('trumpets') && dist('trumpets') < dist('drums'));
// 6 trumpets → 2 rows of 3
assert.equal(new Set(seats.filter(s => s.part.family === 'trumpets').map(s => Math.hypot(s.x, s.y).toFixed(2))).size, 2);
// radiation: player at (0, -3) faces the conductor, i.e. +z
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
assert.ok(near(radiation({ family: 'trumpets' }, [0, 1]).dir, [0, 0, 1]), 'trumpet bell toward the conductor');
const h = radiation({ instrument: 'horn', family: 'horns' }, [0, 1]).dir; // player's right is -x when facing +z
assert.ok(h[0] < 0 && h[2] < 0, 'horn bell back-right');
assert.ok(radiation({ family: 'tubas' }, [0, 1]).dir[1] > 0.9, 'tuba bell up');
assert.equal(radiation({ family: 'drums' }, [0, 1]), null);
console.log('ok');
