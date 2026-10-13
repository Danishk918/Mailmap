"""Where messages come from: an IMAP mailbox or a local export (.mbox / .eml).

Only headers are ever downloaded or parsed – never message bodies.
"""
from __future__ import annotations

import email.parser
import imaplib
import mailbox
from email import policy
from email.message import Message
from pathlib import Path
from typing import Iterator

HEADER_FIELDS = "FROM SUBJECT DATE LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST"
_PARSER = email.parser.BytesHeaderParser(policy=policy.compat32)

KNOWN_HOSTS = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "live.com": "outlook.office365.com",
    "msn.com": "outlook.office365.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "online.no": "imap.online.no",
}


def guess_host(address: str) -> str | None:
    return KNOWN_HOSTS.get(address.rsplit("@", 1)[-1].lower())


def is_microsoft(host: str) -> bool:
    return "office365" in host or "outlook" in host


# ---------------------------------------------------------------- local files

def from_path(path: str | Path) -> Iterator[Message]:
    """Read an .mbox file (e.g. Google Takeout), a single .eml, or a folder of .eml."""
    p = Path(path).expanduser()
    if p.is_dir():
        for f in sorted(p.rglob("*.eml")):
            yield _PARSER.parsebytes(f.read_bytes())
    elif p.suffix.lower() == ".eml":
        yield _PARSER.parsebytes(p.read_bytes())
    else:
        box = mailbox.mbox(str(p), create=False)
        try:
            for key in box.iterkeys():
                # get_bytes reads one message at a time – fine for multi-GB exports
                yield _PARSER.parsebytes(box.get_bytes(key))
        finally:
            box.close()


# ---------------------------------------------------------------------- IMAP

def _connect(host: str, user: str, password: str | None, token: str | None) -> imaplib.IMAP4_SSL:
    conn = imaplib.IMAP4_SSL(host, 993)
    if token:
        auth = f"user={user}\x01auth=Bearer {token}\x01\x01".encode()
        conn.authenticate("XOAUTH2", lambda _: auth)
    else:
        conn.login(user, password or "")
    return conn


def _quote(folder: str) -> str:
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


def from_imap(
    host: str,
    user: str,
    password: str | None = None,
    token: str | None = None,
    folders: list[str] | None = None,
    since: str | None = None,
    batch: int = 500,
    progress=None,
) -> Iterator[Message]:
    """Yield header-only messages from one or more IMAP folders (read-only).

    since: IMAP date like '01-Jan-2023' to limit the scan.
    """
    conn = _connect(host, user, password, token)
    try:
        for folder in folders or ["INBOX"]:
            typ, _ = conn.select(_quote(folder), readonly=True)  # never changes flags
            if typ != "OK":
                if progress:
                    progress(f"Fant ikke mappen {folder!r}, hopper over")
                continue
            criteria = f"SINCE {since}" if since else "ALL"
            typ, data = conn.uid("SEARCH", None, criteria)
            uids = data[0].split() if typ == "OK" and data and data[0] else []
            for i in range(0, len(uids), batch):
                chunk = b",".join(uids[i:i + batch]).decode()
                typ, rows = conn.uid("FETCH", chunk, f"(BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})])")
                if typ != "OK":
                    continue
                for row in rows:
                    if isinstance(row, tuple) and len(row) == 2:
                        yield _PARSER.parsebytes(row[1])
                if progress:
                    progress(f"{folder}: {min(i + batch, len(uids))}/{len(uids)}")
    finally:
        try:
            conn.logout()
        except Exception:
            pass


# ------------------------------------------------- Microsoft (Outlook/Hotmail)

MS_SCOPES = ["https://outlook.office.com/IMAP.AccessAsUser.All"]


def microsoft_token(client_id: str, cache_file: str | Path, say=print) -> str:
    """Get an IMAP access token for a personal Microsoft account (device code flow).

    Outlook.com/Hotmail no longer accepts plain passwords over IMAP, so OAuth2 is
    required. client_id comes from your own (free) Azure app registration – see README.
    """
    import msal  # optional dependency: pip install msal

    cache = msal.SerializableTokenCache()
    cache_file = Path(cache_file).expanduser()
    if cache_file.exists():
        cache.deserialize(cache_file.read_text())

    app = msal.PublicClientApplication(
        client_id, authority="https://login.microsoftonline.com/consumers", token_cache=cache
    )
    result = None
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(MS_SCOPES, account=accounts[0])
    if not result:
        flow = app.initiate_device_flow(scopes=MS_SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Kunne ikke starte innlogging: {flow.get('error_description')}")
        say(flow["message"])
        result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        raise RuntimeError(f"Innlogging feilet: {result.get('error_description')}")
    if cache.has_state_changed:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(cache.serialize())
        cache_file.chmod(0o600)  # token cache is a secret
    return result["access_token"]
