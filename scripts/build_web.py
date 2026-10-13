"""Wrap web/app.html (a page fragment) into a complete web/index.html for hosting."""
from pathlib import Path

web = Path(__file__).resolve().parent.parent / "web"
head, body = (web / "app.html").read_text(encoding="utf-8").split('<div class="wrap">', 1)
(web / "index.html").write_text(
    '<!doctype html>\n<html lang="no">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
    + head.strip() + '\n</head>\n<body>\n<div class="wrap">' + body.rstrip() + "\n</body>\n</html>\n",
    encoding="utf-8",
)
print("web/index.html built")
