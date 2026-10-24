# Einmaliger Baurelia-Motivimport

Dieser Ablauf verwendet die lokalen Dateien und die bestehenden R2-/Shopify-Daten.
Die einmalige Importseite der bereits installierten Shopify-App stellt deren
Admin-Sitzung für die Umschaltung bereit; ein lokaler Admin-Token wird nicht
benötigt. Das heruntergeladene
`baurelia-designer-main.zip` diente nur als Abgleich mit dem aktuellen Quellcode und
darf nicht über das Arbeitsverzeichnis entpackt werden. Alte R2-Objekte bleiben als
Rollback-Möglichkeit erhalten; neue Master erhalten versionierte Schlüssel. Der
Shopify-Schritt ändert ausschließlich die drei Bild-Felder bestehender Metaobjekte,
nicht deren ID, Handle, Kategorie, Reihenfolge oder Aktiv-Status.

## Aktueller Stand (24.10.2026)

- `sources.json`: 1'217 eindeutige Kundendateien/optimierte Motive, alle Quellen
  vorhanden und per SHA-256 verifiziert. 74 sind für Qualitätsprüfung markiert.
- `catalog-20261024T161545Z.json`: 2'354 aktive, verifizierte Motive in 87
  Kategorien aus dem bestehenden öffentlichen Baurelia-App-Proxy. Es wurden keine
  Shopify-Metaobjekte geändert.
- `plan.json`: 1'005 eindeutige Zuordnungen (925 über bisherigen R2-Schlüssel,
  80 über Kategorie und Namen). Davon sind 948 ohne Qualitätswarnung für diesen
  Import ausgewählt. 212 Dateien ohne sicheren Shopify-Treffer und 57 zugeordnete
  Qualitätsfälle bleiben ausgeschlossen. Die insgesamt 74 Qualitätsfälle dürfen
  nicht stillschweigend mitimportiert werden.
- `unresolved-212-manual-review.csv`: lesbare Prüfung der 212 offenen Fälle.
  Bei 190 davon wäre ein nur ähnlich benannter Shopify-Kandidat bereits einem
  anderen Motiv zugeordnet. Diese Ziele keinesfalls mehrfach verwenden; 13
  weitere Kandidaten sind lediglich namensähnlich, neun haben keinen Kandidaten.
- `preflight-all.json`: Offline-Bildprüfung für 948/948 ausgewählte Motive
  bestanden, 0 Fehler. Die Druck-PNGs bleiben bytegleich, auch die 47 Dateien
  mit mehr als 2'000 Pixeln Kantenlänge. Thumbnail und Preview werden separat
  als WebP erzeugt. Es wurde noch **nichts hochgeladen**.

Die Dateien liegen unter `../r2-speicher-vergleich/outputs/motif-import/`, bezogen
auf das Verzeichnis `baurelia-designer`.

## Lokale Vorbereitung bei einer Änderung der Quellen

Im Ordner `r2-speicher-vergleich`:

```powershell
py -3 -m pip install -r requirements.txt
py -3 prepare_motif_import.py
```

Danach im Ordner `baurelia-designer` den Katalog über den **bereits vorhandenen**
Shop-App-Proxy exportieren und neu zuordnen:

```powershell
node scripts/motif-import/export-catalog.mjs
node scripts/motif-import/plan.mjs "C:\Pfad\zum\neuen\catalog-YYYYMMDDTHHMMSSZ.json"
node scripts/motif-import/stage.mjs --limit 10
node scripts/motif-import/stage.mjs --all
```

`export-catalog.mjs` liest nur aktive, verifizierte Motive in aktiven Kategorien.
Fehlende und mehrdeutige Treffer stehen in `plan.json` unter `unresolved`; hier
wird **nicht** per Ähnlichkeit geraten. Ein abweichender Plan oder eine geänderte
Datei macht die vorhandene Offline-Vorprüfung ungültig. Vor einem Upload muss
`stage.mjs --all` dann erneut erfolgreich durchlaufen.

## R2-Upload und Shopify-Umschaltung

Zuerst die Änderungen im App-Projekt nach GitHub pushen und abwarten, bis die
bereits bestehende App mit der neuen Seite **Motivmigration** läuft. Es ist
kein manueller Railway-Zugriff und kein zusätzlicher Shopify-Token nötig.
Keinen Schlüssel, Token oder Manifest-Inhalt in Git speichern.

Für den Testlauf im Ordner `baurelia-designer`:

```powershell
node scripts/motif-import/stage.mjs --limit 10 --upload
```

Der erste Befehl lädt 10 Master/Thumbnail/Preview-Dateien unter neue Schlüssel
hoch, ohne die alten zu überschreiben. Er prüft die Objekte über `HEAD`, Größe,
Content-Type und SHA-256-Metadaten. Danach im Shopify-Admin die installierte
Baurelia-App öffnen, **Motivmigration** wählen und die lokale Datei
`../r2-speicher-vergleich/outputs/motif-import/manifest-10.json` laden. Zuerst
die vollständige Vorprüfung ausführen, dann die separate Umschaltung bestätigen.
Anschließend diese 10 Motive in App-Vorschau und Druckansicht visuell prüfen.
Die Seite erzeugt keine Bilder neu: sie prüft die bereits hochgeladenen drei
Objekte und ändert nur `r2_key`, `image_url` und `thumbnail_url` der bestehenden
Shopify-Metaobjekte anhand ihrer IDs. Bei einem Fehler stoppt der Import;
ein erneuter Start erkennt bereits korrekt umgeschaltete Motive.

Erst nach erfolgreicher Stichprobe der Gesamtlauf:

```powershell
node scripts/motif-import/stage.mjs --all --upload
```

Wiederholung des R2-Schritts überschreibt keine vorhandenen Objekte mit anderem
Inhalt (`If-None-Match: *` und anschließende Prüfung). Vor jedem Upload werden
alle Quell-Hashes erneut geprüft. Anschließend `manifest.json` in derselben
Shopify-Importseite laden, komplett vorprüfen und explizit umschalten. Die
Prüfung wird vor jedem schreibenden Batch wiederholt. Nach Abschluss einige
Motive je Kategorie und die Druck-PDFs kontrollieren.

Die 74 Qualitätsfälle und 212 ungeklärten Zuordnungen bleiben eine separate
manuelle Aufgabe. Bloßes Hochrechnen repariert keine bereits verlorenen Details
oder fehlerhafte Transparenz.
