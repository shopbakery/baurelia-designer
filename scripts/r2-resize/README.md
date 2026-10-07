# R2-Motive unter `motifs-v2/` vorbereiten

Dieses Skript liest die Bilder im aktiven R2-Bucket Ordner für Ordner. Es legt **neue** Objekte unter `motifs-v2/<kategorie>/...` an:

- Bilder mit mehr als 2'000 Pixeln an der längsten Seite werden proportional verkleinert.
- Kleinere Bilder werden unverändert kopiert. So entsteht ein vollständiger neuer Bildbaum.
- PNG-Transparenz bleibt erhalten; es wird kein Hintergrund hinzugefügt. PNG, JPEG und WebP bleiben im jeweiligen Format.
- Bei falsch benannter Quelldatei (z. B. `.jpg` mit PNG-Inhalt) bleibt der Dateiname im neuen Schlüssel erhalten, aber der echte Bildtyp wird erkannt und als korrekter `Content-Type` gespeichert. Solche Fälle stehen im Bericht mit `extension_mismatch: true`.
- Andere Dateitypen werden ausgelassen. Dateien über `MAX_SOURCE_MIB` werden mit Fehler im Bericht markiert, nicht hochgeladen.
- Originalobjekte werden nie gelöscht oder überschrieben. Bereits vorhandene Zielobjekte werden übersprungen.
- Das Resize-Skript ändert keine Shopify-Metaobjekte. Erst die separate App-Code-Umstellung kann neue URLs ausliefern.

R2 kennt technisch keine echten Ordner; die Struktur entsteht über die Objektschlüssel. Beispiele:

| Quelle | Neues Ziel |
| --- | --- |
| `Zahnfee/Zahnfee 9.png` | `motifs-v2/zahnfee/Zahnfee 9.png` |
| `motifs/affe/uuid-affe.png` | `motifs-v2/affe/uuid-affe.png` |

Falls zwei Quellen auf denselben Zielpfad abgebildet würden, stoppt das Skript **vor dem ersten Upload**. Alle Ergebnisse, einschließlich Quell-/Ziel-URL und Fehler, werden in `reports/*.jsonl` protokolliert.

## Einrichtung in PowerShell

Im Ordner `baurelia-designer`:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\scripts\r2-resize\requirements.txt
```

Dann `scripts/r2-resize/.env` öffnen und diese Werte ergänzen:

| Variable | Wert aus Cloudflare |
| --- | --- |
| `R2_ACCESS_KEY_ID` | **Zugriffsschlüssel-ID** |
| `R2_SECRET_ACCESS_KEY` | **Geheimer Zugriffsschlüssel** |
| `R2_ACCOUNT_ID` | Konto-ID im S3-Endpunkt `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_BUCKET_NAME` | Name des aktuellen Buckets (`baurelia-motive` ist vorbelegt) |
| `R2_PUBLIC_URL` | Öffentliche Domain (`https://media.baurelia.ch` ist vorbelegt) |

Den separaten **Token-Wert** nicht eintragen; boto3 verwendet die Zugriffsschlüssel-ID und den geheimen Zugriffsschlüssel. Die `.env` wird von Git ignoriert. Schlüssel nicht in Chats oder Screenshots zeigen.

## Erst Zahnfee testen

In der vorbereiteten `.env` ist `R2_SOURCE_PREFIX=Zahnfee/` bereits gesetzt. Nach dem Eintragen der Zugangsdaten:

```powershell
.\.venv\Scripts\python.exe .\scripts\r2-resize\r2_resize.py
```

Das ist ein **Dry-Run**: R2 wird nur gelesen. Bericht und Zielpfade prüfen. Erst danach gezielt schreiben:

```powershell
.\.venv\Scripts\python.exe .\scripts\r2-resize\r2_resize.py --apply
```

Für den gesamten Bucket `R2_SOURCE_PREFIX=` wieder leer setzen und zunächst erneut den Dry-Run ausführen. `--limit 20` begrenzt einen Testlauf auf 20 Bilder. Der Bucket-Token braucht Objekt-Lese-/Schreibzugriff und die Möglichkeit, Objekte aufzulisten.

## App-Umstellung nach abgeschlossener Migration

Der erfolgreiche Apply-Bericht ist die Quelle für `app/data/motif-v2-map.js`. Nach einem neuen Migrationslauf die Zuordnung neu erzeugen:

```powershell
node .\scripts\r2-resize\build-motif-v2-map.mjs .\scripts\r2-resize\reports\r2-resize-20261006-215757-apply.jsonl
node .\scripts\r2-resize\check-catalog-coverage.mjs --verify-targets
```

Die App liefert für migrierte Motive die verifizierten `motifs-v2/`-URLs aus und legt neue Uploads dort ab. Die gespeicherten Shopify-Metaobjekte bleiben unverändert; die alten R2-Dateien dienen als Backup. Beim Löschen eines migrierten Motivs löscht die App die aktive v2-Datei samt Thumbnail und Vorschau, sofern kein anderes Motiv sie verwendet. Ein alter direkter Upload ohne verifizierte v2-Kopie wird im öffentlichen Motivkatalog ausgeblendet, bleibt aber im Admin sichtbar.

