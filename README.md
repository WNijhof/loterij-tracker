# Loterij Tracker

Houdt loterij-acties, loten, opzegdatums en opbrengsten bij. Eén Node-server zonder dependencies; alle gegevens in één JSON-bestand in het volume `/data`, met elk uur een backup in `/data/backups`.

## Draaien met Docker

```sh
cp .env.example .env      # vul TRACKER_PASSWORD in
docker compose up -d --build
```

De tracker luistert standaard alleen op `127.0.0.1:8080` van de server. Zet er een reverse proxy met HTTPS voor (Nginx Proxy Manager, Traefik, Caddy …), of verander de poort in `docker-compose.yml` naar `"8080:8080"` om hem op je thuisnetwerk te openen. Zet hem niet zonder HTTPS op internet: de gegevens bevatten IBAN's.

## Gegevens overzetten

Open de tracker, log in, ga naar **Backup → Backup terugzetten** en kies een backupbestand van de oude (lokale) versie.

## Backups

```sh
docker compose cp loterij-tracker:/data ./data-kopie   # alles kopiëren naar de host
```

## Bijwerken

Nieuwe versie van de bestanden op de server zetten en opnieuw `docker compose up -d --build`. De gegevens in het volume blijven staan.

## Zonder Docker

`DATA_DIR=./data TRACKER_USER=… TRACKER_PASSWORD=… node server.js` (Node 18+). Je kunt `public/index.html` ook los openen; dan bewaart hij alles in de browser.
