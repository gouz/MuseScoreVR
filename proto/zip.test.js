// bun test — zip.js against the system zip/unzip tools (a .mscz is a deflated zip, projects are stored zips)
import { test, expect } from 'bun:test';
import { $ } from 'bun';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, writeZip, crc32 } from './zip.js';

const audio = new Uint8Array(25600).map((_, i) => i % 256);

test('writes zips that unzip accepts, reads them back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-'));
  const json = new TextEncoder().encode('{"title": "é"}');
  await Bun.write(join(dir, 'out.zip'), writeZip([
    { name: '9/0.flac', data: new Blob([audio]), crc: crc32(audio) },
    { name: 'project.json', data: new Blob([json]), crc: crc32(json) },
  ]));
  await $`unzip -tq ${join(dir, 'out.zip')}`.quiet(); // checks every CRC, throws on failure
  const z = await readZip(Bun.file(join(dir, 'out.zip')));
  expect(new Uint8Array(await (await z.get('9/0.flac').blob()).arrayBuffer())).toEqual(audio);
  expect(JSON.parse(await (await z.get('project.json').blob()).text()).title).toBe('é');
});

test('reads deflated entries, like a .mscz', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-'));
  await Bun.write(join(dir, 'score.mscx'), '<museScore>' + 'x'.repeat(5000) + '</museScore>');
  await Bun.write(join(dir, 'a.bin'), audio);
  await $`cd ${dir} && zip -q -9 score.mscz score.mscx a.bin`.quiet();
  const z = await readZip(Bun.file(join(dir, 'score.mscz')));
  expect(await (await z.get('score.mscx').blob()).text()).toBe('<museScore>' + 'x'.repeat(5000) + '</museScore>');
  expect(new Uint8Array(await (await z.get('a.bin').blob()).arrayBuffer())).toEqual(audio);
});
