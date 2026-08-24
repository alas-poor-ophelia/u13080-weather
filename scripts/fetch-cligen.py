#!/usr/bin/env python3
"""Download the CLIGEN international archives and extract only the stations
listed in scripts/build-presets/stations.json into data/cligen/par/<id>.par.

Zips are cached in data/cligen/ (gitignored). Pure stdlib.
"""
import hashlib, json, pathlib, sys, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts" / "build-presets" / "stations.json"
DATA = ROOT / "data" / "cligen"
PAR = DATA / "par"
PAR.mkdir(parents=True, exist_ok=True)

m = json.loads(MANIFEST.read_text(encoding="utf8"))
by_set = {}
for s in m["stations"]:
    by_set.setdefault(s["set"], []).append(s["ghcnId"])

def fetch(file_id, name, md5):
    dest = DATA / f"{file_id}.zip"
    if not dest.exists():
        url = f"https://ndownloader.figshare.com/files/{file_id}"
        print(f"downloading {name} ({url})")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (wadjet preset build)"})
        with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
            f.write(r.read())
    if md5:
        h = hashlib.md5(dest.read_bytes()).hexdigest()
        if h != md5:
            sys.exit(f"MD5 mismatch for {name}: {h} != {md5}")
        print(f"  md5 ok {name}")
    return dest

missing = []
for set_key, ids in by_set.items():
    f = m["files"][set_key]
    z = zipfile.ZipFile(fetch(f["id"], f["name"], f.get("md5")))
    names = z.namelist()
    for sid in ids:
        hit = [n for n in names if n.endswith(f"{sid}.par")]
        if not hit:
            missing.append((set_key, sid)); continue
        (PAR / f"{sid}.par").write_bytes(z.read(hit[0]))
        print(f"  extracted {sid} from {set_key}-year")
if missing:
    sys.exit(f"MISSING stations: {missing}")
print(f"done: {len(list(PAR.glob('*.par')))} .par files in {PAR}")
