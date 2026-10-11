import { test, expect } from 'bun:test';
import { t, lang, STRINGS } from './i18n.js';
import { PRESETS } from './layout.js';

test('locale picks a language, English otherwise', () => {
  expect(lang('fr_FR')).toBe('fr'); expect(lang('pt-BR')).toBe('pt'); expect(lang('xx')).toBe('en'); expect(lang()).toBe('en');
  expect(t('de-DE', 'sent', 2)).toBe('An 2 Headsets gesendet.');
});
test('every language has every string, presets included', () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const p of Object.keys(PRESETS)) expect(keys).toContain('preset_' + p);
  for (const l in STRINGS) expect([l, Object.keys(STRINGS[l]).sort()]).toEqual([l, keys]);
});
