"""Unsubscribe actions. Nothing here runs without the user choosing it first."""
from __future__ import annotations

import urllib.error
import urllib.request
import webbrowser
from urllib.parse import quote, urlparse

USER_AGENT = "mailmap/0.1"


class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlparse(newurl).scheme != "https":
            raise urllib.error.URLError(f"nektet redirect til ikke-https: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_HttpsOnlyRedirect)


def one_click(url: str, timeout: float = 15) -> tuple[bool, str]:
    """RFC 8058 one-click unsubscribe: POST 'List-Unsubscribe=One-Click' to the URL."""
    if urlparse(url).scheme != "https":
        return False, "kun https-lenker støttes"
    req = urllib.request.Request(
        url,
        data=b"List-Unsubscribe=One-Click",
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT},
    )
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return 200 <= resp.status < 300, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return False, str(getattr(e, "reason", e))


def open_in_browser(url: str) -> bool:
    """Non-one-click links often need a confirmation click – let the user do it."""
    if urlparse(url).scheme != "https":
        return False
    return webbrowser.open(url)


def mailto_link(mailto: str) -> str:
    """Ensure a mailto: link has a subject so the user's mail app opens ready to send."""
    if "subject=" not in mailto.lower():
        mailto += ("&" if "?" in mailto else "?") + "subject=" + quote("unsubscribe")
    return mailto


def act(sender: dict, *, dry_run: bool = False) -> str:
    """Best available action for one sender dict (from Sender.to_dict())."""
    https, mailto = sender.get("unsub_https"), sender.get("unsub_mailto")
    if https and sender.get("one_click"):
        if dry_run:
            return f"[test] ville sendt one-click til {urlparse(https).netloc}"
        ok, info = one_click(https)
        if ok:
            return f"avmeldt (one-click, {info})"
        opened = open_in_browser(https)
        return f"one-click feilet ({info}) – {'åpnet i nettleser' if opened else 'åpne manuelt'}"
    if https:
        if dry_run:
            return "[test] ville åpnet avmeldingssiden i nettleser"
        return "åpnet i nettleser – bekreft der" if open_in_browser(https) else f"åpne manuelt: {https}"
    if mailto:
        link = mailto_link(mailto)
        if dry_run:
            return "[test] ville åpnet e-postprogram"
        webbrowser.open(link)
        return "åpnet e-post for avmelding – trykk send"
    return "ingen avmeldingslenke – logg inn hos tjenesten eller send GDPR-sletting (mailmap gdpr)"


GDPR_TEMPLATE = """Emne: Forespørsel om sletting av personopplysninger (GDPR art. 17)

Hei,

Jeg ber om at dere sletter alle personopplysninger dere har om meg, i tråd med
personvernforordningen (GDPR) artikkel 17, og at kontoen min avsluttes.

Kontoen/e-postadressen det gjelder: {address}

Bekreft skriftlig når slettingen er gjennomført. Etter GDPR artikkel 12 skal
dere svare uten ugrunnet opphold og senest innen én måned.

Vennlig hilsen
{name}
"""


def gdpr_request(address: str, name: str = "") -> str:
    return GDPR_TEMPLATE.format(address=address, name=name or "")
