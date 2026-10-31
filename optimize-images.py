#!/usr/bin/env python3
"""
Verkleint de foto's in de map images/ zodat de website snel laadt.

Gebruik (vanuit de hoofdmap van het project):
    pip install Pillow
    python tools/optimize-images.py

Opties:
    --max 1920     langste zijde in pixels (standaard 1920)
    --quality 80   JPEG-kwaliteit 1-100 (standaard 80)

Het script is veilig om vaker te draaien: een foto wordt alleen
overschreven als het resultaat kleiner is dan het origineel.
Bestandsnamen blijven hetzelfde, dus er breekt niets op de site.
"""
import argparse
from pathlib import Path
from PIL import Image, ImageOps

SKIP = {"favicon.ico", "logokb.png"}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--max", type=int, default=1920)
    p.add_argument("--quality", type=int, default=80)
    p.add_argument("--dir", default="images")
    a = p.parse_args()

    before = after = 0
    for f in sorted(Path(a.dir).iterdir()):
        if not f.is_file() or f.name in SKIP:
            continue
        ext = f.suffix.lower()
        if ext not in (".jpg", ".jpeg", ".png"):
            continue
        size = f.stat().st_size
        before += size
        try:
            im = Image.open(f)
            if ext != ".png":
                im.draft("RGB", (a.max, a.max))  # sneller inlezen
            im = ImageOps.exif_transpose(im)
            im.thumbnail((a.max, a.max), Image.LANCZOS)
            tmp = f.with_name(f.name + ".tmp")
            if ext == ".png":
                im.save(tmp, "PNG", optimize=True)
            else:
                im.convert("RGB").save(tmp, "JPEG", quality=a.quality,
                                       optimize=True, progressive=True)
            new = tmp.stat().st_size
            if new < size:
                tmp.replace(f)
                after += new
                print(f"{f.name}: {size/1e6:.1f} MB -> {new/1e6:.2f} MB")
            else:
                tmp.unlink()
                after += size
        except Exception as e:
            after += size
            print(f"Overgeslagen {f.name}: {e}")
    print(f"\nTotaal: {before/1e6:.0f} MB -> {after/1e6:.0f} MB")

if __name__ == "__main__":
    main()
