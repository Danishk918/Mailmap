"use strict";
/* Mailmap web – sign in with Google or Microsoft, find subscriptions, unsubscribe in the page.
   No server: OAuth tokens live in memory only, and only message headers are read. */

const CFG = Object.assign({
  googleClientId: "", microsoftClientId: "", maxMessages: 3000,
  // Gmail allows 6,000 quota units per user per minute; messages.get costs 20, messages.list 5.
  // That is ~300 e-mails a minute, so Gmail reads fewer messages, paced, and shows the list early.
  gmailMaxMessages: 1000, gmailUnitsPerMinute: 5400, quotaWindowMs: 60000,
  firstBatch: 120, retryBaseMs: 1000,
  stats: "",               // GoatCounter count URL; empty = no counting
}, window.MAILMAP_CONFIG || {});
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
  add(h, link){ // h: lower-case header name -> value; link: provider's web link to this e-mail (trusted, built by us)
    this.messages++;
    const { addr, name } = parseFrom(h.from);
    if (!addr.includes("@") || addr === this.own) return;
    const domain = baseDomain(addr.split("@").pop()); if (!domain) return;
    let s = this.s.get(domain);
    if (!s) this.s.set(domain, s = { domain, names:new Map(), addr, count:0, last:null, https:null, mailto:null, oneClick:false, acc:0,
      unsubAt:null, rawUnsub:"", rawPost:"", mailLink:null, latestLink:null, latestAt:null });
    s.count++;
    if (name && !name.includes("@")) s.names.set(name, (s.names.get(name)||0)+1);
    if (ACCOUNT_RE.test(decodeWords(h.subject || ""))) s.acc++;
    const t = Date.parse(h.date || ""), when = isNaN(t) ? null : t;
    if (when != null) s.last = s.last == null ? when : Math.max(s.last, when);
    if (link && (s.latestAt == null || (when != null && when >= s.latestAt))) { s.latestAt = when ?? 0; s.latestLink = link; }
    const u = unsubLinks(h["list-unsubscribe"]);
    // Tokens expire, so use the newest message that actually HAS an unsubscribe header
    // (the newest message overall may be a receipt without one).
    if ((u.https.length || u.mailto.length) && (s.unsubAt == null || (when != null && when >= s.unsubAt))) {
      s.unsubAt = when ?? s.unsubAt ?? 0;
      s.https = u.https[0] || null;
      s.mailto = u.mailto[0] || null;
      s.oneClick = !!s.https && /list-unsubscribe=one-click/i.test(h["list-unsubscribe-post"] || "");
      s.rawUnsub = (h["list-unsubscribe"] || "").slice(0, 2000);
      s.rawPost = (h["list-unsubscribe-post"] || "").slice(0, 200);
      if (link) s.mailLink = link;
    }
  }
  result(){
    return [...this.s.values()].map(s => ({
      id: s.domain,
      name: [...s.names].sort((a,b) => b[1]-a[1])[0]?.[0] || s.domain,
      domain: s.domain, count: s.count, last: s.last,
      https: s.https, mailto: s.mailto, oneClick: s.oneClick, rawUnsub: s.rawUnsub, rawPost: s.rawPost,
      mailLink: s.mailLink || s.latestLink,
      kind: (s.https || s.mailto) ? "sub" : s.acc ? "acc" : "other",
    })).sort((a,b) => b.count - a.count);
  }
}

/* ================================================================ helpers */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const utf8b64url = s => b64url(new TextEncoder().encode(s));

