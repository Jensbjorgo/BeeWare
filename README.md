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

## Lagring

Observasjoner lagres i `storage/sightings.json` og vises i 3 timer før de ryddes bort automatisk.
Brukere lagres i `storage/users.json` og aktive sesjoner i `storage/sessions.json`.
Nettleseren får også en lokal klient-cookie for å holde styr på likes per enhet/nettleser.

## Teknisk

- Backend: standardbibliotek i Python (`http.server` + JSON API)
- Frontend: HTML, CSS og JavaScript
- Kart: Leaflet med OpenStreetMap-fliser
