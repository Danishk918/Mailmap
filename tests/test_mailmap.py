import json
import mailbox
from email.message import EmailMessage
from email.parser import BytesHeaderParser

import pytest

from mailmap.analyze import analyze, base_domain, parse_list_unsubscribe
from mailmap.cli import main
from mailmap.report import render
from mailmap.sources import from_path, guess_host, is_microsoft
from mailmap.unsubscribe import mailto_link, one_click


def msg(frm, subject="Hei", date="Mon, 06 Oct 2026 10:00:00 +0200", unsub=None, post=None):
    m = EmailMessage()
    m["From"] = frm
    m["Subject"] = subject
    m["Date"] = date
    if unsub:
        m["List-Unsubscribe"] = unsub
    if post:
        m["List-Unsubscribe-Post"] = post
    return BytesHeaderParser().parsebytes(m.as_bytes())


@pytest.mark.parametrize("d,exp", [
    ("spotify.com", "spotify.com"),
    ("news.mail.spotify.com", "spotify.com"),
    ("shop.example.co.uk", "example.co.uk"),
    ("Finn.NO.", "finn.no"),
])
def test_base_domain(d, exp):
    assert base_domain(d) == exp


def test_parse_list_unsubscribe():
    https, mailto = parse_list_unsubscribe(
        "<mailto:u@x.com?subject=unsub>, <https://x.com/u?t=1>, <http://insecure.com/u>")
    assert https == ["https://x.com/u?t=1"]
    assert mailto == ["mailto:u@x.com?subject=unsub"]
    assert parse_list_unsubscribe(None) == ([], [])


def test_grouping_and_categories():
    senders = analyze([
        msg("Spotify <no-reply@spotify.com>", "Velkommen til Spotify"),
        msg("Spotify <news@mail.spotify.com>", "Ukens låter",
            unsub="<https://spotify.com/u?t=1>", post="List-Unsubscribe=One-Click"),
        msg("Butikk <hei@butikk.no>", "Tilbud!", unsub="<mailto:stop@butikk.no>"),
        msg("Venn <venn@gmail.com>", "Middag?"),
        msg("me@hotmail.com", "notat til meg selv"),
    ], exclude={"ME@hotmail.com"})
    by = {s.domain: s for s in senders}
    assert set(by) == {"spotify.com", "butikk.no", "gmail.com"}
    assert senders[0].domain == "spotify.com" and senders[0].count == 2
    assert by["spotify.com"].category == "konto"
    assert by["spotify.com"].one_click is True
    assert by["butikk.no"].category == "nyhetsbrev"
    assert by["butikk.no"].unsub_mailto == "mailto:stop@butikk.no"
    assert by["gmail.com"].category == "annet"


def test_newest_unsubscribe_link_wins():
    s = analyze([
        msg("a@n.com", date="Mon, 06 Oct 2026 10:00:00 +0200", unsub="<https://n.com/new>"),
        msg("a@n.com", date="Mon, 06 Jan 2025 10:00:00 +0200", unsub="<https://n.com/old>"),
    ])[0]
    assert s.unsub_https == "https://n.com/new"
    assert s.first_seen.year == 2025 and s.last_seen.year == 2026


def test_bad_headers_do_not_crash():
    senders = analyze([msg("not-an-address", date="garbage"), msg("x@y.com", date="")])
    assert [s.domain for s in senders] == ["y.com"]


def test_report_escapes_hostile_content():
    evil = "</script><script>alert(1)</script><img src=x onerror=alert(1)>"
    s = analyze([msg(f"{evil} <a@evil.com>", subject=evil)])
    html = render([x.to_dict() for x in s], 1)
    assert "<script>alert" not in html
    assert "<img src=x" not in html
    assert html.count("</script>") == 2  # only our own two script blocks


def test_one_click_rejects_non_https():
    ok, info = one_click("http://example.com/unsub")
    assert not ok and "https" in info


def test_mailto_link_adds_subject():
    assert "subject=unsubscribe" in mailto_link("mailto:a@b.no")
    assert mailto_link("mailto:a@b.no?subject=stop") == "mailto:a@b.no?subject=stop"


def test_hosts():
    assert guess_host("x@hotmail.com") == "outlook.office365.com"
    assert is_microsoft("outlook.office365.com")
    assert guess_host("x@ukjent.example") is None


def test_scan_mbox_end_to_end(tmp_path, capsys):
    path = tmp_path / "test.mbox"
    box = mailbox.mbox(str(path))
    box.add(mailbox.mboxMessage(msg("Netflix <info@netflix.com>", "Bekreft e-postadressen din")))
    box.add(mailbox.mboxMessage(msg("Nyhet <n@avis.no>", "Nyheter",
                                    unsub="<https://avis.no/u>", post="List-Unsubscribe=One-Click")))
    box.flush(); box.close()

    out = tmp_path / "res.json"
    assert main(["scan", "--file", str(path), "--out", str(out)]) == 0
    data = json.loads(out.read_text())
    assert data["messages"] == 2
    assert {s["domain"] for s in data["senders"]} == {"netflix.com", "avis.no"}
    assert out.with_suffix(".html").exists()
    assert "2 e-poster → 2 tjenester" in capsys.readouterr().out


def test_scan_missing_file(tmp_path):
    assert main(["scan", "--file", str(tmp_path / "nope.mbox"), "--out", str(tmp_path / "o.json")]) == 2


def test_eml_folder(tmp_path):
    (tmp_path / "a.eml").write_bytes(msg("a@x.no").as_bytes())
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.eml").write_bytes(msg("b@y.no").as_bytes())
    assert len(list(from_path(tmp_path))) == 2


class FakeIMAP:
    """Minimal stand-in for imaplib.IMAP4_SSL to test the fetch loop offline."""
    def __init__(self, host, port):
        self.selected_readonly = None
        self.raw = [msg(f"a{i}@shop{i % 3}.no").as_bytes() for i in range(7)]

    def login(self, user, pw):
        assert pw == "app-passord"

    def select(self, folder, readonly=False):
        self.selected_readonly = readonly
        return ("OK", [b"7"]) if folder == '"INBOX"' else ("NO", [b""])

    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            return "OK", [b" ".join(str(i + 1).encode() for i in range(7))]
        uids = args[0].split(",")
        assert "BODY.PEEK" in args[1]  # never marks mail as read
        return "OK", [(b"x", self.raw[int(u) - 1]) for u in uids] + [b")"]

    def logout(self):
        pass


def test_imap_fetch_readonly(monkeypatch):
    import imaplib
    from mailmap import sources
    conns = []
    monkeypatch.setattr(imaplib, "IMAP4_SSL", lambda h, p: conns.append(FakeIMAP(h, p)) or conns[-1])
    msgs = list(sources.from_imap("imap.test", "me@test.no", password="app-passord",
                                  folders=["INBOX", "Finnes ikke"], batch=3))
    assert len(msgs) == 7
    assert conns[0].selected_readonly is True
    assert len(analyze(msgs)) == 3


def test_encoded_words_decoded():
    s = analyze([msg("=?utf-8?q?Str=C3=B8m?= <a@x.no>", subject="=?utf-8?b?w4ZydMOl?=")])[0]
    assert s.names == {"Strøm"}
    assert s.subjects == ["Ærtå"]


def test_encoded_name_cannot_spoof_address():
    # display name decodes to "evil@bank.no <" – address must still be the real one
    raw = b"From: =?utf-8?q?evil=40bank=2Eno_=3C?= <real@spam.example>\r\nSubject: x\r\n\r\n"
    s = analyze([BytesHeaderParser().parsebytes(raw)])[0]
    assert s.domain == "spam.example"