class RateLimitError extends Error {}
const RATE_LIMIT_MSG = "Google begrenser hvor mye som kan leses per minutt. Vent et par minutter og prøv igjen.";
async function api(url, token, opts = {}){
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) } });
    if (r.status === 401) throw new Error("Innloggingen har utløpt. Logg inn på nytt.");
    if (r.ok) return r.status === 204 || r.status === 202 ? null : r.json().catch(() => null);
    let err = {}; try { err = (await r.json()).error || {}; } catch {}
    const reasons = (err.errors || []).map(e => e.reason);
    const limited = r.status === 429 || (r.status === 403 && (/quota|rate ?limit/i.test(err.message || "") ||
      reasons.some(x => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(x))));
    if ((limited || r.status >= 500) && attempt < 5) {
      // truncated exponential backoff with jitter, as Google recommends
      const after = Number(r.headers.get("Retry-After"));
      await sleep(after ? after * 1000 : Math.min(32000, 2 ** attempt * CFG.retryBaseMs) + Math.random() * CFG.retryBaseMs);
      continue;
    }
    if (limited) throw new RateLimitError(RATE_LIMIT_MSG);
    throw new Error(`Kontoen svarte med feil ${r.status}${err.message ? ": " + err.message : ""}`);
  }
}
// Keeps Gmail calls under the per-user quota, so we slow down instead of being refused.
const Quota = {
  log: [],
  async take(units){
    for (;;) {
      const now = Date.now();
      this.log = this.log.filter(([at]) => now - at < CFG.quotaWindowMs);
      const used = this.log.reduce((sum, [, u]) => sum + u, 0);
      if (used + units <= CFG.gmailUnitsPerMinute) { this.log.push([now, units]); return; }
      await sleep(Math.max(50, this.log[0][0] + CFG.quotaWindowMs - now + 20));
    }
  },
};
async function pool(items, size, fn){
  let i = 0, failed = null;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length && !failed) { const k = i++; try { await fn(items[k], k); } catch (e) { failed = failed || e; } }
  }));
  if (failed) throw failed;
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
  // Sign-in happens in the same tab (OAuth 2.0 token flow with redirect), like Microsoft. Google's popup
  // flow broke on iPhone: Safari opens the popup as a separate tab and loses the way back to Mailmap.
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  signIn(){
    if (!CFG.googleClientId) return showErr("Google-innlogging er ikke satt opp ennå. Legg inn googleClientId i config.js (se README).");
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem("mm-g-state", state);
    const p = new URLSearchParams({ client_id: CFG.googleClientId, redirect_uri: Microsoft.redirect(), response_type: "token",
      scope: Google.scope, state, include_granted_scopes: "false", prompt: "select_account" });
    location.assign(`${Google.auth}?${p}`);
  },
  handleRedirect(){
    const q = new URLSearchParams(location.hash.slice(1));
    if (!q.has("access_token") && !q.has("error")) return false;
    history.replaceState(null, "", Microsoft.redirect());          // keep the token out of the address bar and history
    const saved = sessionStorage.getItem("mm-g-state");
    sessionStorage.removeItem("mm-g-state");
    if (!saved || q.get("state") !== saved) { showErr("Innloggingen kunne ikke bekreftes. Prøv igjen."); return true; }
    if (q.has("error")) { showErr("Google-innloggingen ble avbrutt."); return true; }
    if (!(q.get("scope") || "").includes("gmail.metadata")) { showErr("Mailmap trenger tilgang til å lese e-posthodene. Prøv igjen og huk av for tilgangene."); return true; }
    start(Google, q.get("access_token"));
    return true;
  },
  async who(t){ return (await api("https://gmail.googleapis.com/gmail/v1/users/me/profile", t)).emailAddress; },
  async listIds(t, label, max){
    const ids = []; let page = "";
    do {
      await Quota.take(5);
      const r = await api("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500"
        + (label ? "&labelIds=" + label : "") + (page ? "&pageToken=" + page : ""), t);
      (r.messages || []).forEach(m => ids.push(m.id));
      page = r.nextPageToken;
    } while (page && ids.length < max);
    return ids.slice(0, max);
  },
  async scan(t, onMsg, onProgress, shouldStop = () => false){
    const max = CFG.gmailMaxMessages;
    // Newsletters live in Gmail's Promotions and Updates categories, so read those first –
    // with ~300 e-mails a minute, that finds far more senders than the newest mail overall.
    let ids = [];
    try {
      const [promo, upd] = await Promise.all([this.listIds(t, "CATEGORY_PROMOTIONS", max), this.listIds(t, "CATEGORY_UPDATES", max)]);
      for (let i = 0; i < Math.max(promo.length, upd.length); i++) ids.push(promo[i], upd[i]);
      ids = [...new Set(ids.filter(Boolean))];
    } catch (e) { if (e instanceof RateLimitError) throw e; ids = []; }
    if (ids.length < max) {
      const rest = await this.listIds(t, "", max);
      ids = [...new Set([...ids, ...rest])];
    }
    ids = ids.slice(0, max);
    onProgress(0, ids.length);
    const q = HEADERS.map(h => "metadataHeaders=" + encodeURIComponent(h)).join("&");
    let done = 0;
    await pool(ids, 4, async id => {
      if (shouldStop()) return;
      await Quota.take(20);
      if (shouldStop()) return;
      const m = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&${q}`, t);
      const h = {}; (m.payload?.headers || []).forEach(x => { const k = x.name.toLowerCase(); if (!(k in h)) h[k] = x.value; });
      const link = /^[0-9a-f]{6,32}$/i.test(id)
        ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(session.email)}#all/${id}` : null;
      onMsg(h, link); onProgress(++done, ids.length);
    });
  },
  async send(t, to, subject, body){
    const raw = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
    await api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", t,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: utf8b64url(raw) }) });
  },
  revoke(t){ fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST", mode: "no-cors" }).catch(() => {}); },
};

