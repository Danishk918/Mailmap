[← Tilbake til README](../README.md)

# Kommandolinjeversjonen

I tillegg finnes en Python-versjon for terminalen. Den kan skanne via IMAP eller fra en eksportfil (`.mbox`),
og lage en lokal HTML-rapport.

## Installer

```bash
git clone https://github.com/Danishk918/Mailmap.git
cd Mailmap
python3 -m pip install -e .          # Python 3.10+
```

## Prøv uten ekte innboks

```bash
python3 examples/make_demo.py demo.mbox
mailmap scan --file demo.mbox --open
```

## Bruk

**1. Fra eksport (tryggest, fungerer for alle)**
Gmail: [Google Takeout](https://takeout.google.com) → kun «Mail» → du får en `.mbox`-fil.

```bash
mailmap scan --file "All mail Including Spam and Trash.mbox" --exclude deg@gmail.com --open
```

**2. Direkte via IMAP (Gmail, iCloud, Yahoo m.fl.)**
Krever et *app-passord* (Gmail: totrinnsbekreftelse på → myaccount.google.com/apppasswords).

```bash
mailmap scan --imap deg@gmail.com --folder INBOX --folder "[Gmail]/All Mail" --since 2023-01-01 --open
```

**3. Outlook / Hotmail**
Microsoft godtar ikke lenger passord over IMAP for personlige kontoer, så det kreves OAuth2.
Lag en gratis app-registrering én gang:

1. [portal.azure.com](https://portal.azure.com) → *App registrations* → *New registration*
2. Kontotype: **Personal Microsoft accounts only**
3. *Authentication* → *Add a platform* → *Mobile and desktop* → huk av `nativeclient`-URI, og sett **Allow public client flows = Yes**
4. *API permissions* → *Add* → *APIs my organization uses* → **Office 365 Exchange Online** → *Delegated* → `IMAP.AccessAsUser.All`
5. Kopier *Application (client) ID*

```bash
python3 -m pip install -e ".[outlook]"
mailmap scan --imap deg@hotmail.com --client-id <CLIENT_ID> --open
```

Du får en kode du skriver inn på microsoft.com/devicelogin. Tokenet lagres i `~/.mailmap/` med filrettigheter `600`.

### Rydde opp

- **I rapporten:** «Meld av (ett klikk)», «Åpne avmelding», eller «Kopier GDPR-sletting» for kontoer uten lenke.
- **I terminalen:**

```bash
mailmap list --category nyhetsbrev
mailmap clean --dry-run            # se hva som ville skjedd
mailmap clean                      # [a]vmeld [b]ehold [h]opp [q]uit
mailmap gdpr --address deg@hotmail.com --name "Ditt Navn"
```


## Begrensninger

- Finner bare tjenester som har sendt deg e-post (og som du ikke har slettet).
- Kategoriseringen er heuristisk (nøkkelord i emnefelt).
- Sletting av kontoer må gjøres hos tjenesten selv, eller via GDPR-forespørsel.
