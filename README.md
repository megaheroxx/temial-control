# Temial Control

Eigene Steuerzentrale für die **Vorwerk Temial**. Vorwerk hat die Cloud im Juli 2025 abgeschaltet. Diese App ersetzt sie lokal und baut dafür auf dem Protokoll auf, das das [Freemial-Projekt](https://freemial.github.io/) herausgefunden hat.

Die Temial verbindet sich per WebSocket direkt mit dieser App, sie ist also selbst der Freemial-kompatible Server. Dazu kommen:

- **Web-Dashboard**: Live-Status (Deckel, Brühkammer, Frischwasser, Abwassertank, WLAN, Firmware) und Fortschritt des Brühvorgangs
- **Tee brühen**: Name, Temperatur, Ziehzeit, Menge und Vorspülzeit frei wählbar
- **Presets**: gespeichert in `data/presets.json`, mit einigen Standard-Tees vorbelegt
- **REST-API und Server-Sent Events**, um eigene Automationen anzubinden (z. B. Home Assistant)

## Voraussetzungen

- Node.js **22.18 oder neuer**. Die TypeScript-Dateien laufen direkt, ohne Build-Schritt.
- Rechner und Temial im selben Netzwerk

## Starten

```bash
npm install
npm start
```

Beim Start gibt die App die Dashboard-URL und die `baseHost`-Adressen für die Temial aus, z. B. `http://192.168.178.20:3000`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `3000` | Port für Dashboard, API und Geräte-WebSocket |
| `HOST` | `0.0.0.0` | Netzwerk-Interface. Muss für die Temial erreichbar sein. |
| `DATA_DIR` | `./data` | Speicherort der Presets |
| `APP_TOKEN` | – | Wenn gesetzt, verlangt `/api/*` diesen Token (Dashboard fragt einmal danach) |
| `BASE_HOST` | – | Adresse, die beim Start als `baseHost` angezeigt wird (sinnvoll in Docker) |

## Docker

```bash
docker compose up -d --build
```

Oder ohne Compose:

```bash
docker build -t temial-control .
docker run -d --name temial-control -p 3000:3000 -v temial-data:/data --restart unless-stopped temial-control
```

Die Presets liegen im Volume `/data`. Als `baseHost` für die Temial gibst du die **IP des Docker-Hosts** an, nicht die Container-IP, z. B. `http://192.168.178.20:3000`.

## Temial mit der App verbinden

Einmalig, mit der offiziellen [Freemial-CLI](https://www.npmjs.com/package/@freemial/cli):

1. Temial einschalten, oben auf die graue Leiste tippen, **„Verbinden“** wählen.
2. Den angezeigten QR-Code auslesen, z. B. per Foto auf dem Handy, und den Text kopieren.
3. Mit dem WLAN `Temial-xxxxx` verbinden (xxxxx = letzte 5 Stellen der Seriennummer).
4. CLI ausführen. Als `baseHost` die Adresse angeben, die `npm start` ausgegeben hat:

   ```bash
   npx -y @freemial/cli "<QR-Inhalt>" --ssid DeinWLAN --key DeinPasswort --baseHost http://192.168.178.20:3000
   ```

   Für versteckte WLANs gibt es `--force --securityType WPA2`. Alle Optionen zeigt `npx -y @freemial/cli --help`.
5. Zurück ins normale WLAN wechseln. Die Temial meldet sich kurz darauf im Dashboard.

## API

Alle Routen liegen unter `/api`. Ist `APP_TOKEN` gesetzt, braucht jede Anfrage den Header `Authorization: Bearer <token>` oder für den Event-Stream `?token=<token>`.

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/devices` | Alle bekannten Geräte mit letztem Status |
| `POST` | `/api/devices/:serial/brew` | Brühen. Body: `{ name, temperature, duration, volume, preWashTime }` |
| `GET` | `/api/presets` | Presets auflisten |
| `POST` | `/api/presets` | Preset anlegen (gleicher Body wie beim Brühen) |
| `DELETE` | `/api/presets/:id` | Preset löschen |
| `GET` | `/api/config` | Erlaubte Wertebereiche |
| `GET` | `/api/events` | Server-Sent Events: `snapshot`, `device`, `log` |

Beispiel:

```bash
curl -X POST http://localhost:3000/api/devices/123456789/brew \
  -H "Content-Type: application/json" \
  -d '{"name":"Sencha","temperature":80,"duration":120,"volume":300,"preWashTime":0}'
```

## Sicherheit

- **Nicht ins Internet stellen.** Der Geräte-WebSocket hat keine Authentifizierung, so wie beim Original. Die Temial schickt keinen Token mit.
- Im Heimnetz mindestens `APP_TOKEN` setzen, wenn andere im Netz nicht brühen sollen.
- Kein Reverse-Proxy mit HTTP/2 davor: Die Temial liest HTTP-Header case-sensitiv und verbindet sich nicht, wenn sie kleingeschrieben ankommen.

## Bekannte Grenzen

- Was die Zahlenwerte `deviceState`, `activityState` und `phase` bedeuten, ist nicht dokumentiert. Das Dashboard zeigt sie roh an.
- Einen Befehl zum Abbrechen, Reinigen oder Entkalken gibt es im Freemial-Protokoll bisher nicht.
- Die Wertebereiche in [src/validation.ts](src/validation.ts) sind vorsichtig gewählt. Die echten Grenzen des Geräts sind unbekannt.
- Der Gerätestatus liegt nur im Speicher und ist nach einem Neustart leer, bis sich die Temial wieder meldet.

## Entwicklung

```bash
npm run dev        # Neustart bei Dateiänderungen
npm test           # Tests mit simulierter Temial
npm run typecheck
```

| Datei | Inhalt |
|---|---|
| [src/protocol.ts](src/protocol.ts) | Nachrichtenformat der Temial (nach der Freemial-Referenz) |
| [src/device-hub.ts](src/device-hub.ts) | WebSocket-Server für Geräte, Zustand, Ereignislog |
| [src/app.ts](src/app.ts) | HTTP-Server, REST-API, SSE, Auslieferung des Dashboards |
| [src/presets.ts](src/presets.ts) | Preset-Speicher |
| [public/](public/) | Dashboard (HTML/CSS/JS ohne Framework) |

## Lizenz

AGPL-3.0-or-later, wie das Freemial-Projekt, dessen Protokoll-Referenz hier übernommen wurde.
