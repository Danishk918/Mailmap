"use strict";
/* Mailmap web – sign in with Google or Microsoft, find subscriptions, unsubscribe in the page.
   No server: OAuth tokens live in memory only, and only message headers are read. */

const CFG = Object.assign({ googleClientId: "", microsoftClientId: "", maxMessages: 3000 }, window.MAILMAP_CONFIG || {});
const HEADERS = ["From", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post"];

/* ================================================================ analysis */
const ACCOUNT_RE = /\b(welcome|velkommen|verify|verification|bekreft|confirm|activate|aktiver|password|passord|reset|tilbakestill|sign[- ]?in|log ?in|logg inn|innlogging|account|konto|receipt|kvittering|order|ordre|bestilling|security code|sikkerhetskode|engangskode)/i;
const MULTI = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","net.au","co.nz","co.jp","com.br","co.za","com.tr","co.in","com.mx","com.cn"]);

function baseDomain(d){
  const p = d.toLowerCase().trim().replace(/^\.+|\.+$/g,"").split(".").filter(Boolean);
  if (p.length <= 2) return p.join(".");
  return MULTI.has(p.slice(-2).join(".")) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}
function decodeWords(s){
  if (!s || s.indexOf("=?") < 0) return s || "";
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=(?:\s+(?==\?))?/g, (m, cs, enc, txt) => {
    try {
      let bytes;
      if (enc === "b" || enc === "B") bytes = Uint8Array.from(atob(txt), c => c.charCodeAt(0));
      else {
        const t = txt.replace(/_/g," "), out = [];
        for (let i = 0; i < t.length; i++) {
          if (t[i] === "=" && /^[0-9a-f]{2}$/i.test(t.substr(i+1,2))) { out.push(parseInt(t.substr(i+1,2),16)); i += 2; }
          else out.push(t.charCodeAt(i) & 255);
        }
        bytes = Uint8Array.from(out);
      }
      return new TextDecoder(cs.split("*")[0].toLowerCase()).decode(bytes);
    } catch { return m; }
  });
}
// Parse the address from the raw header first and decode only the display name,
// so an encoded name can never change which address we think sent the mail.
function parseFrom(raw){
  raw = (raw || "").trim();
  let addr = "", name = "";
  const a = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (a) { addr = a[1]; name = raw.slice(0, a.index).trim().replace(/^"|"$/g,""); }
  else { const b = raw.match(/([^\s<>"(),;:]+@[^\s<>"(),;:]+)/); if (b) addr = b[1]; }
  return { addr: addr.toLowerCase(), name: decodeWords(name).trim() };
}
function unsubLinks(v){
  const l = [...(v || "").matchAll(/<\s*([^>]+?)\s*>/g)].map(m => m[1].trim());
  return { https: l.filter(x => /^https:\/\//i.test(x)), mailto: l.filter(x => /^mailto:/i.test(x)) };
}

class Analyzer {
  constructor(own){ this.s = new Map(); this.own = (own || "").toLowerCase(); this.messages = 0; }
  add(h){ // h: lower-case header name -> value
    this.messages++;
    const { addr, name } = parseFrom(h.from);
    if (!addr.includes("@") || addr === this.own) return;
    const domain = baseDomain(addr.split("@").pop()); if (!domain) return;
    let s = this.s.get(domain);
    if (!s) this.s.set(domain, s = { domain, names:new Map(), addr, count:0, last:null, https:null, mailto:null, oneClick:false, acc:0 });
    s.count++;
    if (name && !name.includes("@")) s.names.set(name, (s.names.get(name)||0)+1);
    if (ACCOUNT_RE.test(decodeWords(h.subject || ""))) s.acc++;
    const t = Date.parse(h.date || ""), when = isNaN(t) ? null : t;
    const newest = when == null || s.last == null || when >= s.last;
    if (when != null) s.last = s.last == null ? when : Math.max(s.last, when);
    const u = unsubLinks(h["list-unsubscribe"]);
    if (newest && (u.https.length || u.mailto.length)) {   // tokens expire: keep the newest
      s.https = u.https[0] || null;
      s.mailto = u.mailto[0] || null;
      s.oneClick = !!s.https && /list-unsubscribe=one-click/i.test(h["list-unsubscribe-post"] || "");
    }
  }
  result(){
    return [...this.s.values()].map(s => ({
      id: s.domain,
      name: [...s.names].sort((a,b) => b[1]-a[1])[0]?.[0] || s.domain,
      domain: s.domain, count: s.count, last: s.last,
      https: s.https, mailto: s.mailto, oneClick: s.oneClick,
      kind: (s.https || s.mailto) ? "sub" : s.acc ? "acc" : "other",
    })).sort((a,b) => b.count - a.count);
  }
}

/* ================================================================ helpers */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const utf8b64url = s => b64url(new TextEncoder().encode(s));

async function api(url, token, opts = {}){
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) } });
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      await sleep((Number(r.headers.get("Retry-After")) || 2 ** attempt) * 1000); continue;
    }
    if (r.status === 401) throw new Error("Innloggingen har utløpt. Logg inn på nytt.");
    if (!r.ok) {
      let msg = ""; try { msg = (await r.json()).error?.message || ""; } catch {}
      throw new Error(`Kontoen svarte med feil ${r.status}${msg ? ": " + msg : ""}`);
    }
    return r.status === 204 || r.status === 202 ? null : r.json().catch(() => null);
  }
}
async function pool(items, size, fn){
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
// The mailto: link comes from the sender, so treat it as hostile: one plain address only,
// and no line breaks in the subject (they would let a sender inject extra headers such as Bcc).
function parseMailto(m){
  const u = m.replace(/^mailto:/i, ""), [rawTo, q = ""] = u.split("?");
  let to = ""; try { to = decodeURIComponent(rawTo).trim(); } catch {}
  if (!/^[^\s@<>,;:"()\[\]\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(to)) throw new Error("Ugyldig avmeldingsadresse fra avsenderen.");
  const p = new URLSearchParams(q);
  const clean = (s, fallback) => (s || fallback).replace(/[\r\n\0]+/g, " ").trim().slice(0, 200) || fallback;
  return { to, subject: clean(p.get("subject"), "unsubscribe"), body: clean(p.get("body"), "unsubscribe") };
}

/* ================================================================ Google */
const Google = {
  scope: "https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/gmail.send",
  client: null,
  load(){
    if (!CFG.googleClientId || document.getElementById("gsi")) return;
    const s = document.createElement("script");
    s.id = "gsi"; s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => {
      Google.client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId, scope: Google.scope,
        callback: r => r.error ? showErr("Google-innloggingen ble avbrutt.") : start(Google, r.access_token),
        error_callback: () => showErr("Google-innloggingen ble avbrutt."),
      });
    };
    document.head.append(s);
  },
  signIn(){
    if (!CFG.googleClientId) return showErr("Google-innlogging er ikke satt opp ennå. Legg inn googleClientId i config.js (se README).");
    if (!Google.client) return showErr("Google laster fortsatt. Prøv igjen om et øyeblikk.");
    Google.client.requestAccessToken();   // must run directly in the click for the popup
  },
  async who(t){ return (await api("https://gmail.googleapis.com/gmail/v1/users/me/profile", t)).emailAddress; },
  async scan(t, onMsg, onProgress){
    const ids = [];
    let page = "";
    do {
      const r = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500${page ? "&pageToken=" + page : ""}`, t);
      (r.messages || []).forEach(m => ids.push(m.id));
      page = r.nextPageToken;
      onProgress(0, ids.length);
    } while (page && ids.length < CFG.maxMessages);
    ids.length = Math.min(ids.length, CFG.maxMessages);
    const q = HEADERS.map(h => "metadataHeaders=" + encodeURIComponent(h)).join("&");
    let done = 0;
    await pool(ids, 8, async id => {
      const m = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&${q}`, t);
      const h = {}; (m.payload?.headers || []).forEach(x => { const k = x.name.toLowerCase(); if (!(k in h)) h[k] = x.value; });
      onMsg(h); onProgress(++done, ids.length);
    });
  },
  async send(t, to, subject, body){
    const raw = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
    await api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", t,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: utf8b64url(raw) }) });
  },
  revoke(t){ try { google.accounts.oauth2.revoke(t, () => {}); } catch {} },
};

