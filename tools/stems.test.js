// bun test — parts hidden in MuseScore are not rendered
import { test } from 'bun:test';
import assert from 'node:assert';
import { partNames } from './stems.js';

test('partNames skips hidden parts', () => {
  const part = (id, name, hidden) => `<Part id="${id}"><Staff><isStaffVisible>0</isStaffVisible></Staff>${hidden ? '<show>0</show>' : ''}<trackName>${name}</trackName></Part>`;
  assert.deepEqual([...partNames(part(1, 'Trompette', true) + part(2, 'Flûte') + part(3, 'Cor'))], [['2', 'Flûte'], ['3', 'Cor']]);
});
