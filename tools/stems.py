"""Export one dry mono stem per part from a .mscz using MuseScore's CLI (MuseSounds included).

usage: python3 tools/stems.py score.mscz project.zip
The project is an uncompressed zip: <partId>/<k>.flac (CHUNK-second slices, silent slices skipped)
plus project.json. Slices let the player decode only what is about to play instead of whole tracks.
"""
import array, json, re, subprocess, sys, tempfile, wave, zipfile
from pathlib import Path

CHUNK = 10  # seconds per slice
SILENT = 30  # peak below this (16-bit, ~ -60 dBFS) = slice not written
MSCORE = "/Applications/MuseScore 4.app/Contents/MacOS/mscore"  # ponytail: macOS only, add a flag for Linux/Windows


def part_names(mscx):
    # <Part id="N"> ... first <trackName> is the part's display name
    return dict(re.findall(r'<Part id="(\d+)">.*?<trackName>([^<]*)', mscx, re.S))


def families(mscx):
    """instrument id -> (family id, family display name, rank) from the score's <Order> block.

    The order lists families front to back (woodwinds, brass, percussion...); families it doesn't list,
    or scores without an <Order>, rank last.
    """
    order = re.search(r"<Order\b.*?</Order>", mscx, re.S)
    if not order:
        return {}
    ranks = {f: i for i, f in enumerate(re.findall(r"<family>([^<]+)</family>", order[0]))}
    return {inst: (fid, name, ranks.get(fid, len(ranks)))
            for inst, fid, name in re.findall(r'<instrument id="([^"]+)">\s*<family id="([^"]+)">([^<]*)</family>', order[0])}


def slice_wav(wav, z, pid, tmp):
    """Split a mono 16-bit wav into FLAC slices; returns ([relative path or None], duration)."""
    w = wave.open(str(wav))
    rate, n = w.getframerate(), w.getnframes()
    chunks = []
    for k in range(0, n, CHUNK * rate):
        frames = w.readframes(CHUNK * rate)
        if max(map(abs, array.array("h", frames)), default=0) < SILENT:
            chunks.append(None); continue
        piece = Path(tmp, "piece.wav")
        with wave.open(str(piece), "wb") as o:
            o.setparams(w.getparams()); o.writeframes(frames)
        name = f"{pid}/{k // (CHUNK * rate)}.flac"
        subprocess.run(["afconvert", "-f", "flac", "-d", "flac", str(piece), str(Path(tmp, "piece.flac"))], check=True)
        z.write(Path(tmp, "piece.flac"), name)
        chunks.append(name)
    return chunks, n / rate


def main(src, out):
    project = zipfile.ZipFile(out, "w", zipfile.ZIP_STORED)  # stored: the player slices entries out of the file
    with zipfile.ZipFile(src) as z:
        files = {n: z.read(n) for n in z.namelist()}
    settings = json.loads(files["audiosettings.json"])
    mscx = next(v for k, v in files.items() if k.endswith(".mscx") and "/" not in k).decode()
    names, fams = part_names(mscx), families(mscx)
    tracks = {t["partId"]: t for t in settings["tracks"]}
    parts = []
    for pid in names:  # score order (top to bottom), used to break ties within a family
        track = tracks[pid]
        # solo this part, kill reverb sends -> dry stem
        s = json.loads(files["audiosettings.json"])
        for t in s["tracks"]:
            t["soloMuteState"] = {"mute": t["partId"] != pid, "solo": t["partId"] == pid}
            for send in t["out"].get("auxSends", []):
                send["active"] = False
        with tempfile.TemporaryDirectory() as tmp:
            score = Path(tmp, "s.mscz")
            with zipfile.ZipFile(score, "w", zipfile.ZIP_DEFLATED) as z:
                for n, data in files.items():
                    z.writestr(n, json.dumps(s, indent=4) if n == "audiosettings.json" else data)
            wav = Path(tmp, "s.wav")
            subprocess.run([MSCORE, "-o", str(wav), str(score)], check=True, capture_output=True)
            mono = Path(tmp, "mono.wav")
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", "-c", "1", str(wav), str(mono)], check=True)
            chunks, duration = slice_wav(mono, project, pid, tmp)
        inst = track["instrumentId"]
        fid, fname, rank = fams.get(inst, (inst, names[pid], len(fams)))
        parts.append({"id": pid, "name": names[pid], "instrument": inst,
                      "family": fid, "familyName": fname, "familyRank": rank, "count": 1, "chunks": chunks})
        print(f"{pid:>4} {names[pid]}", flush=True)
    meta = {"version": 1, "title": Path(src).stem.strip(), "chunk": CHUNK, "duration": duration, "parts": parts}
    project.writestr("project.json", json.dumps(meta, indent=2, ensure_ascii=False))
    project.close()


if __name__ == "__main__":
    main(*sys.argv[1:3])