/* ================================================================ Microsoft (PKCE, no secret) */
const Microsoft = {
  scope: "openid offline_access User.Read Mail.Read Mail.Send",
  auth: "https://login.microsoftonline.com/common/oauth2/v2.0",
  // Same URI whether the page was opened as /mailmap/ or /mailmap/index.html – it must match the app registration.
  redirect: () => location.origin + location.pathname.replace(/index\.html$/, ""),
  async signIn(){
    if (!CFG.microsoftClientId) return showErr("Microsoft-innlogging er ikke satt opp ennå. Legg inn microsoftClientId i config.js (se README).");
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem("mm-pkce", JSON.stringify({ verifier, state }));
    const p = new URLSearchParams({ client_id: CFG.microsoftClientId, response_type: "code", redirect_uri: Microsoft.redirect(),
      response_mode: "query", scope: Microsoft.scope, code_challenge: challenge, code_challenge_method: "S256", state, prompt: "select_account" });
    location.assign(`${Microsoft.auth}/authorize?${p}`);
  },
  async handleRedirect(){
    const q = new URLSearchParams(location.search);
    if (!q.has("code") && !q.has("error")) return false;
    history.replaceState(null, "", Microsoft.redirect());          // keep the code out of history
    let saved = {}; try { saved = JSON.parse(sessionStorage.getItem("mm-pkce") || "{}"); } catch {}
    sessionStorage.removeItem("mm-pkce");
    if (q.has("error")) { showErr("Microsoft-innloggingen ble avbrutt."); return true; }
    if (!saved.state || q.get("state") !== saved.state) { showErr("Innloggingen kunne ikke bekreftes. Prøv igjen."); return true; }
    const r = await fetch(`${Microsoft.auth}/token`, { method: "POST", body: new URLSearchParams({
      client_id: CFG.microsoftClientId, grant_type: "authorization_code", code: q.get("code"),
      redirect_uri: Microsoft.redirect(), code_verifier: saved.verifier, scope: Microsoft.scope }) });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) { showErr("Microsoft godtok ikke innloggingen. " + (j.error_description || "").split("\n")[0]); return true; }
    start(Microsoft, j.access_token);
    return true;
  },
  async who(t){ const me = await api("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", t); return me.mail || me.userPrincipalName; },
  async scan(t, onMsg, onProgress){
    let url = "https://graph.microsoft.com/v1.0/me/messages?$select=from,subject,receivedDateTime,internetMessageHeaders&$orderby=receivedDateTime%20desc&$top=100";
    let done = 0;
    while (url && done < CFG.maxMessages) {
      const r = await api(url, t, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      for (const m of r.value || []) {
        const h = {};
        (m.internetMessageHeaders || []).forEach(x => { const k = x.name.toLowerCase(); if (!(k in h)) h[k] = x.value; });
        const f = m.from?.emailAddress;
        if (!h.from && f) h.from = `${f.name || ""} <${f.address}>`;
        h.subject = h.subject || m.subject || "";
        h.date = h.date || m.receivedDateTime;
        onMsg(h); onProgress(++done, Math.max(done, CFG.maxMessages));
        if (done >= CFG.maxMessages) break;
      }
      url = r["@odata.nextLink"];
    }
  },
  async send(t, to, subject, body){
    await api("https://graph.microsoft.com/v1.0/me/sendMail", t, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false }) });
  },
  revoke(){},
};

