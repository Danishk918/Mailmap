# Mailmap – arbeidsregler

- **Oppdater README.md i samme commit som hver endring** som påvirker hva siden gjør, hvordan den ser ut,
  eller hvordan den settes opp. README er det rekrutterere og brukere ser. Dette er et krav fra eieren.
- Web-appen ligger i `web/`. `web/app.html` er kilden; `web/index.html` bygges med `python3 scripts/build_web.py`
  (legger på `?v=<commit>` på skriptene). Kjør bygget før commit.
- Alt innhold fra e-post (avsender, emne, headere) er fiendtlig input: vis det kun via `textContent`, godta bare
  `https:`/`mailto:`-lenker, og ingen inline-skript (streng CSP).
- Commit-forfatter: `Danish <200293618+Danishk918@users.noreply.github.com>`. Aldri en ekte e-postadresse.
- Repoet heter `Danishk918/Mailmap` (stor M). Siden: https://danishk918.github.io/Mailmap/
- Skjermbildet i README er `docs/preview.png` (PC og mobil satt sammen), vist med vanlig Markdown `![](docs/preview.png)`.
  Ikke bruk HTML-`<img>` eller `?v=` på bildestier: GitHub-mobilappen viser dem ikke. Lag `preview.png` på nytt
  fra `docs/web.png` og `docs/web-mobile.png` når skjermbildene tas på nytt.
