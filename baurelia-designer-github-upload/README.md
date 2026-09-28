# Baurelia Designer

Private Shopify-App zur Verwaltung der Customizer-Daten für Baurelia. Motive,
Kategorien, Farben und Schriften werden als Shopify-Metaobjekte verwaltet.
Motivdateien liegen in Cloudflare R2.

## Repository

Nur dieser Ordner gehört in das GitHub-Repository:

`baurelia-app/baurelia-designer/baurelia-designer`

Der übergeordnete Kundenordner enthält Theme-ZIPs und lokale Zugangsdaten und
darf nicht als Repository hochgeladen werden.

Lokale `.env`-Dateien, SQLite-Dateien, Shopify-CLI-Zustand, Build-Ausgaben und
die Tunnel-Konfiguration `shopify.app.live-test.toml` sind über `.gitignore`
ausgeschlossen.

## Lokale Entwicklung

Voraussetzungen:

- Node.js 22
- pnpm 11
- Shopify CLI

```bash
cp .env.example .env
pnpm install
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm run dev
```

Für lokale Entwicklung bleibt die Datenbank-URL:

```env
DATABASE_URL=file:./dev.sqlite
```

## GitHub

Ein privates, leeres GitHub-Repository erstellen und aus diesem Ordner pushen:

```bash
git remote add origin https://github.com/DEIN-BENUTZER/baurelia-designer.git
git add .
git commit -m "Prepare Baurelia Designer for production"
git branch -M main
git push -u origin main
```

Vor `git add .` immer kontrollieren, dass keine echte `.env`-Datei oder
Zugangsdaten in `git status` erscheinen.

## Railway-Deployment

Railway erkennt das `Dockerfile` automatisch. Es müssen keine eigenen Build-
oder Startbefehle im Dashboard eingetragen werden.

1. In Railway ein Projekt erstellen und das private GitHub-Repository als
   Service verbinden.
2. Unter **Settings → Networking** eine öffentliche Domain generieren.
3. Ein Railway-Volume an den App-Service hängen und unter `/data` mounten.
4. Die unten aufgeführten Variablen setzen.
5. Unter **Settings → Healthcheck** den Pfad `/health` eintragen.
6. Deployment erneut auslösen.

Die App nutzt für den einzelnen Kundenshop weiterhin SQLite. Auf Railway muss
die Datenbank deshalb zwingend auf dem persistenten Volume liegen:

```env
DATABASE_URL=file:/data/baurelia.sqlite
```

Mit SQLite darf der Service nur mit **einer Replik** betrieben werden. Für
mehrere Repliken müsste die Session-Datenbank zuerst auf PostgreSQL migriert
werden.

### Railway-Variablen

```env
SHOPIFY_APP_URL=https://DEINE-DOMAIN.up.railway.app
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SCOPES=read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects
DATABASE_URL=file:/data/baurelia.sqlite
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_URL=https://DEINE-R2-DOMAIN
```

`PORT` wird von Railway automatisch gesetzt. Geheimnisse ausschließlich als
Railway-Variablen speichern, niemals in GitHub committen.

## Shopify auf die Railway-Domain umstellen

Nach dem ersten erfolgreichen Railway-Deployment in `shopify.app.toml` beide
Platzhalter ersetzen:

```toml
application_url = "https://DEINE-DOMAIN.up.railway.app"

[auth]
redirect_urls = ["https://DEINE-DOMAIN.up.railway.app/api/auth"]
```

Danach die App-Konfiguration und Metaobjektdefinitionen veröffentlichen:

```bash
pnpm shopify app deploy
```

Die `client_id` in `shopify.app.toml` gehört zur bestehenden App
`baurelia-designer` und darf nicht durch eine neue App-ID ersetzt werden.

## Cloudflare R2

Die CORS-Regeln des R2-Buckets müssen die endgültige Railway-Domain als Origin
für die Browser-Uploads erlauben. Benötigt werden mindestens `PUT` und der
Header `Content-Type`. Die öffentliche R2-Domain bleibt unverändert.

## Produktionsprüfung

Vor dem Livegang prüfen:

- `https://DEINE-DOMAIN.up.railway.app/health` antwortet mit HTTP 200.
- Die App öffnet sich eingebettet im Baurelia-Shopify-Admin.
- Motiv-Upload nach R2 funktioniert.
- Motiv löschen und Drag-and-drop-Sortierung funktionieren.
- Farben und Schriften lassen sich speichern, sortieren und deaktivieren.
- Der Storefront-App-Proxy `/apps/baurelia-designer/bootstrap` liefert Daten.
- Der Customizer funktioniert im unveröffentlichten Theme vollständig.

Erst nach diesen Prüfungen das neue Theme veröffentlichen.
