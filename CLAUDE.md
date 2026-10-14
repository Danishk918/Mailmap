# Mailmap – arbeidsregler

- **Oppdater README.md i samme commit som hver endring** som påvirker hva siden gjør, hvordan den ser ut,
  eller hvordan den settes opp. README er det rekrutterere og brukere ser. Dette er et krav fra eieren.
- Web-appen ligger i `web/`. `web/app.html` er kilden; `web/index.html` bygges med `python3 scripts/build_web.py`
  (legger på `?v=<commit>` på skriptene). Den er ikke i Git: GitHub Actions bygger den ved hver publisering,
  og testene bygger den selv.
- Alt innhold fra e-post (avsender, emne, headere) er fiendtlig input: vis det kun via `textContent`, godta bare
  `https:`/`mailto:`-lenker, og ingen inline-skript (streng CSP).
- Kjør `pytest -q` før commit. Nettlesertestene ligger i `tests/web` og kjører i CI; legg til en test når
  du endrer oppførsel, særlig sikkerhet.
- Commit-forfatter: `Danish <200293618+Danishk918@users.noreply.github.com>`. Aldri en ekte e-postadresse.
- Repoet heter `Danishk918/Mailmap` (stor M). Siden: https://danishk918.github.io/Mailmap/
- Skjermbildet i README er `docs/web.png` (PC-versjonen, ett bilde), vist med vanlig Markdown `![](docs/web.png)`.
  Ikke bruk HTML-`<img>` eller `?v=` på bildestier: GitHub-mobilappen viser dem ikke. Ta bildet på nytt når siden endres.