/* ================================================================ Demo */
const Demo = {
  async who(){ return "deg@eksempel.no"; },
  async scan(_, onMsg, onProgress){
    const S = [
      ["Morgenavisa","nyhetsbrev@avisa.example","Morgenbrief",1,212],["Elektronikkbutikken","info@elektro.example","Ukens tilbud",1,140],
      ["Reiseportalen","deals@reise.example","Billige fly til Roma",1,88],["Nettbutikken","ordre@butikk.example","Black Week starter nå",1,64],
      ["Matkassen","post@matkasse.example","Ny meny er klar",2,51],["Strømmetjenesten","no-reply@stream.example","Nytt denne uken",1,38],
      ["Treningsappen","hei@trening.example","Ukesrapporten din",3,23],["Konferanse AS","events@konferanse.example","Invitasjon til frokostmøte",2,17],
      ["Kafé Kanelen","hei@kanelen.example","Kanelsnurrdagen er tilbake",1,12],["Bildeappen","noreply@bilde.example","Engangskode for innlogging",0,6],
      ["Gammelt forum","noreply@forum.example","Tilbakestill passordet ditt",0,4],
    ];
    const now = Date.UTC(2026, 9, 13); let seed = 7, total = S.reduce((a,s)=>a+s[4],0), done = 0;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [name, a, subj, kind, count] of S) for (let i = 0; i < count; i++) {
      const dom = a.split("@")[1];
      const h = { from: `${name} <${a}>`, subject: subj, date: new Date(now - Math.floor(rnd()*400)*864e5).toUTCString() };
      if (kind === 1) { h["list-unsubscribe"] = `<https://${dom}/u>`; h["list-unsubscribe-post"] = "List-Unsubscribe=One-Click"; }
      if (kind === 2) h["list-unsubscribe"] = `<mailto:stop@${dom}>`;
      if (kind === 3) h["list-unsubscribe"] = `<https://${dom}/innstillinger>`;
      onMsg(h); onProgress(++done, total);
      if (done % 40 === 0) await sleep(30);
    }
  },
  async send(){ await sleep(400); },
  revoke(){},
};

