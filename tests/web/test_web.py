"""End-to-end tests of the web app in a real browser (Chromium), against fake mail APIs."""
from __future__ import annotations

import json
import time

import pytest

from conftest import NOW, ONE_CLICK, headers, row

PROVIDERS = ["microsoft", "google"]


def basic_inbox():
    return [
        {"headers": headers("Avisa <news@mail.avisa.no>", "Morgenbrief", 1,
                            "<mailto:u@avisa.no>, <https://avisa.no/u?t=1>", ONE_CLICK)},
        {"headers": headers("Butikk <tilbud@butikk.no>", "Black Week", 2, "<mailto:stop@butikk.no?subject=stopp>")},
        {"headers": headers("Klubb <hei@klubb.no>", "Nyhetsbrev", 3, "<https://klubb.no/innstillinger>")},
        {"headers": headers("=?utf-8?q?Str=C3=B8m?= <no-reply@strom.no>", "Velkommen til Strøm", 4)},
        {"headers": headers("Meg <me@test.no>", "notat til meg selv", 1)},
    ]


@pytest.mark.parametrize("provider", PROVIDERS)
def test_lists_subscriptions_and_accounts(open_app, provider):
    page, fake = open_app(basic_inbox(), provider)
    assert page.inner_text("#who") == "me@test.no"
    assert page.inner_text("#headline") == "Du er abonnert på 3 nyhetsbrev."
    names = page.locator("#list .who b").all_inner_texts()
    assert names == ["Avisa", "Butikk", "Klubb"]           # own mail is hidden
    assert row(page, "Klubb").locator(".manual").inner_text() == "Må gjøres manuelt på avsenderens side"
    page.click("#tabs button[data-v=acc]")
    assert page.locator("#list .who b").all_inner_texts() == ["Strøm"]   # encoded name decoded
    assert set(fake.auth) == {"Bearer " + ("M-TOKEN" if provider == "microsoft" else "G-TOKEN")}
    assert page.errors == []


@pytest.mark.parametrize("provider", PROVIDERS)
def test_unsubscribe_uses_every_channel_the_sender_offers(open_app, provider):
    page, fake = open_app(basic_inbox(), provider)
    row(page, "Avisa").get_by_role("button", name="Meld av").click()
    page.wait_for_function("document.querySelector('#tabs button[data-v=done]').textContent.includes('1')")
    assert fake.posted == [("https://avisa.no/u?t=1", "List-Unsubscribe=One-Click")]   # RFC 8058
    if provider == "google":
        assert len(fake.gmail_sent) == 1 and "To: u@avisa.no" in fake.gmail_sent[0]
    else:
        assert [m["toRecipients"][0]["emailAddress"]["address"] for m in fake.graph_sent] == ["u@avisa.no"]
    note = row(page, "Avisa").locator(".note").inner_text()
    assert "via ett klikk og e-post" in note
    assert "kan de be deg bekrefte" in row(page, "Avisa").locator(".hint").inner_text()
    assert "1 avmelding" in page.inner_text("#checkNote")
    assert page.errors == []


def test_bulk_unsubscribe_select_all_and_search(open_app):
    inbox = [{"headers": headers(f"Butikk {i:02d} <n@b{i}.no>", "Tilbud", 1, f"<https://b{i}.no/u>", ONE_CLICK)}
             for i in range(60)]
    page, fake = open_app(inbox, "google")
    assert page.inner_text("#headline") == "Du er abonnert på 60 nyhetsbrev."
    assert page.locator("#list > li").count() == 50 and page.inner_text("#more") == "Vis 10 til"
    page.check("#all")
    assert page.inner_text("#dockText") == "60 valgt"
    page.uncheck("#all")
    page.fill("#q", "butikk 1")
    assert page.locator("#list > li").count() == 10 and page.inner_text("#allText") == "Velg alle treff (10)"
    page.check("#all")
    page.click("#bulk")
    page.wait_for_function("document.querySelector('#tabs button[data-v=done]').textContent.includes('10')")
    assert len(fake.posted) == 10
    page.fill("#q", "finnes ikke")
    assert page.inner_text("#list") == "Ingen avsendere passer «finnes ikke»."
    assert page.errors == []


