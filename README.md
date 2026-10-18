# BeeWare

Et lite MVP-prosjekt for å melde fra om busskontrollører i nærheten.

## Hva appen gjør

- Viser et kart med nylige observasjoner.
- Lar brukeren trykke i kartet eller bruke egen posisjon for å registrere en observasjon.
- Viser egen posisjon som egen blå markør i kartet.
- Dekker fastlands-Norge med Kartverkets topografiske kart og Enturs nasjonale holdeplass- og linjedata.
- Henter nærmeste holdeplass innen 2 km, målt til nærmeste plattform.
- Søker holdeplasser med eksakte navn først og deretter de nærmeste treffene.
- Søker linjer med nummer, navn og operatør (for eksempel «31 Ruter»), med linjene som stopper nær
  rapportposisjonen først. Observasjonen får nummer og operatør («31 · Ruter»), eller hele
  linjenavnet når operatøren har flere linjer med samme nummer.
- Viser alle treff i en egen forslagsliste som kan brukes med piltaster, Enter og Escape. Gir
  holdeplassøket treff, må ett av dem velges før publisering; uten treff lagres navnet slik det er
  skrevet, på rapportposisjonen.
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

Dataene følger ikke med repositoryet. Dette henter Enturs nasjonale GTFS-datasett (omtrent 95 MB)
og skriver filene appen bruker til `data/`:

```bash
python3 update_data.py
```

Skriptet tar vare på holdeplasser, linjer og operatører, og bygger `stop_routes.txt` over hvilke
linjer som stopper hvor ut fra alle turene i rutetabellene (omtrent 10 sekunder). De gamle filene
blir liggende til de nye er ferdige. Start serveren på nytt etterpå. Entur oppdaterer datasettet
hver natt, så skriptet kan kjøres som en nattlig jobb, men ikke oftere enn én gang i døgnet.
Uten filene fungerer kart og rapportering fortsatt, men holdeplass- og linjesøk gir ingen
treff. Sted og linje kan da skrives inn manuelt.

Entur har én stasjon per transportmiddel med plattformer under. Jernbanetorget i Oslo er for
eksempel ni stasjoner for buss, trikk og T-bane. Søket viser hver stasjon. Har flere samme navn,
skilles de med transportmiddel, beskrivelse og avstand, som «Jernbanetorget (trikk, foran Oslo S,
157 m)». Avstanden og posisjonen et søkevalg gir, er til stasjonens plattform nærmest kartets
midtpunkt. Avstander regnes på WGS84-ellipsoiden, samme datum som GPS og Entur, og er nøyaktige
på centimeteren innen 2 km.

Linjesøket viser først linjer med et linjenummer som begynner med det som er skrevet. Innenfor dem
kommer linjene som stopper innen 500 m fra rapportposisjonen (eller kartets midtpunkt før et sted er
valgt), så linjene innen 30 km og til slutt resten av landet. «3» ved Gløshaugen gir dermed AtBs
linje 3, og ved Jernbanetorget Ruters T-banelinje 3.

Kartverkets topografiske kart går til 71,5° N og dekker dermed ikke Svalbard eller Jan Mayen.
Entur-dataene har heller ingen holdeplasser der.

## Lagring

Alt lagres i SQLite-databasen `storage/beeware.db`: brukere med XP og antall likes, sesjoner,
observasjoner og likes. Observasjoner vises i 3 timer, mens XP blir værende. Utløpte observasjoner
slettes når neste observasjon sendes inn, og utløpte sesjoner ved neste innlogging. En like og XP-en
den gir, lagres i samme transaksjon, og det samme gjelder en ny bruker og første innlogging.
`storage/` opprettes automatisk og ignoreres av Git. Ikke del databasen; den inneholder brukerdata.

## Grenser

- Hver IP kan sende 3 observasjoner per 10 minutter, 10 innloggingsforsøk per 5 minutter og 3 registreringer per time.
- JSON-innhold kan være på maks 4 KB, og POST fra andre nettsteder avvises.
- Alle svar med innhold har en Content-Security-Policy som bare slipper inn kartfliser fra Kartverket
  i tillegg til appens egne filer, og siden kan ikke bygges inn i andre nettsteder.
- Nettleseren sjekker om appens filer er endret før den bruker en lagret kopi, så en oppdatering
  når alle med en gang.
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
  er gratis og oppført som åpne data under CC BY 4.0 i Geonorge, uten en publisert kvote. Den gis
  uten garanti for oppetid, så avklar med Kartverket før appen får mye trafikk.
  Ved bytte av flisleverandør må adressen også inn i `img-src` i `CONTENT_SECURITY_POLICY`
  i `server.py`.

## Teknisk

- Backend: standardbibliotek i Python (`http.server`, `sqlite3`) med JSON API
- Frontend: HTML, CSS og JavaScript
- Kart: Leaflet 1.9.4 (BSD-2-Clause, levert fra `web/vendor/`) med Kartverkets topografiske kart
  (© Kartverket, CC BY 4.0)
- Holdeplasser og linjer: inneholder data under norsk lisens for offentlige data (NLOD)
  tilgjengeliggjort av Entur

## Lokasjon

Trykk «Bruk min posisjon» og gi nettleseren tilgang til posisjonen din.
Den blå markøren viser hvor du er, og sirkelen viser anslått nøyaktighet.
Rapportposisjonen og holdeplassen GPS fyller inn følger nye GPS-målinger, og knappen flytter
rapportposisjonen tilbake til deg. Et klikk i kartet, flytting av rapportmarkøren, «Bruk kartets
midtpunkt» eller et valgt holdeplassforslag lar deg velge et annet sted uten at GPS overskriver
valget, og GPS rører heller ikke en holdeplass du skriver inn selv. For en holdeplass GPS fylte
inn, velger serveren nærmeste holdeplass til posisjonen som publiseres, så de alltid hører sammen. Med tastatur flyttes kartet med piltastene.

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
