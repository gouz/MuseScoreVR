// bun test
import { test } from 'bun:test';
import assert from 'node:assert';
import { sheet } from './sheet.js';

test('note timings from segments, with a rest and a repeat', () => {
  const staff = y0 => [0, 10, 20, 30, 40].map(d => `<polyline class="StaffLines" points="0,${y0 + d} 1000,${y0 + d}" />`).join('\n');
  const head = (cls, x, y) => `<path class="${cls}" transform="matrix(1,0,0,1,${x},${y})" d="M0,0 L10,-5 L10,5"/>`;
  const svg = `<svg viewBox="0 0 1000 1000">${staff(100)}${staff(500)}
    ${head('Note', 105, 120)}${head('Note', 305, 120)}${head('Rest', 505, 120)}${head('Note', 105, 520)}</svg>`;
  // segments: 3 on the first system, 1 on the second; then a repeat back to the first segment
  const seg = (id, x, y) => `<element id="${id}" x="${x * 12}" y="${y * 12}" sx="100" sy="${60 * 12}" page="0">`;
  const spos = `<score><elements>${seg(0, 100, 90)}${seg(1, 300, 90)}${seg(2, 500, 90)}${seg(3, 100, 490)}</elements><events>
    <event elid="0" position="0"><event elid="1" position="1000"><event elid="2" position="2000"><event elid="3" position="3000"><event elid="0" position="4000">
    </events></score>`;
  const s = sheet([svg], spos, 5);
  assert.deepEqual(s.size, [1000, 1000]);
  assert.deepEqual(s.turns, [[0, 0]]);
  const times = s.notes[0].map(n => n.slice(4)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(times, [[0, 1], [1, 2], [3, 4], [4, 5]]); // the rest stops a note; leaving the system stops it too
});
