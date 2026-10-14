[← Tilbake til README](../README.md)

# Sett opp innlogging (én gang, gratis)

Du som utvikler må registrere appen hos Google og Microsoft for å få lov til å lese e-post.
Det tar ca. 15 minutter. Brukerne trenger ikke gjøre noe av dette.

**1. Publiser siden (GitHub Pages)**
Legg repoet på GitHub → *Settings* → *Pages* → *Source:* **GitHub Actions**.
Workflowen `pages.yml` publiserer `web/` til `https://danishk918.github.io/Mailmap/`.

**2. Google (Gmail)**
1. [console.cloud.google.com](https://console.cloud.google.com) → nytt prosjekt «mailmap».
2. *APIs & Services* → *Library* → aktiver **Gmail API**.
3. *Google Auth Platform* (OAuth consent screen) → *External* → fyll inn navn og e-post.
4. *Data access* → legg til `gmail.metadata` og `gmail.send`.
5. *Clients* → *Create client* → **Web application** → *Authorized JavaScript origins*:
   `https://danishk918.github.io` og `http://localhost:8000`.
6. Kopier *Client ID* inn i `web/config.js` → `googleClientId`.
7. *Branding* → *Application home page* `https://danishk918.github.io/Mailmap/`, *Privacy policy*
   `https://danishk918.github.io/Mailmap/personvern.html`, *Authorized domains* `danishk918.github.io`.
   Ikke last opp logo – det krever full verifisering.
8. *Audience* → **Publish app**. Da kan alle Google-kontoer logge inn (med varsel om uverifisert app).

**3. Microsoft (Outlook/Hotmail)**
1. [portal.azure.com](https://portal.azure.com) → *App registrations* → *New registration*.
2. *Supported account types:* **Accounts in any organizational directory and personal Microsoft accounts**.
3. *Redirect URI:* plattform **Single-page application (SPA)** →
   `https://danishk918.github.io/Mailmap/` (legg også til `http://localhost:8000/` under *Authentication*).
4. *API permissions* → *Microsoft Graph* → *Delegated* → `Mail.Read`, `Mail.Send` (`User.Read` er der fra før).
5. Kopier *Application (client) ID* inn i `web/config.js` → `microsoftClientId`.

**Test lokalt:** `cd web && python3 -m http.server 8000` → åpne `http://localhost:8000/`.
Uten oppsett fungerer **«Prøv uten å logge inn»** med eksempeldata.

Begrensninger ved Google- og Microsoft-innloggingen står i [README](../README.md#begrensninger).

## Mellomlagring

Hver versjon får et versjonsnummer på skriptene (`?v=<commit>`), så telefoner og hjemskjerm-ikoner henter ny kode
etter publisering. Selve siden kan likevel være mellomlagret i opptil 10 minutter.
