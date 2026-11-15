#!/usr/bin/env python3
"""Write make_sky.py's output as sky.png and sky.json in a directory.

  python3 tools/unpack_sky.py sky.out.json docs

Stdlib only, so it runs on chord-gateway.
"""

import base64
import json
import sys
from pathlib import Path


def main(src, dest):
    with open(src) as f:
        out = json.load(f)
    dest = Path(dest)
    (dest / "sky.png").write_bytes(base64.b64decode(out["png_base64"]))
    (dest / "sky.json").write_text(json.dumps(out["meta"], indent=1) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:3])
