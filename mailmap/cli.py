"""mailmap – find out where your e-mail address is used, and clean up.

  mailmap scan --file Takeout.mbox            # offline, from an export
  mailmap scan --imap you@gmail.com           # live, read-only, headers only
  mailmap clean mailmap.json                  # walk through senders interactively
  mailmap gdpr --address you@example.com      # print a GDPR deletion request
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

from . import __version__
from .analyze import analyze
from .report import render
from .sources import from_imap, from_path, guess_host, is_microsoft, microsoft_token
from .unsubscribe import act, gdpr_request

CONFIG_DIR = Path(os.environ.get("MAILMAP_HOME", "~/.mailmap")).expanduser()


def _err(msg: str) -> None:
    print(msg, file=sys.stderr)


def _since(value: str | None) -> str | None:
    if not value:
        return None
    d = datetime.strptime(value, "%Y-%m-%d")
    return d.strftime("%d-%b-%Y")  # IMAP date format; months are English by spec


def cmd_scan(a: argparse.Namespace) -> int:
    if a.file:
        if not Path(a.file).expanduser().exists():
            _err(f"Fant ikke filen: {a.file}")
            return 2
        msgs = from_path(a.file)
        own = set(a.exclude or [])
    else:
        host = a.host or guess_host(a.imap)
        if not host:
            _err("Ukjent e-postleverandør – oppgi --host (f.eks. imap.domene.no)")
            return 2
        token = password = None
        if is_microsoft(host):
            client_id = a.client_id or os.environ.get("MAILMAP_MS_CLIENT_ID")
            if not client_id:
                _err("Outlook/Hotmail krever OAuth. Oppgi --client-id (se README: 'Outlook/Hotmail').")
                return 2
            token = microsoft_token(client_id, CONFIG_DIR / "ms_token_cache.json", say=_err)
        else:
            password = os.environ.get("MAILMAP_PASSWORD") or getpass.getpass(
                f"App-passord for {a.imap} (vises ikke): "
            )
        msgs = from_imap(host, a.imap, password=password, token=token,
                         folders=a.folder, since=_since(a.since),
                         progress=lambda m: _err("  " + m))
        own = {a.imap, *(a.exclude or [])}

    counted = []

    def counting(it):
        for m in it:
            counted.append(1)
            yield m

    try:
        senders = analyze(counting(msgs), exclude=own)
    except FileNotFoundError as e:
        _err(f"Fant ikke filen: {e.filename}")
        return 2
    except Exception as e:  # login errors, network, corrupt mbox …
        _err(f"Skanning feilet: {e}")
        return 1

    data = [s.to_dict() for s in senders]
    out = Path(a.out)
    out.write_text(json.dumps({"messages": len(counted), "senders": data}, ensure_ascii=False, indent=2))
    html = out.with_suffix(".html")
    html.write_text(render(data, len(counted)), encoding="utf-8")

    cats = {c: sum(1 for s in data if s["category"] == c) for c in ("konto", "nyhetsbrev", "annet")}
    print(f"{len(counted)} e-poster → {len(data)} tjenester "
          f"({cats['konto']} kontoer, {cats['nyhetsbrev']} nyhetsbrev, {cats['annet']} annet)")
    print(f"Rapport: {html.resolve()}\nData:    {out.resolve()}")
    if a.open:
        webbrowser.open(html.resolve().as_uri())
    return 0


def cmd_list(a: argparse.Namespace) -> int:
    data = json.loads(Path(a.data).read_text())["senders"]
    for s in data:
        if a.category and s["category"] != a.category:
            continue
        unsub = "ett klikk" if s["one_click"] else ("lenke" if s["unsub_https"] or s["unsub_mailto"] else "-")
        print(f"{s['count']:>5}  {s['category']:<10}  {unsub:<9}  {s['domain']}")
    return 0


def cmd_clean(a: argparse.Namespace) -> int:
    data = json.loads(Path(a.data).read_text())["senders"]
    todo = [s for s in data if s["unsub_https"] or s["unsub_mailto"]]
    if a.category:
        todo = [s for s in todo if s["category"] == a.category]
    print(f"{len(todo)} tjenester har avmeldingslenke. [a]vmeld  [b]ehold  [h]opp  [q]uit\n")
    log = []
    for i, s in enumerate(todo, 1):
        label = s["names"][0] if s["names"] else s["domain"]
        print(f"({i}/{len(todo)}) {label} – {s['domain']} – {s['count']} e-poster, sist {s['last_seen']}")
        if s["subjects"]:
            print(f"      «{s['subjects'][0]}»")
        while True:
            try:
                ans = input("      > ").strip().lower()[:1]
            except EOFError:
                ans = "q"
            if ans in ("a", "b", "h", "q"):
                break
        if ans == "q":
            break
        if ans == "a":
            res = act(s, dry_run=a.dry_run)
            print(f"      {res}")
            log.append({"domain": s["domain"], "action": "avmeld", "result": res})
        elif ans == "b":
            log.append({"domain": s["domain"], "action": "behold"})
    if log:
        Path(a.log).write_text(json.dumps(log, ensure_ascii=False, indent=2))
        print(f"\nLogg lagret: {Path(a.log).resolve()}")
    return 0


def cmd_gdpr(a: argparse.Namespace) -> int:
    print(gdpr_request(a.address, a.name))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mailmap", description="Finn ut hvor e-posten din er registrert.")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="skann e-post (kun headere) og lag rapport")
    src = s.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help=".mbox, .eml eller mappe med .eml")
    src.add_argument("--imap", metavar="ADRESSE", help="logg inn via IMAP (skrivebeskyttet)")
    s.add_argument("--host", help="IMAP-server, hvis den ikke gjettes automatisk")
    s.add_argument("--folder", action="append", help="mappe(r) å skanne (standard: INBOX)")
    s.add_argument("--since", help="bare e-post etter dato, ÅÅÅÅ-MM-DD")
    s.add_argument("--client-id", help="Azure app-ID for Outlook/Hotmail")
    s.add_argument("--exclude", action="append", help="egne adresser som skal ignoreres")
    s.add_argument("--out", default="mailmap.json")
    s.add_argument("--open", action="store_true", help="åpne rapporten i nettleseren")
    s.set_defaults(func=cmd_scan)

    l = sub.add_parser("list", help="vis tjenester i terminalen")
    l.add_argument("data", nargs="?", default="mailmap.json")
    l.add_argument("--category", choices=["konto", "nyhetsbrev", "annet"])
    l.set_defaults(func=cmd_list)

    c = sub.add_parser("clean", help="gå gjennom og meld av interaktivt")
    c.add_argument("data", nargs="?", default="mailmap.json")
    c.add_argument("--category", choices=["konto", "nyhetsbrev", "annet"])
    c.add_argument("--dry-run", action="store_true", help="vis hva som ville skjedd")
    c.add_argument("--log", default="mailmap-log.json")
    c.set_defaults(func=cmd_clean)

    g = sub.add_parser("gdpr", help="skriv ut mal for GDPR-sletting")
    g.add_argument("--address", required=True)
    g.add_argument("--name", default="")
    g.set_defaults(func=cmd_gdpr)

    a = p.parse_args(argv)
    try:
        return a.func(a)
    except KeyboardInterrupt:
        _err("\nAvbrutt.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