/* ================================================================ Microsoft (PKCE, no secret) */
const Microsoft = {
  scope: "openid offline_access User.Read Mail.Read Mail.Send",
  auth: "https://login.microsoftonline.com/common/oauth2/v2.0",
  // Same URI whether the page was opened as /mailmap/ or /mailmap/index.html – it must match the app registration.
  // The registered address must match exactly, so use it whenever the page runs on that site (even if opened
  // as /mailmap/ or /Mailmap/index.html); elsewhere (local testing) use the page's own address.
  redirect: () => CFG.redirectUri && CFG.redirectUri.startsWith(location.origin + "/") ? CFG.redirectUri
    : location.origin + location.pathname.replace(/index\.html$/, ""),
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
  async scan(t, onMsg, onProgress, shouldStop = () => false){
    let url = "https://graph.microsoft.com/v1.0/me/messages?$select=from,subject,receivedDateTime,internetMessageHeaders,webLink&$orderby=receivedDateTime%20desc&$top=100";
    let done = 0;
    while (url && done < CFG.maxMessages && !shouldStop()) {
      const r = await api(url, t, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      for (const m of r.value || []) {
        const h = {};
        (m.internetMessageHeaders || []).forEach(x => { const k = x.name.toLowerCase(); if (!(k in h)) h[k] = x.value; });
        const f = m.from?.emailAddress;
        if (!h.from && f) h.from = `${f.name || ""} <${f.address}>`;
        h.subject = h.subject || m.subject || "";
        h.date = h.date || m.receivedDateTime;
        onMsg(h, safeMailLink(m.webLink)); onProgress(++done, Math.max(done, CFG.maxMessages));
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
      onMsg(h, "demo"); onProgress(++done, total);
      if (done % 40 === 0) await sleep(30);
    }
  },
  async send(){ await sleep(400); },
  revoke(){},
};

/* ================================================================ unsubscribe */
// Sends the unsubscribe through every automatic channel the sender offers and returns the
// channels that went out. Throws only if none did. The browser can't read the sender's reply
// to the one-click POST (CORS), so a request that went out is "sent", not "confirmed".
async function unsubscribe(s){
  if (session.provider === Demo) { await sleep(350); return [s.oneClick && "post", s.mailto && "mail"].filter(Boolean); }
  const sent = [], errors = [];
  if (s.https && s.oneClick) {
    try {
      await fetch(s.https, { method: "POST", mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer",
        body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) });
      sent.push("post");
    } catch (e) { errors.push(e); }
  }
  if (s.mailto) {
    // An unsubscribe e-mail is handled by the sender's own servers, which makes it the most robust channel.
    try { const m = parseMailto(s.mailto); await session.provider.send(session.token, m.to, m.subject, m.body); sent.push("mail"); }
    catch (e) { errors.push(e); }
  }
  if (!sent.length) throw errors[0] || new Error("Ingen automatisk avmelding tilgjengelig.");
  return sent;
}
const VIA = { post: "ett klikk", mail: "e-post", page: "avsenderens nettside" };
function describe(s){
  const ways = [];
  if (s.https && s.oneClick) ways.push("Ett klikk (RFC 8058) til " + host(s.https));
  if (s.mailto) ways.push("E-post til " + (s.mailto.replace(/^mailto:/i, "").split("?")[0]));
  if (!ways.length && s.https) ways.push("Bare nettside – du må bekrefte hos " + host(s.https));
  return ways.join(" + ") || "Ingen avmeldingslenke";
}
function host(u){ try { return new URL(u).hostname; } catch { return "?"; } }

/* ================================================================ UI */
const $ = id => document.getElementById(id);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const nb = new Intl.DateTimeFormat("nb-NO", { day:"numeric", month:"short", year:"numeric" });
const n = x => x.toLocaleString("nb-NO");
const safeHttps = u => { try { return new URL(u).protocol === "https:" ? u : null; } catch { return null; } };
const MAIL_HOSTS = new Set(["outlook.live.com", "outlook.office.com", "outlook.office365.com"]);
const safeMailLink = u => { try { const x = new URL(u); return x.protocol === "https:" && MAIL_HOSTS.has(x.hostname) ? u : null; } catch { return null; } };

const session = { provider: null, token: null, email: "" };
let items = [], state = {}, picked = new Set(), view = "sub", shown = 50, query = "";
const fresh = new Set();   // rows that should play the postmark animation once
const stay = new Set();    // stamped rows kept in the "Abonnert" list until the tab changes
let sentLog = {};          // id -> { t: when unsubscribe was sent, via: ["post","mail"] | ["page"] }
const GRACE = 2 * 864e5;  // senders get two days to process an unsubscribe
// Everything Mailmap remembers is stored under the signed-in address and only shown to that address.
const storeKey = () => "mailmap-sent:" + session.email.trim().toLowerCase();
const loadDone = () => {
  try {
    sentLog = JSON.parse(localStorage.getItem(storeKey()) || "{}");
    // Unsubscribes stored by the first version had no timestamp and used only one channel;
    // drop them so those senders show up again and can be re-sent with the current method.
    localStorage.removeItem("mailmap-done:" + session.email);
  } catch { sentLog = {}; }
  const st = {}; for (const k of Object.keys(sentLog)) st[k] = "done"; return st;
};
// Merge with what is stored, so two tabs on the same account never overwrite each other's unsubscribes.
const saveDone = () => {
  if (session.provider === Demo || !session.email) return;
  try {
    const stored = JSON.parse(localStorage.getItem(storeKey()) || "{}");
    for (const [id, e] of Object.entries(stored)) {
      const mine = sentLog[id];
      if (!mine || (e.t || 0) > (mine.t || 0)) { sentLog[id] = e; if (state[id] !== "busy") state[id] = "done"; }
      else if (e.checked && !mine.checked && e.t === mine.t) mine.checked = true;
    }
    localStorage.setItem(storeKey(), JSON.stringify(sentLog));
  } catch {}
};
// "still": new mail arrived after the grace period. "wait": too early to tell. "quiet": no new mail since.
function verdict(s){
  const e = sentLog[s.id]; if (!e || !e.t) return "unknown";
  if (s.last && s.last > e.t + GRACE) return "still";
  return Date.now() < e.t + GRACE ? "wait" : "quiet";
}
const stillSending = s => state[s.id] === "done" && verdict(s) === "still";
const isManual = s => !(s.oneClick || s.mailto);
// Many senders' own unsubscribe pages ask for the e-mail address. Copy it during the click
// (clipboard access is only allowed inside a user action) so the user can just paste it.
function copyEmail(extra = ""){
  const tail = extra ? " " + extra : "";
  if (!session.email || session.provider === Demo) return toast("E-posten din blir kopiert her, så du kan lime den inn på siden." + tail);
  navigator.clipboard.writeText(session.email)
    .then(() => toast(`${session.email} er kopiert. Spør siden etter e-post, lim den inn med Ctrl+V.` + tail))
    .catch(() => toast("Siden åpnet seg. Spør den etter e-post, skriv inn " + session.email + "." + tail));
}

function show(v){ ["vStart","vRead","vList"].forEach(x => $(x).hidden = x !== v); $("dock").hidden = true; }
function showErr(msg){ show("vStart"); $("signin").hidden = false; $("gWarn").hidden = true; const e = $("startErr"); e.textContent = msg; e.hidden = false; }
function toast(msg){ const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), Math.max(2600, msg.length * 55)); }