# ------------------------------------------------------------------ security

def test_hostile_sender_cannot_run_code_or_smuggle_links(open_app):
    evil = "<script>window.__xss=1</script><img src=x onerror=window.__xss=1>"
    page, fake = open_app([{"headers": headers(f"{evil} <x@evil.no>", evil, 1,
                                               "<javascript:window.__xss=1>, <https://evil.no/u>", ONE_CLICK)}])
    assert page.evaluate("window.__xss") is None
    assert page.locator("#list img").count() == 0                 # shown as text, never as HTML
    assert "<script>" in page.locator("#list .who b").first.inner_text()
    page.locator("#list > li").first.get_by_role("button", name="Meld av").click()
    page.wait_for_function("document.querySelector('#tabs button[data-v=done]').textContent.includes('1')")
    assert [u for u, _ in fake.posted] == ["https://evil.no/u"]  # javascript: link ignored
    hrefs = page.locator("#list a").evaluate_all("as => as.map(a => a.getAttribute('href'))")
    assert not [h for h in hrefs if h and not h.startswith(("https:", "#"))]
    assert page.errors == []


@pytest.mark.parametrize("provider", PROVIDERS)
def test_mailto_cannot_inject_extra_recipients(open_app, provider):
    page, fake = open_app([{"headers": headers("Butikk <t@butikk.no>", "x", 1,
                                               "<mailto:stop@butikk.no?subject=stopp%0D%0ABcc:%20victim@x.no>")}], provider)
    row(page, "Butikk").get_by_role("button", name="Meld av").click()
    page.wait_for_function("document.querySelector('#tabs button[data-v=done]').textContent.includes('1')")
    if provider == "google":
        raw = fake.gmail_sent[0]
        assert "\r\nBcc:" not in raw and raw.startswith("To: stop@butikk.no\r\n")
    else:
        assert fake.graph_sent[0]["toRecipients"] == [{"emailAddress": {"address": "stop@butikk.no"}}]
        assert "\n" not in fake.graph_sent[0]["subject"]


def test_encoded_display_name_cannot_change_the_address(open_app):
    # Display name decodes to "evil@bank.no <" – the real sender is spam.example.
    page, _ = open_app([{"headers": headers("=?utf-8?q?evil=40bank=2Eno_=3C?= <real@spam.example>", "x", 1,
                                            "<https://spam.example/u>", ONE_CLICK)}])
    assert page.locator("#list .who b").all_inner_texts() == ["spam.example"]


def test_only_webmail_links_are_trusted_for_opening_an_email(open_app):
    page, _ = open_app([
        {"headers": headers("Spark <a@spark.no>", "x", 1, "<https://unsub.spark.no/u/abc>", ONE_CLICK),
         "webLink": "https://outlook.live.com/owa/?ItemID=AAA"},
        {"headers": headers("Evil <e@evil.no>", "x", 1, "<https://evil.no/u>", ONE_CLICK),
         "webLink": "javascript:alert(1)"},
    ])
    for name, expected in [("Spark", ["https://outlook.live.com/owa/?ItemID=AAA"]), ("Evil", [])]:
        r = row(page, name)
        r.locator("summary").click()
        links = r.get_by_role("link", name="Åpne siste e-post").evaluate_all("as => as.map(a => a.href)")
        assert links == expected


def test_strict_csp_blocks_nothing_the_app_needs(open_app):
    page, _ = open_app(provider=None, csp=True)
    violations = []
    page.on("console", lambda m: violations.append(m.text) if "Content Security Policy" in m.text else None)
    page.click("#demoBtn")
    page.wait_for_selector("#vList:not([hidden])")
    assert page.locator("#list > li").count() > 5
    assert violations == [] and page.errors == []