Vor dem App-Deploy die Coverage-Prüfung ausführen und fehlende Dateien beheben. Stand 7. Oktober 2026: 1'583 aktive Motive sind zugeordnet und ihre v2-URLs per HEAD, Bildtyp und Shop-CORS geprüft (0 Fehler). Ein weiterer aktiver Auto-Eintrag (`motifs/auto/48499cee-2297-4f2b-ad5e-c2482a6d585b-white-noise-modell-bg.webp`) ist nicht migriert und liefert bereits unter seiner alten URL HTTP 404. Die neue App blendet ihn für Kund:innen aus; im Admin sollte er repariert, ersetzt oder deaktiviert werden. Deshalb meldet die Coverage-Prüfung vor dem Deploy noch einen fehlenden Eintrag.

Nach dem Deploy erneut prüfen: Alle öffentlich angebotenen Motive sollen dann `motifs-v2/` verwenden. Ein Rollback des App-Codes kann die alten, unveränderten Metaobjekt-URLs wieder verwenden. Neue v2-Uploads brauchen bei einem Rollback eine gesonderte Behandlung.

Der lokal angepasste App-Uploader prüft neue Bilddateien nach dem R2-Upload, verkleinert Druckbilder über 2'000 px und erzeugt Thumbnail und Vorschau, bevor er den Shopify-Eintrag veröffentlicht. Das gilt erst nach Deployment der App-Änderungen.

## Kleine WebP-Dateien für Kacheln und Vorschau

`r2_variants.py` liest **nur** die Druckbilder unter `motifs-v2/` und erzeugt zwei zusätzliche, proportionale WebP-Versionen ohne Zuschnitt oder Hintergrund:

| Zweck | Maximale Kantenlänge | R2-Präfix |
| --- | ---: | --- |
| Kachel | 300 px | `motifs-v2-thumbs/` |
| Produktvorschau | 900 px | `motifs-v2-previews/` |

Beispiel: Aus `motifs-v2/zahnfee/Zahnfee 9.png` werden `motifs-v2-thumbs/zahnfee/Zahnfee 9.png.webp` und `motifs-v2-previews/zahnfee/Zahnfee 9.png.webp`. Die zusätzliche `.webp`-Endung verhindert Kollisionen zwischen gleichnamigen PNG- und JPG-Quellen. Die 2'000-px-Druckbilder bleiben exakt unverändert. Das Skript verwendet dieselbe `.env` und erwartet darin `R2_DEST_PREFIX=motifs-v2/`. Es ändert keine Shopify-Einträge.

Im Ordner `scripts\r2-resize` mit derselben Python-Umgebung wie beim ersten Resize:

```powershell
.\.venv\Scripts\python.exe .\r2_variants.py --category zahnfee
.\.venv\Scripts\python.exe .\r2_variants.py --category zahnfee --apply
.\.venv\Scripts\python.exe .\r2_variants.py --apply
```

Ohne `--apply` werden nur Quellen und bereits vorhandene Ziele aufgelistet; **kein Upload** findet statt. Zum kurzen Test geht auch `--limit 3`. Ein JSONL-Bericht landet unter `reports/` und bleibt aus Git ausgeschlossen. Ein erneuter Apply-Lauf ergänzt fehlende Ziele, überschreibt aber nie bestehende Dateien. Bereits vorhandene Ziele mit falschem Content-Type oder leerem Inhalt führen zu einem Fehler statt zu einer stillen Überschreibung. Bei Problemen den Bericht prüfen; anschließend kann man den Lauf erneut starten.

Die App und das Theme sind lokal auf die Varianten umgestellt. Diese Änderungen sind noch nicht deployed. Vor dem Live-Einsatz die App veröffentlichen, den Proxy-Katalog und einen neuen Upload prüfen und anschließend die beiden geänderten Theme-Assets in einem Preview-Theme testen. Für PDF und Bestellung wird weiter das Druckbild verwendet.

### Geprüfter Zahnfee-Pilot (7. Oktober 2026)

Der Dry-Run fand 16 Druckbilder. Der anschließende Apply-Lauf erzeugte 32 Varianten unter den beiden separaten Präfixen, ohne Fehler; die 2'000-px-Druckbilder blieben unverändert. Der Wiederanlauf meldete 32-mal `exists` und legte nichts erneut an. Für alle 32 öffentlichen URLs wurden HTTP 200, `image/webp` und der passende CORS-Header sowohl für `https://www.baurelia.ch` als auch für die getestete Shopify-Preview-Origin geprüft. Die transparente Testquelle behielt ihren Alpha-Kanal. Der vollständige Dry-Run über alle Kategorien fand 1'591 Druckbilder und keine Zielkonflikte.

Der Gesamtlauf wurde anschließend ausgeführt: 1'591 Druckbilder, 3'150 neu erzeugte Varianten, 32 bereits vorhandene Varianten, 0 Fehler. Für einen Wiederanlauf im Ordner `scripts\r2-resize`:

```powershell
.\.venv\Scripts\python.exe .\r2_variants.py --apply
```

Der Befehl überspringt vorhandene Varianten. Stichproben über 14 Kategorien (56 HEAD-Prüfungen für Live-Shop und Shopify-Preview) lieferten HTTP 200, WebP und passende CORS-Header. Das Erzeugen der Dateien allein beschleunigt den Shop noch nicht: Erst nach App- und Theme-Deployment verwenden Kund:innen die neuen URLs. Das Theme liegt separat unter `theme-reliable-preview/` und wird nicht durch einen Push des App-Repositories mitveröffentlicht.