const scan = { running: false, stop: false, done: 0, total: 0, partial: "" };
async function start(provider, token){
  session.provider = provider; session.token = token;
  track(provider === Google ? "login-google" : provider === Microsoft ? "login-microsoft" : "demo");
  $("signin").hidden = false; $("gWarn").hidden = true;
  $("startErr").hidden = true;
  show("vRead"); $("bar").style.width = "0";
  $("readHint").hidden = provider !== Google;
  Object.assign(scan, { running: true, stop: false, done: 0, total: 0, partial: "" });
  let an = null, listShown = false, lastRefresh = 0;
  const refresh = () => {
    items = an.result(); lastRefresh = Date.now();
    if (!listShown) {
      listShown = true;
      state = provider === Demo ? (sentLog = {}, {}) : loadDone(); picked = new Set(); view = "sub"; shown = 50; query = ""; $("q").value = "";
      $("who").textContent = session.email;
      $("demoNote").hidden = provider !== Demo;
      show("vList");
    }
    render();
  };
  try {
    session.email = await provider.who(token);
    an = new Analyzer(session.email);
    await provider.scan(token, (h, link) => an.add(h, link), (done, total) => {
      scan.done = done; scan.total = total;
      $("bar").style.width = total ? (done / total * 100).toFixed(1) + "%" : "4%";
      $("readText").textContent = done ? `${n(done)} av ${n(total)} e-poster lest` : `Fant ${n(total)} e-poster …`;
      // Gmail is slow by quota: show what we have after the first batch, then refresh now and then.
      if (provider === Google && !listShown && done >= CFG.firstBatch && done < total) refresh();
      else if (listShown && Date.now() - lastRefresh > 6000) refresh();
    }, () => scan.stop);
  } catch (e) {
    if (e instanceof RateLimitError && an && an.messages > 0) {
      scan.partial = `Google stoppet lesingen etter ${n(an.messages)} e-poster på grunn av fartsgrensen. Logg inn igjen om noen minutter for å lese flere.`;
    } else {
      scan.running = false;
      return showErr(e.message || "Noe gikk galt under lesingen. Prøv igjen.");
    }
  }
  scan.running = false;
  if (scan.stop && an) scan.partial = `Du stoppet lesingen etter ${n(an.messages)} e-poster.`;
  refresh();
}

