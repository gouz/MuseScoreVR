// bun test
import { test } from 'bun:test';
import assert from 'node:assert';
import { arrange, radiation } from './layout.js';

test('family blocks and instrument radiation', () => {

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
});

test('presets: symphonic strings in front, big band rows', () => {
  const p = (instrument, family, familyRank) => ({ id: instrument, instrument, family, familyRank, count: 2 });
  const parts = [p('flute', 'flutes', 0), p('horn', 'horns', 4), p('timpani', 'timpani', 8), p('violin', 'strings', 10), p('viola', 'strings', 11), p('violoncello', 'strings', 12), p('contrabass', 'strings', 13), p('kazoo', 'kazoos', 14)];
  const seats = arrange(parts, 'symphonic'), d = id => Math.min(...seats.filter(s => s.part.id === id).map(s => Math.hypot(s.x, s.y)));
  const x = id => seats.filter(s => s.part.id === id)[0].x;
  assert.equal(seats.length, 16);
  assert.ok(d('violin') < d('flute') && d('flute') < d('horn') && d('horn') < d('timpani') && d('timpani') < d('kazoo'), 'arcs front to back, unknown last');
  assert.ok(x('violin') < x('viola') && x('viola') < x('violoncello'), 'violins left, cellos right');
  assert.ok(x('contrabass') > x('flute'), 'basses on the right');
  const bb = arrange([p('bb-trumpet', 'trumpets', 0), p('alto-saxophone', 'saxophones', 1), p('trombone', 'trombones', 2)], 'bigband');
  const db = id => Math.hypot(bb.find(s => s.part.id === id).x, bb.find(s => s.part.id === id).y);
  assert.ok(db('alto-saxophone') < db('trombone') && db('trombone') < db('bb-trumpet'));
  assert.deepEqual(arrange(parts).length, arrange(parts, 'nope').length); // unknown preset = score order
});
