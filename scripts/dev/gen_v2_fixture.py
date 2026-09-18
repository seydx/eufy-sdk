#!/usr/bin/env python3
"""Generate a FULLY SYNTHETIC `v2_eufysecurity:` thumbnail fixture for decode_v2.spec.ts.

Repo policy is synthetic fixtures only (no captured device data / real serials). A v2 blob is just the
ascii `v2_eufysecurity:<serial>:<id>:` wrapper followed by a standard baseline JPEG — the decoder
ignores the (obfuscated, here plain) head and splices from the plaintext `FF C4 00 1F 01` tail. We
therefore build a synthetic image, encode it as a standard 4:4:4 baseline JPEG (Pillow/libjpeg emits
the separate DC/AC chroma DHT segments the decoder relies on), prepend a synthetic serial, and base64
it. Pillow is a dev-time tool only; it is NOT a runtime dependency of the SDK.

    python3 scripts/dev/gen_v2_fixture.py <width> <height> <out.b64> [quality] [subsampling]

`quality` (default 85) and `subsampling` (0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0; default 0) are what the
decoder has to RECOVER — the quality because the camera's quant tables are lost with the encrypted
head, and the subsampling because it decides how the scan's blocks are interleaved. A fixture at a
quality well below the decoder's reference table is what "foggy" means, and is the one that shows the
contrast recovery doing anything.
"""
import base64
import sys

from PIL import Image

SYNTHETIC_SERIAL = b"v2_eufysecurity:T8000TEST00000002:0000000000:"


def synthetic_image(w: int, h: int) -> Image.Image:
    """Build photo-like content whose horizontal continuity makes row-shear identify the true width."""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            r = (x * 255) // (w - 1)
            g = (y * 255) // (h - 1)
            b = ((x + y) * 255) // (w + h - 2)
            if (y // 12) % 4 == 0:
                r = min(255, r + 40)
            if 40 <= x < 120 and 30 <= y < 90:
                r, g, b = 200, 60, 60
            px[x, y] = (r, g, b)
    return img


def main() -> None:
    """Write a baseline JPEG with the split DHT layout expected by the decoder."""
    w, h, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 85
    subsampling = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    from io import BytesIO

    buf = BytesIO()
    synthetic_image(w, h).save(buf, format="JPEG", quality=quality, subsampling=subsampling)
    blob = SYNTHETIC_SERIAL + buf.getvalue()
    with open(out, "w") as f:
        f.write(base64.b64encode(blob).decode())
    print(f"wrote {out}: {len(blob)} bytes ({w}x{h}, quality {quality}, subsampling {subsampling}, synthetic)")


if __name__ == "__main__":
    main()