function render(){
  $("scanNote").hidden = !scan.running && !scan.partial;
  $("scanText").textContent = scan.running
    ? `Leser fortsatt innboksen: ${n(scan.done)} av ${n(scan.total)} e-poster. Lista fylles på underveis.`
    : scan.partial;
  $("scanStop").hidden = !scan.running;
  const subs = items.filter(s => s.kind === "sub" && (state[s.id] !== "done" || stillSending(s)));
  const done = items.filter(s => state[s.id] === "done" && !stillSending(s));
  const acc = items.filter(s => s.kind === "acc");
  $("headline").textContent = scan.running
    ? `Så langt: ${n(subs.length)} nyhetsbrev funnet.`
    : subs.length ? `Du er abonnert på ${n(subs.length)} nyhetsbrev.` : "Du er ikke abonnert på noe lenger.";
  const manualCount = subs.filter(s => isManual(s) || stillSending(s)).length;
  $("manualNote").hidden = !manualCount || view !== "sub";
  $("manualNote").textContent = manualCount === 1
    ? "1 av dem må gjøres manuelt hos avsenderen. Den er merket i lista."
    : `${manualCount} av dem må gjøres manuelt hos avsenderen. De er merket i lista.`;
  const unchecked = items.filter(s => state[s.id] === "done" && !stillSending(s) && sentLog[s.id] && !sentLog[s.id].checked && verdict(s) !== "quiet");
  $("checkNote").hidden = !unchecked.length;
  $("checkNote").textContent = unchecked.length === 1
    ? "Du har sendt 1 avmelding. Mailmap kan ikke se om avsenderen godtok den. Sjekk den med «Sjekk hos avsender», som åpner avsenderens side eller den siste e-posten fra dem."
    : `Du har sendt ${unchecked.length} avmeldinger. Mailmap kan ikke se om hver avsender godtok dem. Sjekk hver enkelt med «Sjekk hos avsender», som åpner avsenderens side eller den siste e-posten fra dem.`;
  const [a, b, c] = $("tabs").children;
  a.textContent = `Abonnert ${subs.length}`; b.textContent = `Sendt ${done.length}`; c.textContent = `Kontoer ${acc.length}`;
  [...$("tabs").children].forEach(x => x.setAttribute("aria-pressed", x.dataset.v === view));

  const all = view === "sub" ? items.filter(s => s.kind === "sub" && (state[s.id] !== "done" || stillSending(s) || stay.has(s.id))) : view === "done" ? done : acc;
  // senders that ignored an unsubscribe go first – they need the user's attention
  if (view === "sub") all.sort((x, y) => stillSending(y) - stillSending(x));
  const q = query.trim().toLowerCase();
  const rows = q ? all.filter(s => (s.name + " " + s.domain).toLowerCase().includes(q)) : all;
  const list = $("list"); list.replaceChildren();
  if (!rows.length) list.append(el("li","empty", q ? `Ingen avsendere passer «${query.trim()}».`
    : view === "sub" ? "Ingen abonnementer igjen." : view === "done" ? "Du har ikke sendt noen avmeldinger ennå." : "Ingen kontoer funnet."));

  // "Velg alle" selects every matching row in the list, also those not shown yet.
  const selectable = view === "sub" ? rows.filter(s => (state[s.id] !== "done" || stillSending(s)) && state[s.id] !== "busy") : [];
  const chosen = selectable.filter(s => picked.has(s.id)).length;
  $("allWrap").hidden = !selectable.length;
  $("all").checked = selectable.length > 0 && chosen === selectable.length;
  $("all").indeterminate = chosen > 0 && chosen < selectable.length;
  $("allText").textContent = q ? `Velg alle treff (${selectable.length})` : `Velg alle (${selectable.length})`;
  rows.slice(0, shown).forEach(s => list.append(view === "acc" ? accRow(s) : subRow(s)));
  const rest = rows.length - shown;
  $("more").hidden = rest <= 0; $("more").textContent = `Vis ${Math.min(50, rest)} til`;

  const sel = [...picked].filter(id => state[id] !== "busy" && (state[id] !== "done" || stillSending(items.find(s => s.id === id) || {})));
  $("dock").hidden = view !== "sub" || !sel.length;
  $("dockText").textContent = `${sel.length} valgt`;
  $("bulk").textContent = `Meld av ${sel.length}`;
}

