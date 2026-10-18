# BeeWare

Et lite MVP-prosjekt for å melde fra om busskontrollører i nærheten.

## Hva appen gjør

- Viser et kart med nylige observasjoner.
- Lar brukeren trykke i kartet eller bruke egen posisjon for å registrere en observasjon.
- Viser egen posisjon som egen blå markør i kartet.
- Dekker hele Norge med Kartverkets topografiske kart og Enturs nasjonale holdeplass- og linjedata.
- Henter nærmeste holdeplass innen 2 km, målt til nærmeste plattform.
- Søker holdeplasser med de nærmeste treffene først, og linjer med operatør (for eksempel «31 · AtB»).
- Lar brukeren publisere anonymt, eller logge inn frivillig for å samle XP og level.
- Lar innloggede brukere bekrefte andres observasjoner med likes. Hver like gir eieren XP.
- Deler observasjoner mellom brukere som åpner samme server.

## Kjør lokalt

```bash
python3 server.py
```

Åpne deretter `http://127.0.0.1:8080`.

Krever Python 3.10 eller nyere. Ingen ekstra Python-pakker er nødvendige.
Kartet krever internettilgang og starter over Oslo til GPS-en finner brukeren.

## Holdeplass- og linjedata

Dataene følger ikke med repositoryet. Hent Enturs nasjonale GTFS-datasett (omtrent 95 MB)
og pakk ut de tre filene appen bruker:

```bash
mkdir -p data
curl -fL -o data/gtfs.zip https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_norway-aggregated-gtfs-basic.zip
unzip -o data/gtfs.zip stops.txt routes.txt agency.txt -d data
rm data/gtfs.zip
```

Start serveren på nytt etterpå. Entur oppdaterer datasettet hver natt; det holder å hente
det når holdeplasser eller linjer er endret, og ikke oftere enn én gang i døgnet.
Uten filene fungerer kart og rapportering fortsatt, men holdeplass- og linjesøk gir ingen
treff. Sted og linje kan da skrives inn manuelt.

Entur har én holdeplass per stasjon med plattformer under. Søket viser stasjonene, mens
avstander måles til nærmeste plattform. Like navn innen 300 meter (for eksempel buss- og
trikkestopp med samme navn) vises som ett treff.

## Lagring

Alt lagres i SQLite-databasen `storage/beeware.db`: brukere med XP og antall likes, sesjoner,
observasjoner og likes. Observasjoner vises i 3 timer, mens XP blir værende. Utløpte observasjoner
slettes når neste observasjon sendes inn, og utløpte sesjoner ved neste innlogging. En like og XP-en
den gir, lagres i samme transaksjon, og det samme gjelder en ny bruker og første innlogging.
`storage/` opprettes automatisk og ignoreres av Git. Ikke del databasen; den inneholder brukerdata.

## Grenser

- Hver IP kan sende 3 observasjoner per 10 minutter, 10 innloggingsforsøk per 5 minutter og 3 registreringer per time.
- JSON-innhold kan være på maks 4 KB, og POST fra andre nettsteder avvises.
- Alle svar med innhold har en Content-Security-Policy som bare slipper inn Leaflet 1.9.4 fra unpkg og fliser fra
  Kartverket, og siden kan ikke bygges inn i andre nettsteder.
- Serveren lytter bare på `127.0.0.1`. Bak en HTTPS-proxy som sender `X-Forwarded-Proto: https`,
  får cookiene `Secure`. Hver klient telles etter siste adresse i `X-Forwarded-For`, så proxyen må
  legge til klientens adresse der (nginx: `$proxy_add_x_forwarded_for`; Caddy gjør det selv).
- Er databasen opptatt i mer enn 10 sekunder, svarer serveren 503 i stedet for å henge.

## Før offentlig drift

Dette må på plass før appen legges ut på nett:

- **Reverse proxy med HTTPS (nginx eller Caddy) foran serveren.** Python-serveren tåler ikke
  klienter som sender data svært sakte («slowloris»). De kan holde alle 64 forbindelsene
  opptatt. Proxyen må ta imot hele forespørselen før den sendes videre. nginx gjør det som
  standard (`proxy_request_buffering on`); i Caddy må `request_buffers 4KiB` settes under
  `reverse_proxy`. HTTPS trengs også for GPS på mobil og for `Secure`-cookies.
- **Avklar kartfliser ved stor trafikk.** Kartverkets åpne flistjeneste (`cache.kartverket.no`)
  er gratis, men gis uten garanti for oppetid, og Kartverket kan begrense svært tung bruk.
  Ved bytte av flisleverandør må adressen også inn i `img-src` i `CONTENT_SECURITY_POLICY`
  i `server.py`.

## Teknisk

- Backend: standardbibliotek i Python (`http.server`, `sqlite3`) med JSON API
- Frontend: HTML, CSS og JavaScript
- Kart: Leaflet med Kartverkets topografiske kart (© Kartverket, CC BY 4.0)
- Holdeplasser og linjer: inneholder data under norsk lisens for offentlige data (NLOD)
  tilgjengeliggjort av Entur

## Lokasjon

Trykk «Bruk min posisjon» og gi nettleseren tilgang til posisjonen din.
Den blå markøren viser hvor du er, og sirkelen viser anslått nøyaktighet.
Knappen flytter også rapportposisjonen til deg. Et klikk i kartet, flytting av
rapportmarkøren eller «Bruk kartets midtpunkt» lar deg velge et annet sted uten at GPS
overskriver valget. Med tastatur flyttes kartet med piltastene.

Lokasjon krever HTTPS, med unntak for `localhost` og `127.0.0.1` på samme enhet.
Åpner du nettsiden på mobil via en vanlig HTTP-adresse på lokalnettet, vil
nettleseren blokkere lokasjon. Bruk en HTTPS-adresse for testing fra andre enheter.
Sjekk også stedstillatelser både i nettleseren og på enheten.

## Kontroll av endringer

```bash
python3 -m unittest discover -s tests
node --test tests/*.test.mjs
```

## Mobilapp (satt på vent)

Det genererte iOS-bygget i `build/` er lokalt og følger ikke med repositoryet.
Nettsiden kjøres med `python3 server.py`.