/* ================================================================ unsubscribe */
// Returns "done" when the page did it, "opened" when the sender's page had to be opened.
async function unsubscribe(s){
  if (session.provider === Demo) { await sleep(350); return s.oneClick || s.mailto ? "done" : "opened"; }
  if (s.https && s.oneClick) {
    // RFC 8058: a form POST to the sender's link. 'no-cors' means we can send it but not read the reply.
    await fetch(s.https, { method: "POST", mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer",
      body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) });
    return "done";
  }
  if (s.mailto) {
    const m = parseMailto(s.mailto);
    await session.provider.send(session.token, m.to, m.subject, m.body);
    return "done";
  }
  return "opened";
}
function method(s){
  if (s.https && s.oneClick) return "Meld av";
  if (s.mailto) return "Meld av";
  return "Åpne avmelding";
}

/* ================================================================ UI */
const $ = id => document.getElementById(id);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const nb = new Intl.DateTimeFormat("nb-NO", { day:"numeric", month:"short", year:"numeric" });
const n = x => x.toLocaleString("nb-NO");
const safeHttps = u => { try { return new URL(u).protocol === "https:" ? u : null; } catch { return null; } };

const session = { provider: null, token: null, email: "" };
let items = [], state = {}, picked = new Set(), view = "sub", shown = 50;
const fresh = new Set();   // rows that should play the postmark animation once
const stay = new Set();    // stamped rows kept in the "Abonnert" list until the tab changes
const storeKey = () => "mailmap-done:" + session.email;
const loadDone = () => { try { return JSON.parse(localStorage.getItem(storeKey()) || "{}"); } catch { return {}; } };
const saveDone = () => { if (session.provider === Demo) return; try {
  const keep = {}; for (const [k, v] of Object.entries(state)) if (v === "done") keep[k] = v;
  localStorage.setItem(storeKey(), JSON.stringify(keep)); } catch {} };