function meta(s){ return `${n(s.count)} ${s.count === 1 ? "e-post" : "e-poster"}${s.last ? ", sist " + nb.format(s.last) : ""}`; }

function subRow(s){
  const li = el("li","row"), st = state[s.id], still = stillSending(s);
  const isDone = st === "done" && !still;
  if (view === "sub" && isDone) li.append(el("span", "cbspace"));
  if (view === "sub" && !isDone) {
    const cb = el("input"); cb.type = "checkbox"; cb.checked = picked.has(s.id); cb.setAttribute("aria-label", "Velg " + s.name);
    cb.disabled = st === "busy";
    cb.onchange = () => { cb.checked ? picked.add(s.id) : picked.delete(s.id); render(); };
    li.append(cb);
  }
  li.append(el("div","ava", s.name.trim()[0]?.toUpperCase() || "?"));
  const who = el("div","who"); who.append(el("b","", s.name), el("span","", meta(s)));
  const e = sentLog[s.id], href = safeHttps(s.https);
  if (still) who.append(el("span","flag", `Sender fortsatt, selv om du meldte deg av ${nb.format(e.t)}. Må gjøres manuelt.`));
  else if (!isDone && isManual(s)) who.append(el("span","manual", "Må gjøres manuelt på avsenderens side"));
  else if (isDone && e) {
    const v = verdict(s), via = (e.via || []).map(x => VIA[x]).filter(Boolean).join(" og ");
    const when = e.t ? `Sendt ${nb.format(e.t)}${via ? " via " + via : ""}. ` : "";
    const tail = v === "quiet" ? "Ingen nye e-poster siden."
      : e.checked ? "Du har sjekket hos avsenderen."
      : "Det kan ta et par dager før e-postene stopper.";
    who.append(el("span", "note " + (e.checked && v !== "quiet" ? "quiet" : v), when + tail));
    // Visiting a one-click link in the browser always asks for confirmation – say it up front.
    if (s.oneClick && v !== "quiet")
      who.append(el("span", "hint", "Sjekker du hos avsenderen, kan de be deg bekrefte. Det er normalt og betyr ikke at det feilet."));
  }
  const act = el("div","act");
  const pageLink = (label, cls, extra) => {
    const a = el("a", "btn " + cls, label);
    if (href && session.provider !== Demo) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    else a.href = "#";   // demo: keep it a real, keyboard-reachable link, but go nowhere
    a.onclick = ev => { if (session.provider === Demo) ev.preventDefault(); copyEmail(extra); };
    return a;
  };
  // One-click unsubscribe links only accept POST (opening them shows an error page), so to let the
  // user check, open the newest e-mail from the sender, where the normal footer link works.
  const mailBtn = (label, cls) => {
    const a = el("a", "btn " + cls, label);
    if (s.mailLink && session.provider !== Demo) { a.href = s.mailLink; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    else a.href = "#";
    a.onclick = ev => { if (session.provider === Demo) ev.preventDefault();
      toast("Bruk avmeldingslenken nederst i e-posten for å sjekke eller melde deg av."); };
    return a;
  };
  const FALLBACK = s.oneClick && s.mailLink ? "Viser siden en feil, åpne Detaljer → «Åpne siste e-post»." : "";
  // Opening an unsubscribe link in a browser (GET) never unsubscribes by itself – senders ask you to
  // confirm, so link scanners can't unsubscribe people by accident. Say so, or users think it failed.
  const CONFIRM = s.oneClick ? "Ber siden deg bekrefte, velge pause eller skrive e-post, er det normalt. Trykk bekreft for å være sikker." : "";
  const checkBtn = (label, cls) => href ? pageLink(label, cls, [CONFIRM, FALLBACK].filter(Boolean).join(" ")) : (s.mailLink ? mailBtn(label, cls) : null);
  if (isDone) {
    act.append(el("span", fresh.has(s.id) ? "state" : "state still", "Sendt")); fresh.delete(s.id);
    const c = !(e && e.checked) && verdict(s) !== "quiet" ? checkBtn("Sjekk hos avsender", "small") : null;
    if (c) {
      const open = c.onclick;
      c.onclick = ev => { open(ev); if (e) { e.checked = true; saveDone(); } stay.add(s.id); render(); };
      act.append(c);
    }
  } else if (st === "busy") act.append(el("span","state wait","Sender …"));
  else if (st === "fail") {
    act.append(el("span","state bad","Feilet"));
    const r = el("button","btn red","Prøv igjen"); r.onclick = () => run([s]); act.append(r);
  } else if (still) {
    const c = checkBtn("Åpne avmeldingsside", "red"); if (c) act.append(c);
    if (s.oneClick || s.mailto) { const r = el("button","btn","Send på nytt"); r.onclick = () => run([s]); act.append(r); }
  } else if (s.oneClick || s.mailto) {
    const b = el("button","btn red","Meld av"); b.onclick = () => run([s]); act.append(b);
  } else {
    const a = pageLink("Åpne avmelding", "red");
    a.title = "Denne avsenderen krever at du bekrefter på deres side";
    const old = a.onclick;
    a.onclick = ev => { old(ev); sentLog[s.id] = { t: Date.now(), via: ["page"] }; state[s.id] = "done"; saveDone(); picked.delete(s.id);
      render(); };
    act.append(a);
  }

  // Details: exactly what Mailmap found and will use, so the user (or a developer) can check it.
  const det = el("details","det"), sum = el("summary","","Detaljer");
  const dl = el("dl");
  const row = (k, v) => { if (v) dl.append(el("dt","",k), el("dd","",v)); };
  row("Metode", describe(s));
  row("List-Unsubscribe", s.rawUnsub);
  row("List-Unsubscribe-Post", s.rawPost || "(mangler – avsenderen støtter ikke ett klikk)");
  if (e && e.t) row("Sendt", new Date(e.t).toLocaleString("nb-NO"));
  if (s.last) row("Siste e-post", new Date(s.last).toLocaleString("nb-NO"));
  det.append(sum, dl);
  if (isDone && href) det.append(pageLink("Åpne avmeldingslenken", "small", FALLBACK));
  if (s.mailLink && session.provider !== Demo) det.append(mailBtn("Åpne siste e-post", "small"));
  const cp = el("button","btn small","Kopier detaljer");
  cp.onclick = async () => {
    const text = [...dl.children].reduce((acc, x, i, arr) => i % 2 ? acc : acc + x.textContent + ": " + arr[i+1].textContent + "\n", s.name + "\n");
    try { await navigator.clipboard.writeText(text); toast("Detaljene er kopiert."); } catch { toast("Kopiering ble blokkert av nettleseren."); }
  };
  det.append(cp);
  li.append(who, act, det);
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
    try {
      const via = await unsubscribe(s);
      sentLog[s.id] = { t: Date.now(), via };
      state[s.id] = "done"; fresh.add(s.id); stay.add(s.id); ok++;
    } catch (e) { state[s.id] = "fail"; bad++; if (/utløpt/.test(e.message)) toast(e.message); }
    saveDone(); render();
  });
  if (ok) track("unsubscribe");
  if (manual.length) toast(`${manual.length} avsender${manual.length === 1 ? "" : "e"} krever at du bekrefter på deres side. Trykk «Åpne avmelding» på dem.`);
  else if (ok && !bad) toast(`Avmelding sendt til ${ok === 1 ? "1 avsender" : ok + " avsendere"}. Sjekk hver enkelt hos avsenderen for å være sikker.`);
  else if (bad) toast(`${bad} feilet. Trykk «Prøv igjen».`);
}

