// bun test — parts hidden or muted in MuseScore are not rendered; the mixer's reverb sends carry over
import { test } from 'bun:test';
import assert from 'node:assert';
import { partNames, audible, reverbSend } from './stems.js';

test('partNames skips hidden parts', () => {
  const part = (id, name, hidden) => `<Part id="${id}"><Staff><isStaffVisible>0</isStaffVisible></Staff>${hidden ? '<show>0</show>' : ''}<trackName>${name}</trackName></Part>`;
  assert.deepEqual([...partNames(part(1, 'Trompette', true) + part(2, 'Flûte') + part(3, 'Cor'))], [['2', 'Flûte'], ['3', 'Cor']]);
});

test('audible follows the mixer: solo wins, else muted parts are out', () => {
  const mix = (...st) => ({ tracks: st.map(([id, mute, solo]) => ({ partId: id, soloMuteState: { mute, solo } })) });
  assert.deepEqual(audible(mix(['1', true, false], ['2', false, false]), ['1', '2']), ['2']);
  assert.deepEqual(audible(mix(['1', false, true], ['2', false, false], ['3', true, true]), ['1', '2', '3']), ['1', '3']);
  assert.deepEqual(audible(mix(['1', true, false]), ['1']), ['1']); // all muted: render anyway
});

test('reverbSend counts only active sends to a reverb bus', () => {
  const reverb = { out: { volumeDb: 0, fxChain: { 0: { active: true, resourceMeta: { id: 'Muse Reverb' } } } } }, empty = { out: { volumeDb: 0, fxChain: {} } };
  const track = sends => ({ aux: [reverb, empty], tracks: [{ partId: '9', out: { auxSends: sends } }] });
  assert.equal(reverbSend(track([{ active: true, signalAmount: 0.3 }, { active: true, signalAmount: 0.5 }]), '9'), 0.3);
  assert.equal(reverbSend(track([{ active: false, signalAmount: 0.3 }]), '9'), 0);
});
