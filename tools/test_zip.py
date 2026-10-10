"""Round-trip check for proto/zip.js against Python's zipfile (the format stems.py writes).

usage: python3 tools/test_zip.py
"""
import subprocess, tempfile, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory() as tmp:
    src, dst = Path(tmp, "in.zip"), Path(tmp, "out.zip")
    with zipfile.ZipFile(src, "w", zipfile.ZIP_STORED) as z:
        z.writestr("project.json", '{"title": "é"}')
        z.writestr("9/0.flac", bytes(range(256)) * 100)
    # JS: read every entry, replace project.json, write a new zip
    js = f"""
    import {{ readZip, writeZip, crc32 }} from '{root / "proto/zip.js"}';
    import {{ readFileSync, writeFileSync }} from 'fs';
    const entries = await readZip(new Blob([readFileSync('{src}')]));
    const flac = await entries.get('9/0.flac').blob();
    if (flac.size !== 25600 || new Uint8Array(await flac.arrayBuffer())[255] !== 255) throw 'bad read';
    if (JSON.parse(await (await entries.get('project.json').blob()).text()).title !== 'é') throw 'bad utf8';
    const json = new TextEncoder().encode('{{"title": "ü"}}');
    const z = writeZip([{{ name: '9/0.flac', data: flac, crc: entries.get('9/0.flac').crc }},
                        {{ name: 'project.json', data: new Blob([json]), crc: crc32(json) }}]);
    writeFileSync('{dst}', Buffer.from(await z.arrayBuffer()));
    """
    subprocess.run(["node", "--input-type=module", "-e", js], check=True)
    with zipfile.ZipFile(dst) as z:
        assert z.testzip() is None, "crc mismatch"
        assert z.read("project.json").decode() == '{"title": "ü"}'
        assert z.read("9/0.flac") == bytes(range(256)) * 100
print("ok")
