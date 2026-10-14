"""Browser tests for the web app.

The page runs against fake Google and Microsoft APIs (Playwright request routing),
so the tests need no accounts, no network and no secrets.
"""
from __future__ import annotations

import functools
import http.server
import json
import subprocess
import sys
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

import pytest

pytest.importorskip("playwright", reason="install with: pip install -e '.[web]' && python -m playwright install chromium")
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
NOW = datetime.now(timezone.utc)
ONE_CLICK = "List-Unsubscribe=One-Click"


def headers(sender, subject="Nyhetsbrev", days_ago=1, unsub=None, post=None):
    """Header list in the shape both Gmail (payload.headers) and Graph (internetMessageHeaders) use."""
    h = [{"name": "From", "value": sender}, {"name": "Subject", "value": subject},
         {"name": "Date", "value": format_datetime(NOW - timedelta(days=days_ago))}]
    if unsub:
        h.append({"name": "List-Unsubscribe", "value": unsub})
    if post:
        h.append({"name": "List-Unsubscribe-Post", "value": post})
    return h


@pytest.fixture(scope="session")
def base_url():
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_web.py")], check=True, capture_output=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB))
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


class FakeMail:
    """Fake Gmail + Microsoft Graph + OAuth endpoints. Records what the page sends."""

    def __init__(self, messages, me="me@test.no", config=None, fail_gets=0):
        self.messages = messages          # list of {"headers": [...], "webLink": str|None}
        self.me = me
        # fast retries/quota windows so tests don't wait real minutes
        self.config = {"googleClientId": "test.apps.googleusercontent.com",
                       "microsoftClientId": "11111111-2222-3333-4444-555555555555",
                       "maxMessages": 3000, "retryBaseMs": 5, **(config or {})}
        self.fail_gets = fail_gets        # Gmail answers 403 rateLimitExceeded this many times (-1 = always)
        self.gets = 0
        self.google_auth, self.google_error = [], None
        self.posted, self.gmail_sent, self.graph_sent, self.auth, self.stats = [], [], [], [], []

    def route(self, route):
        u, r = route.request.url, route.request
        ok = lambda body, status=200: route.fulfill(status=status, content_type="application/json",
                                                    body=json.dumps(body), headers={"Access-Control-Allow-Origin": "*"})
        if "/config.js" in u:
            return route.fulfill(content_type="application/javascript",
                                 body="window.MAILMAP_CONFIG=" + json.dumps(self.config) + ";")
        # Google OAuth (token flow, same tab): back to Mailmap with the token in the #fragment
        if "accounts.google.com/o/oauth2/v2/auth" in u:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
            assert q["response_type"] == ["token"] and "gmail.metadata" in q["scope"][0]
            self.google_auth.append(q)
            frag = {"state": q["state"][0], "error": self.google_error} if self.google_error else \
                {"access_token": "G-TOKEN", "token_type": "Bearer", "state": q["state"][0], "scope": q["scope"][0]}
            return route.fulfill(status=302, headers={"Location": q["redirect_uri"][0] + "#" + urllib.parse.urlencode(frag)})
        if "oauth2.googleapis.com/revoke" in u:
            return route.fulfill(body="")
        if "fonts.googleapis.com" in u or "fonts.gstatic.com" in u:
            return route.abort()
        if "stats.test/count" in u:       # the visit counter (GoatCounter in production)
            self.stats.append(r)
            return route.fulfill(content_type="image/gif", body=b"GIF89a")
        # Microsoft OAuth (PKCE)
        if "login.microsoftonline.com" in u and "/authorize" in u:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
            assert q["code_challenge_method"] == ["S256"]
            dest = q["redirect_uri"][0] + "?" + urllib.parse.urlencode({"code": "C0DE", "state": q["state"][0]})
            return route.fulfill(status=302, headers={"Location": dest})
        if "login.microsoftonline.com" in u and u.endswith("/token"):
            body = urllib.parse.parse_qs(r.post_data)
            assert body["code_verifier"][0] and "client_secret" not in body
            return ok({"access_token": "M-TOKEN"})
        # Microsoft Graph
        if "graph.microsoft.com" in u:
            self.auth.append(r.headers.get("authorization"))
            if "/me?" in u:
                return ok({"mail": self.me})
            if u.endswith("/sendMail"):
                self.graph_sent.append(json.loads(r.post_data)["message"])
                return route.fulfill(status=202, headers={"Access-Control-Allow-Origin": "*"})
            if "/me/messages" in u:
                return ok({"value": [{"subject": "", "receivedDateTime": NOW.isoformat(),
                                      "internetMessageHeaders": m["headers"], "webLink": m.get("webLink")}
                                     for m in self.messages]})
        # Gmail
        if "gmail.googleapis.com" in u:
            self.auth.append(r.headers.get("authorization"))
            if u.endswith("/profile"):
                return ok({"emailAddress": self.me})
            if "/messages/send" in u:
                import base64
                raw = json.loads(r.post_data)["raw"]
                self.gmail_sent.append(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode())
                return ok({"id": "sent"})
            if "/messages?" in u:
                return ok({"messages": [{"id": f"{i:016x}"} for i in range(len(self.messages))]})
            assert "format=metadata" in u, "Mailmap must only ask Gmail for headers"
            self.gets += 1
            if self.fail_gets == -1 and self.gets > 12 or self.fail_gets > 0:
                if self.fail_gets > 0:
                    self.fail_gets -= 1
                return route.fulfill(status=403, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                                     body=json.dumps({"error": {"code": 403, "message": "Quota exceeded for quota metric 'Total Query Cost'",
                                                                "errors": [{"reason": "rateLimitExceeded"}]}}))
            i = int(u.split("/messages/")[1].split("?")[0], 16)
            return ok({"payload": {"headers": self.messages[i]["headers"]}})
        # Senders' one-click unsubscribe endpoints
        if r.method == "POST":
            self.posted.append((u, r.post_data))
            return route.fulfill(body="ok")
        if urllib.parse.urlparse(u).hostname == "127.0.0.1":
            return route.continue_()
        # any other site (a sender's unsubscribe page, Outlook, Gmail): stub it, never hit the network
        return route.fulfill(content_type="text/html", body="<p>stub</p>")


@pytest.fixture
def open_app(browser, base_url):
    """open_app(messages, provider="microsoft"|"google"|None, csp=False, **ctx) -> (page, fake)"""
    contexts = []

    def _open(messages=(), provider="microsoft", csp=False, storage=None, config=None, fail_gets=0, wait=True, **ctx_opts):
        ctx = browser.new_context(bypass_csp=not csp, **ctx_opts)
        contexts.append(ctx)
        fake = FakeMail(list(messages), config=config, fail_gets=fail_gets)
        ctx.route("**/*", fake.route)
        page = ctx.new_page()
        page.errors = []
        page.on("pageerror", lambda e: page.errors.append(str(e)))
        page.on("dialog", lambda d: (page.errors.append("dialog: " + d.message), d.dismiss()))
        page.goto(base_url)
        if storage:
            page.evaluate("s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v) }", storage)
        if provider == "microsoft":
            page.click("#mBtn")
        elif provider == "google":
            page.click("#gBtn")
            page.click("#gGo")
        elif provider == "demo":
            page.click("#demoBtn")
        if provider and wait:
            page.wait_for_selector("#vList:not([hidden])", timeout=15000)
        return page, fake

    yield _open
    for c in contexts:
        c.close()


def row(page, name):
    return page.locator("#list > li", has_text=name)