/* ================================================================ analytics */
// Anonymous counts sent straight to GoatCounter: no third-party script, no cookies.
// Only these fixed names are ever sent – never an e-mail address, sender, token or the page URL.
const EVENTS = new Set(["/", "demo", "login-google", "login-microsoft", "unsubscribe"]);
function track(name){
  if (!CFG.stats || !EVENTS.has(name)) return;
  let ref = "";
  try { const r = new URL(document.referrer); if (r.origin !== location.origin && !/microsoftonline|google/.test(r.hostname)) ref = r.origin; } catch {}
  const p = new URLSearchParams({ p: name, t: name === "/" ? "Mailmap" : name, e: String(name !== "/"), r: ref,
    s: `${screen.width},${screen.height},${devicePixelRatio || 1}`, rnd: Math.random().toString(36).slice(2) });
  fetch(`${CFG.stats}?${p}`, { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", keepalive: true }).catch(() => {});
}

/* ================================================================ events */
// Google shows an "unverified app" warning (Mailmap isn't verified by Google). Explain it first.
function gWarn(show){
  $("signin").hidden = show; $("gWarn").hidden = !show; $("startErr").hidden = true;
  (show ? $("gWarnTitle") : $("gBtn")).focus();
}
$("gBtn").onclick = () => gWarn(true);
$("gBack").onclick = () => gWarn(false);
$("gGo").onclick = () => Google.signIn();
$("mBtn").onclick = () => Microsoft.signIn();
$("demoBtn").onclick = () => start(Demo, "demo");
$("tabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; view = b.dataset.v; shown = 50; stay.clear(); render(); };
$("more").onclick = () => { shown += 50; render(); };
$("scanStop").onclick = () => { scan.stop = true; $("scanStop").disabled = true; };
$("q").addEventListener("input", e => { query = e.target.value; shown = 50; render(); });
$("all").onchange = e => {
  const q = query.trim().toLowerCase();
  items.filter(s => s.kind === "sub" && (state[s.id] !== "done" || stillSending(s)) && state[s.id] !== "busy" &&
    (!q || (s.name + " " + s.domain).toLowerCase().includes(q)))
    .forEach(s => e.target.checked ? picked.add(s.id) : picked.delete(s.id));
  render();
};
$("bulk").onclick = () => run(items.filter(s => picked.has(s.id) && state[s.id] !== "busy" && (state[s.id] !== "done" || stillSending(s))));
$("out").onclick = () => {
  scan.stop = true; scan.running = false; scan.partial = "";
  session.provider?.revoke(session.token);
  Object.assign(session, { provider: null, token: null, email: "" });
  items = []; state = {}; sentLog = {}; picked.clear(); fresh.clear(); stay.clear();
  show("vStart");
};

// A return from Google or Microsoft sign-in is not a new visit.
if (!/[?&](code|error)=/.test(location.search) && !/(access_token|error)=/.test(location.hash)) track("/");
Google.handleRedirect();
Microsoft.handleRedirect().catch(e => showErr(e.message));
