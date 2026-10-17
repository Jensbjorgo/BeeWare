# BeeWare

Et lite MVP-prosjekt for å melde fra om busskontrollører i nærheten.

## Hva appen gjør

- Viser et kart med nylige observasjoner.
- Lar brukeren trykke i kartet eller bruke egen posisjon for å registrere en observasjon.
- Viser egen posisjon som egen blå markør i kartet.
- Henter nærmeste holdeplass fra GTFS-dataene i `data/stops.txt`.
- Lar brukeren knytte observasjonen til busslinje fra `data/routes.txt`.
- Lar brukeren publisere anonymt, eller logge inn frivillig for å samle XP og level.
- Lar andre bekrefte observasjoner med likes.
- Deler observasjoner mellom brukere som åpner samme server.

## Kjør lokalt

```bash
python3 server.py
```

Åpne deretter `http://127.0.0.1:8080`.

Krever Python 3.10 eller nyere. Ingen ekstra Python-pakker er nødvendige.
Kartet krever internettilgang.

For holdeplass- og linjesøk: legg GTFS-filene `stops.txt` og `routes.txt`
i en lokal `data/`-mappe, og start serveren på nytt. Disse filene følger ikke
med repositoryet. Uten filene fungerer kart og rapportering fortsatt, men
holdeplass- og linjesøk gir ingen treff. Sted og linje kan skrives inn manuelt.

## Lagring

Observasjoner lagres i `storage/sightings.json` og vises i 3 timer før de ryddes bort automatisk.
Brukere lagres i `storage/users.json` og aktive sesjoner i `storage/sessions.json`.
Nettleseren får også en lokal klient-cookie for å holde styr på likes per enhet/nettleser.
`storage/` opprettes automatisk og ignoreres av Git. Ikke del brukerdata eller sesjonsfiler.

## Teknisk

- Backend: standardbibliotek i Python (`http.server` + JSON API)
- Frontend: HTML, CSS og JavaScript
- Kart: Leaflet med OpenStreetMap-fliser

## Lokasjon

Trykk «Bruk min posisjon» og gi nettleseren tilgang til posisjonen din.
Den blå markøren viser hvor du er, og sirkelen viser anslått nøyaktighet.
Knappen flytter også rapportposisjonen til deg. Et klikk i kartet eller flytting
av rapportmarkøren lar deg velge et annet sted uten at GPS overskriver valget.

Lokasjon krever HTTPS, med unntak for `localhost` og `127.0.0.1` på samme enhet.
Åpner du nettsiden på mobil via en vanlig HTTP-adresse på lokalnettet, vil
nettleseren blokkere lokasjon. Bruk en HTTPS-adresse for testing fra andre enheter.
Sjekk også stedstillatelser både i nettleseren og på enheten.

Nettsiden leser holdeplasser og linjer fra `data/stops.txt` og `data/routes.txt`.
Hvis GTFS-filene mangler, starter appen uten holdeplass- og linjedata.

## Kontroll av endringer

```bash
python3 -m unittest discover -s tests
node --test tests/*.test.mjs
```

## Mobilapp (satt på vent)

Det genererte iOS-bygget i `build/` er lokalt og følger ikke med repositoryet.
Nettsiden kjøres med `python3 server.py`.
