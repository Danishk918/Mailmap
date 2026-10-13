"""Self-contained HTML report. All sender data is attacker-controlled (anyone can
send you e-mail), so it is embedded as JSON and rendered with textContent only –
never as HTML. A strict CSP blocks any script except the inline one."""
from __future__ import annotations

import json
from datetime import date

_TEMPLATE = r"""<!doctype html>
<html lang="no"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action https:; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>Mailmap rapport</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--mute:#6b6b66;--line:#e4e3de;--acc:#2f5d50;--warn:#9a3b20;--chip:#eeede8}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ecebe6;--mute:#9a9992;--line:#33332f;--acc:#7fb8a6;--warn:#e08b6d;--chip:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:24px 16px 8px;max-width:960px;margin:auto}h1{margin:0 0 4px;font-size:22px}
.sub{color:var(--mute)}.bar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;max-width:960px;margin:auto;position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line)}
input[type=search],select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;flex:1;min-width:140px}
main{max-width:960px;margin:auto;padding:8px 16px 48px}
.row{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0;display:grid;grid-template-columns:1fr auto;gap:6px 12px}
.dom{font-weight:600}.meta{color:var(--mute);font-size:13px}.subj{color:var(--mute);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--chip);margin-left:6px;font-weight:500}
.chip.konto{color:var(--warn)}.chip.nyhetsbrev{color:var(--acc)}
.act{display:flex;gap:6px;align-items:start;flex-wrap:wrap;justify-content:end}
button,.btn{font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
button.go{background:var(--acc);border-color:var(--acc);color:var(--card)}
.done{opacity:.5}.keep{border-color:var(--acc)}
@media (max-width:560px){.row{grid-template-columns:1fr}.act{justify-content:start}}
</style></head><body>
<header><h1>Mailmap</h1><div class="sub" id="summary"></div></header>
<div class="bar">
<input type="search" id="q" placeholder="Søk tjeneste eller emne">
<select id="cat"><option value="">Alle typer</option><option value="konto">Kontoer</option><option value="nyhetsbrev">Nyhetsbrev</option><option value="annet">Annet</option></select>
<button id="export">Last ned valg (JSON)</button>
</div>
<main id="list"></main>
<script id="data" type="application/json">__DATA__</script>
<script>
"use strict";
const D = JSON.parse(document.getElementById("data").textContent);
const S = D.senders, choice = {};
const $ = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const safeHttps = u => { try { return new URL(u).protocol === "https:" ? u : null; } catch { return null; } };
const safeMailto = u => typeof u === "string" && /^mailto:/i.test(u) ? u : null;
const counts = S.reduce((a, s) => (a[s.category] = (a[s.category] || 0) + 1, a), {});
document.getElementById("summary").textContent =
  `${S.length} tjenester fra ${D.messages} e-poster · ${counts.konto || 0} kontoer · ${counts.nyhetsbrev || 0} nyhetsbrev · laget ${D.generated}`;

function oneClick(url) {               // RFC 8058: form POST, works without CORS
  const f = $("form"); f.method = "POST"; f.action = url; f.target = "_blank"; f.rel = "noopener noreferrer";
  const i = $("input"); i.type = "hidden"; i.name = "List-Unsubscribe"; i.value = "One-Click";
  f.appendChild(i); document.body.appendChild(f); f.submit(); f.remove();
}

function row(s) {
  const r = $("div", "row"), info = $("div");
  const t = $("div", "dom", s.names[0] || s.domain);
  t.appendChild($("span", "chip " + s.category, s.category));
  info.append(t, $("div", "meta", `${s.domain} · ${s.count} e-poster · ${s.first_seen || "?"} – ${s.last_seen || "?"}`));
  if (s.subjects[0]) info.appendChild($("div", "subj", "«" + s.subjects[0] + "»"));
  const a = $("div", "act"), https = safeHttps(s.unsub_https), mailto = safeMailto(s.unsub_mailto);
  const keep = $("button", "", "Behold");
  keep.onclick = () => { choice[s.domain] = "behold"; r.classList.add("keep"); r.classList.remove("done"); };
  a.appendChild(keep);
  if (https && s.one_click) {
    const b = $("button", "go", "Meld av (ett klikk)");
    b.onclick = () => { oneClick(https); choice[s.domain] = "avmeldt"; r.classList.add("done"); r.classList.remove("keep"); };
    a.appendChild(b);
  } else if (https || mailto) {
    const l = $("a", "btn", https ? "Åpne avmelding" : "Send avmelding");
    l.href = https || mailto; l.target = "_blank"; l.rel = "noopener noreferrer";
    l.onclick = () => { choice[s.domain] = "avmeldt"; r.classList.add("done"); r.classList.remove("keep"); };
    a.appendChild(l);
  } else {
    const g = $("button", "", "Kopier GDPR-sletting");
    g.onclick = () => { navigator.clipboard?.writeText(D.gdpr.replace("{service}", s.domain)); g.textContent = "Kopiert"; choice[s.domain] = "slett"; };
    a.appendChild(g);
  }
  r.append(info, a); return r;
}

function render() {
  const q = document.getElementById("q").value.toLowerCase(), c = document.getElementById("cat").value;
  const list = document.getElementById("list"); list.replaceChildren();
  S.filter(s => (!c || s.category === c) &&
    (!q || (s.domain + " " + s.names.join(" ") + " " + s.subjects.join(" ")).toLowerCase().includes(q)))
   .forEach(s => list.appendChild(row(s)));
}
document.getElementById("q").oninput = render;
document.getElementById("cat").onchange = render;
document.getElementById("export").onclick = () => {
  const blob = new Blob([JSON.stringify(choice, null, 2)], { type: "application/json" });
  const l = $("a"); l.href = URL.createObjectURL(blob); l.download = "mailmap-valg.json"; l.click();
};
render();
</script></body></html>
"""

GDPR_SHORT = (
    "Hei {service},\n\nJeg ber om sletting av kontoen min og alle personopplysninger "
    "dere har om meg, jf. GDPR artikkel 17. Bekreft når det er gjort (senest innen én måned, jf. art. 12).\n\nHilsen"
)


def render(senders: list[dict], messages: int) -> str:
    payload = {
        "senders": senders,
        "messages": messages,
        "generated": date.today().isoformat(),
        "gdpr": GDPR_SHORT,
    }
    # Prevent '</script>' and HTML comment tricks from breaking out of the JSON block.
    data = (
        json.dumps(payload, ensure_ascii=False)
        .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
        .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    )
    return _TEMPLATE.replace("__DATA__", data)
