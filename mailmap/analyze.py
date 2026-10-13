"""Group e-mail headers into senders (services) and classify them."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parseaddr, parsedate_to_datetime

# Subjects that suggest the address is tied to an actual account, not just a list.
ACCOUNT_RE = re.compile(
    r"\b(welcome|velkommen|verify|verification|bekreft|confirm|activate|aktiver|"
    r"password|passord|reset|tilbakestill|sign[- ]?in|log ?in|logg inn|innlogging|"
    r"account|konto|receipt|kvittering|order|ordre|bestilling|"
    r"security code|sikkerhetskode|engangskode)\w*",
    re.IGNORECASE,
)

# Small built-in list of two-level public suffixes. Good enough for grouping;
# swap for the `tldextract` package if you need full accuracy.
_MULTI_SUFFIXES = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "co.nz",
    "co.jp", "com.br", "co.za", "com.tr", "co.in", "com.mx", "com.cn",
}


def base_domain(domain: str) -> str:
    """mail.news.spotify.com -> spotify.com, shop.example.co.uk -> example.co.uk"""
    parts = [p for p in domain.lower().strip().strip(".").split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    if ".".join(parts[-2:]) in _MULTI_SUFFIXES:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def parse_list_unsubscribe(value: str | None) -> tuple[list[str], list[str]]:
    """Split a List-Unsubscribe header (RFC 2369) into https and mailto links."""
    links = re.findall(r"<\s*([^>]+?)\s*>", value or "")
    https = [l for l in links if l.lower().startswith("https://")]
    mailto = [l for l in links if l.lower().startswith("mailto:")]
    return https, mailto


def _decode(value: str) -> str:
    try:
        return str(make_header(decode_header(value))).strip()
    except Exception:
        return value.strip()


def _header(msg: Message, name: str) -> str:
    """Header value with RFC 2047 encoded-words (=?utf-8?q?...?=) decoded."""
    try:
        value = msg.get(name)
        if value is None:
            return ""
        return str(make_header(decode_header(str(value)))).strip()
    except Exception:  # malformed header – never crash a scan over one message
        try:
            return str(msg.get(name) or "").strip()
        except Exception:
            return ""


def _date(value: str) -> datetime | None:
    try:
        d = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


@dataclass
class Sender:
    domain: str
    addresses: set[str] = field(default_factory=set)
    names: set[str] = field(default_factory=set)
    count: int = 0
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    subjects: list[str] = field(default_factory=list)
    unsub_https: str | None = None   # from the newest message that had one
    unsub_mailto: str | None = None
    one_click: bool = False          # RFC 8058 one-click supported
    account_hits: int = 0
    newsletter_hits: int = 0

    def add(self, msg: Message, address: str, name: str) -> None:
        self.count += 1
        self.addresses.add(address)
        if name:
            self.names.add(name)

        subject = _header(msg, "Subject")
        if subject and len(self.subjects) < 5 and subject not in self.subjects:
            self.subjects.append(subject[:140])
        if ACCOUNT_RE.search(subject):
            self.account_hits += 1

        when = _date(_header(msg, "Date"))
        is_newest = when is None or self.last_seen is None or when >= self.last_seen
        if when:
            self.first_seen = min(filter(None, [self.first_seen, when]))
            self.last_seen = max(filter(None, [self.last_seen, when]))

        https, mailto = parse_list_unsubscribe(_header(msg, "List-Unsubscribe"))
        if https or mailto:
            self.newsletter_hits += 1
            if is_newest:  # unsubscribe tokens can expire – prefer the newest
                if https:
                    self.unsub_https = https[0]
                    post = _header(msg, "List-Unsubscribe-Post")
                    self.one_click = "list-unsubscribe=one-click" in post.lower()
                if mailto:
                    self.unsub_mailto = mailto[0]

    @property
    def category(self) -> str:
        if self.account_hits:
            return "konto"
        if self.newsletter_hits:
            return "nyhetsbrev"
        return "annet"

    def to_dict(self) -> dict:
        return {
            "domain": self.domain,
            "names": sorted(self.names),
            "addresses": sorted(self.addresses),
            "count": self.count,
            "first_seen": self.first_seen.date().isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.date().isoformat() if self.last_seen else None,
            "subjects": self.subjects,
            "category": self.category,
            "unsub_https": self.unsub_https,
            "unsub_mailto": self.unsub_mailto,
            "one_click": self.one_click,
        }


def analyze(messages, exclude: set[str] | None = None) -> list[Sender]:
    """Group header-only messages by sender base domain, most frequent first."""
    exclude = {e.lower() for e in (exclude or set())}
    senders: dict[str, Sender] = {}
    for msg in messages:
        # Parse the raw header first, then decode only the display name, so an
        # encoded name containing '<' or ',' can't change the address.
        try:
            name, address = parseaddr(str(msg.get("From") or ""))
        except Exception:
            continue
        name = _decode(name)
        address = address.lower()
        if "@" not in address or address in exclude:
            continue
        domain = base_domain(address.rsplit("@", 1)[1])
        if not domain:
            continue
        senders.setdefault(domain, Sender(domain)).add(msg, address, name)
    return sorted(senders.values(), key=lambda s: s.count, reverse=True)
