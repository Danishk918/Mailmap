"""Wrap web/app.html (a page fragment) into a complete web/index.html for hosting.

Script and config URLs get a version suffix (?v=<commit>) so phones and home-screen
shortcuts load the new code after every deploy instead of a cached copy.
"""
import os
import subprocess
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
web = root / "web"

version = (os.environ.get("GITHUB_SHA") or "")[:8]
if not version:
    try:
        version = subprocess.check_output(["git", "rev-parse", "--short=8", "HEAD"], cwd=root, text=True).strip()
    except Exception:
        version = str(int(time.time()))

head, body = (web / "app.html").read_text(encoding="utf-8").split('<div class="wrap">', 1)
body = (body.replace('<script src="config.js"></script>', f'<script src="config.js?v={version}"></script>')
            .replace('<script src="app.js"></script>', f'<script src="app.js?v={version}"></script>'))
(web / "index.html").write_text(
    '<!doctype html>\n<html lang="no">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
    + head.strip() + '\n</head>\n<body>\n<div class="wrap">' + body.rstrip() + "\n</body>\n</html>\n",
    encoding="utf-8",
)
print(f"web/index.html built (version {version})")