function show(v){ ["vStart","vRead","vList"].forEach(x => $(x).hidden = x !== v); $("dock").hidden = true; }
function showErr(msg){ show("vStart"); const e = $("startErr"); e.textContent = msg; e.hidden = false; }
function toast(msg){ const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2600); }

async function start(provider, token){
  session.provider = provider; session.token = token;
  $("startErr").hidden = true;
  show("vRead"); $("bar").style.width = "0";
  try {
    session.email = await provider.who(token);
    const an = new Analyzer(session.email);
    await provider.scan(token, h => an.add(h), (done, total) => {
      $("bar").style.width = total ? (done / total * 100).toFixed(1) + "%" : "4%";
      $("readText").textContent = done ? `${n(done)} av ${n(total)} e-poster lest` : `Fant ${n(total)} e-poster …`;
    });
    items = an.result();
    state = loadDone(); picked = new Set(); view = "sub"; shown = 50;
    $("who").textContent = session.email;
    $("demoNote").hidden = provider !== Demo;
    show("vList"); render();
  } catch (e) {
    showErr(e.message || "Noe gikk galt under lesingen. Prøv igjen.");
  }
}

function render(){
  const subs = items.filter(s => s.kind === "sub" && state[s.id] !== "done");
  const done = items.filter(s => state[s.id] === "done");
  const acc = items.filter(s => s.kind === "acc");
  $("headline").textContent = subs.length
    ? `Du er abonnert på ${n(subs.length)} ${subs.length === 1 ? "nyhetsbrev" : "nyhetsbrev"}.`
    : "Du er ikke abonnert på noe lenger.";
  const [a, b, c] = $("tabs").children;
  a.textContent = `Abonnert ${subs.length}`; b.textContent = `Avmeldt ${done.length}`; c.textContent = `Kontoer ${acc.length}`;
  [...$("tabs").children].forEach(x => x.setAttribute("aria-pressed", x.dataset.v === view));

  const rows = view === "sub" ? items.filter(s => s.kind === "sub" && (state[s.id] !== "done" || stay.has(s.id))) : view === "done" ? done : acc;
  const list = $("list"); list.replaceChildren();
  if (!rows.length) list.append(el("li","empty", view === "sub" ? "Ingen abonnementer igjen." : view === "done" ? "Du har ikke meldt deg av noe ennå." : "Ingen kontoer funnet."));
  rows.slice(0, shown).forEach(s => list.append(view === "acc" ? accRow(s) : subRow(s)));
  const rest = rows.length - shown;
  $("more").hidden = rest <= 0; $("more").textContent = `Vis ${Math.min(50, rest)} til`;

  const sel = [...picked].filter(id => state[id] !== "done" && state[id] !== "busy");
  $("dock").hidden = view !== "sub" || !sel.length;
  $("dockText").textContent = `${sel.length} valgt`;
  $("bulk").textContent = `Meld av ${sel.length}`;
}

function meta(s){ return `${n(s.count)} e-poster${s.last ? ", sist " + nb.format(s.last) : ""}`; }