# ------------------------------------------------------------------ follow-up

def test_newest_unsubscribe_link_is_used(open_app):
    page, fake = open_app([
        {"headers": headers("Kjell <kvittering@kjell.com>", "Kvittering", 0)},                       # newest, no header
        {"headers": headers("Kjell <news@kjell.com>", "Ukens tilbud", 3, "<https://kjell.com/u?t=new>", ONE_CLICK)},
        {"headers": headers("Kjell <news@kjell.com>", "Forrige uke", 10, "<https://kjell.com/u?t=old>", ONE_CLICK)},
    ])
    row(page, "Kjell").get_by_role("button", name="Meld av").click()
    page.wait_for_function("document.querySelector('#tabs button[data-v=done]').textContent.includes('1')")
    assert [u for u, _ in fake.posted] == ["https://kjell.com/u?t=new"]


def test_still_sending_and_quiet_senders_after_earlier_unsubscribe(open_app):
    five_days_ago = int((time.time() - 5 * 86400) * 1000)
    sent = {"mittanbud.no": {"t": five_days_ago, "via": ["post"]}, "avisa.no": {"t": five_days_ago, "via": ["post"]}}
    page, _ = open_app([
        {"headers": headers("Mittanbud <hei@mittanbud.no>", "Nye oppdrag", 0, "<https://mittanbud.no/u>", ONE_CLICK)},
        {"headers": headers("Avisa <brev@avisa.no>", "Morgenbrief", 8, "<https://avisa.no/u>", ONE_CLICK)},
        {"headers": headers("Annen <a@annen.no>", "Hei", 1, "<https://annen.no/u>", ONE_CLICK)},
    ], storage={"mailmap-sent:me@test.no": json.dumps(sent)}, provider=None)
    page.click("#mBtn")
    page.wait_for_selector("#vList:not([hidden])")
    assert page.locator("#list .who b").first.inner_text() == "Mittanbud"     # needs attention: first
    assert "Sender fortsatt" in row(page, "Mittanbud").locator(".flag").inner_text()
    page.click("#tabs button[data-v=done]")
    assert "Ingen nye e-poster siden." in row(page, "Avisa").locator(".note").inner_text()


def test_manual_sender_is_labelled_and_email_copied(open_app):
    page, _ = open_app([{"headers": headers("Eurodel <n@eurodel.no>", "x", 1, "<https://eurodel.no/avmeld?id=1>")}],
                       permissions=["clipboard-read", "clipboard-write"])
    assert page.inner_text("#manualNote") == "1 av dem må gjøres manuelt hos avsenderen. Den er merket i lista."
    with page.context.expect_page() as popup:
        row(page, "Eurodel").get_by_role("link", name="Åpne avmelding").click()
    assert popup.value.url == "https://eurodel.no/avmeld?id=1"
    assert page.evaluate("navigator.clipboard.readText()") == "me@test.no"


# ------------------------------------------------------------------ UI

def test_google_warning_is_explained_before_the_popup(open_app):
    page, fake = open_app(provider=None)
    page.click("#gBtn")
    assert page.is_visible("#gWarn") and page.is_hidden("#signin")
    assert "Avansert" in page.inner_text("#gWarn")
    assert fake.auth == []                      # nothing sent to Google yet
    page.click("#gBack")
    assert page.is_visible("#signin") and page.is_hidden("#gWarn")


def test_demo_fits_a_phone_screen(open_app):
    page, _ = open_app(provider="demo", viewport={"width": 390, "height": 844})
    row(page, "Morgenavisa").get_by_role("button", name="Meld av").click()
    page.wait_for_timeout(500)
    assert page.evaluate("document.documentElement.scrollWidth") <= 390
    assert page.errors == []