function subRow(s){
  const li = el("li","row"), st = state[s.id];
  if (view === "sub" && st === "done") li.append(el("span", "cbspace"));
  if (view === "sub" && st !== "done") {
    const cb = el("input"); cb.type = "checkbox"; cb.checked = picked.has(s.id); cb.setAttribute("aria-label", "Velg " + s.name);
    cb.disabled = st === "busy";
    cb.onchange = () => { cb.checked ? picked.add(s.id) : picked.delete(s.id); render(); };
    li.append(cb);
  }
  li.append(el("div","ava", s.name.trim()[0]?.toUpperCase() || "?"));
  const who = el("div","who"); who.append(el("b","", s.name), el("span","", meta(s)));
  const act = el("div","act");
  if (st === "done") { act.append(el("span", fresh.has(s.id) ? "state" : "state still", "Avmeldt")); fresh.delete(s.id); }
  else if (st === "busy") act.append(el("span","state wait","Melder av …"));
  else if (st === "fail") {
    act.append(el("span","state bad","Feilet"));
    const r = el("button","btn red","Prøv igjen"); r.onclick = () => run([s]); act.append(r);
  } else if (s.oneClick || s.mailto) {
    const b = el("button","btn red", method(s)); b.onclick = () => run([s]); act.append(b);
  } else {
    const href = safeHttps(s.https);
    const a = el("a","btn red","Åpne avmelding");
    if (href && session.provider !== Demo) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    a.title = "Denne avsenderen krever at du bekrefter på deres side";
    a.onclick = e => { if (session.provider === Demo) e.preventDefault(); state[s.id] = "done"; saveDone(); picked.delete(s.id);
      toast("Bekreft avmeldingen på siden som åpnet seg."); render(); };
    act.append(a);
  }
  li.append(who, act);
  return li;
}

function accRow(s){
  const li = el("li","row");
  li.append(el("div","ava", s.name.trim()[0]?.toUpperCase() || "?"));
  const who = el("div","who"); who.append(el("b","", s.name), el("span","", meta(s)));
  const act = el("div","act"), b = el("button","btn","Kopier slettebrev");
  b.onclick = async () => {
    const text = `Hei ${s.name},\n\nJeg ber om at dere sletter kontoen min (${session.email}) og alle personopplysninger dere har om meg, jf. personvernforordningen (GDPR) artikkel 17.\n\nBekreft når det er gjort. Etter artikkel 12 skal dere svare innen én måned.\n\nVennlig hilsen\n`;
    try { await navigator.clipboard.writeText(text); toast("Slettebrevet er kopiert. Send det til kundeservice hos " + s.name + "."); }
    catch { toast("Kopiering ble blokkert av nettleseren."); }
  };
  act.append(b); li.append(who, act);
  return li;
}

async function run(list){
  const auto = list.filter(s => s.oneClick || s.mailto);
  const manual = list.filter(s => !(s.oneClick || s.mailto));
  auto.forEach(s => { state[s.id] = "busy"; picked.delete(s.id); });
  render();
  let ok = 0, bad = 0;
  await pool(auto, 4, async s => {
    try { const r = await unsubscribe(s); if (r === "done") { state[s.id] = "done"; fresh.add(s.id); stay.add(s.id); } ok++; }
    catch (e) { state[s.id] = "fail"; bad++; if (/utløpt/.test(e.message)) toast(e.message); }
    saveDone(); render();
  });
  if (manual.length) toast(`${manual.length} avsender${manual.length === 1 ? "" : "e"} krever at du bekrefter på deres side. Trykk «Åpne avmelding» på dem.`);
  else if (ok && !bad) toast(ok === 1 ? "Avmeldt." : `Avmeldt fra ${ok} nyhetsbrev.`);
  else if (bad) toast(`${bad} feilet. Trykk «Prøv igjen».`);
}

/* ================================================================ events */
$("gBtn").onclick = () => Google.signIn();
$("mBtn").onclick = () => Microsoft.signIn();
$("demoBtn").onclick = () => start(Demo, "demo");
$("tabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; view = b.dataset.v; shown = 50; stay.clear(); render(); };
$("more").onclick = () => { shown += 50; render(); };
$("bulk").onclick = () => run(items.filter(s => picked.has(s.id) && state[s.id] !== "done" && state[s.id] !== "busy"));
$("out").onclick = () => {
  session.provider?.revoke(session.token);
  Object.assign(session, { provider: null, token: null, email: "" });
  items = []; state = {}; picked.clear();
  show("vStart");
};

Google.load();
Microsoft.handleRedirect().catch(e => showErr(e.message));
