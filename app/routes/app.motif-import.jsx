import { useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const SHOP = "3f14b7-2.myshopify.com";
const MAX_BATCH = 10;
const MAX_MANIFEST_ENTRIES = 1_500;

const assertShop = (session) => {
  if (session.shop !== SHOP) throw new Response("Falscher Shopify-Shop.", { status: 403 });
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  assertShop(session);
  return { shop: session.shop };
};

export default function MotifImport() {
  const shopify = useAppBridge();
  const runLock = useRef(false);
  const [manifest, setManifest] = useState(null);
  const [running, setRunning] = useState(false);
  const [preflight, setPreflight] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");

  const loadManifest = async (event) => {
    if (running) return;
    setManifest(null);
    setPreflight(null);
    setConfirmed(false);
    setMessage("");
    const file = event.target.files?.[0];
    if (!file || file.size > 5_000_000) return setMessage("Manifest fehlt oder ist zu groß.");
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.schema !== 1 || parsed.shop !== SHOP || !Array.isArray(parsed.entries) ||
          parsed.entries.length < 1 || parsed.entries.length > MAX_MANIFEST_ENTRIES) {
        throw new Error("Manifest gehört nicht zum Baurelia-Shop.");
      }
      if (parsed.entries.some((entry) => entry.needs_review)) {
        throw new Error("Manifest enthält ungeprüfte Motive.");
      }
      if (new Set(parsed.entries.map((entry) => entry.id)).size !== parsed.entries.length ||
          new Set(parsed.entries.map((entry) => entry.new_key)).size !== parsed.entries.length) {
        throw new Error("Manifest enthält doppelte Motive oder Bildschlüssel.");
      }
      setManifest(parsed);
      const excluded = parsed.excluded || {};
      setMessage(`${parsed.entries.length} Motive im Manifest; ausgeschlossen: ${excluded.unresolved || 0} ungeklärt, ` +
        `${excluded.quality_review || 0} Qualitätsprüfung, ${excluded.not_selected || 0} nicht ausgewählt. ` +
        `Auswahl: ${parsed.selection || "unbekannt"}. Noch keine Änderung: zuerst die vollständige Vorprüfung starten.` +
        (parsed.entries.length > MAX_BATCH ? " Bitte zuerst den 10-Motiv-Pilot separat abschließen." : ""));
    } catch (error) {
      setMessage(error.message);
    }
  };

  const postBatch = async (intent, entries, preflightToken = "") => {
    const form = new FormData();
    form.set("intent", intent);
    form.set("entries", JSON.stringify(entries));
    if (preflightToken) form.set("preflight_token", preflightToken);
    const token = await shopify.idToken();
    const response = await fetch("/app/motif-import-action", {
      method: "POST",
      body: form,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (!(response.headers.get("content-type") || "").includes("application/json")) {
      throw new Error(`Die App hat keine JSON-Antwort geliefert (HTTP ${response.status}` +
        `${response.redirected ? ", Weiterleitung" : ""}). Bitte die App neu öffnen.`);
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Import fehlgeschlagen.");
    if (!Array.isArray(result.results) || result.results.length !== entries.length) {
      throw new Error("Die Antwort der App ist unvollständig.");
    }
    return result;
  };

  const runPreflight = async () => {
    if (!manifest || running || runLock.current) return;
    runLock.current = true;
    setRunning(true);
    setPreflight(null);
    setConfirmed(false);
    let checked = 0;
    const tokens = [];
    try {
      for (let offset = 0; offset < manifest.entries.length; offset += MAX_BATCH) {
        const entries = manifest.entries.slice(offset, offset + MAX_BATCH);
        const result = await postBatch("preflight-batch", entries);
        if (typeof result.preflight_token !== "string" || !result.preflight_token) {
          throw new Error("Vorprüfungsnachweis fehlt.");
        }
        tokens.push(result.preflight_token);
        checked += result.results.length;
        setMessage(`Vorprüfung: ${checked} von ${manifest.entries.length} Motiven geprüft. Keine Shopify-Änderung.`);
      }
      setPreflight({ manifest, tokens });
      setMessage(`Vorprüfung bestanden: ${checked} Motive und jeweils drei R2-Dateien geprüft. ` +
        "Erst nach ausdrücklicher Bestätigung werden Shopify-Metaobjekte umgestellt.");
    } catch (error) {
      setMessage(`Vorprüfung bei Motiv ${checked + 1} gestoppt: ${error.message} ` +
        "Es wurde nichts in Shopify geändert.");
    } finally {
      runLock.current = false;
      setRunning(false);
    }
  };

  const apply = async () => {
    if (!manifest || !preflight || preflight.manifest !== manifest ||
        !confirmed || running || runLock.current) return;
    runLock.current = true;
    setRunning(true);
    let completed = 0;
    try {
      for (let offset = 0; offset < manifest.entries.length; offset += MAX_BATCH) {
        const index = Math.floor(offset / MAX_BATCH);
        const entries = manifest.entries.slice(offset, offset + MAX_BATCH);
        const result = await postBatch("apply-batch", entries, preflight.tokens[index]);
        completed += result.results.length;
        setMessage(`Shopify: ${completed} von ${manifest.entries.length} Motiven abgeglichen und zurückgelesen.`);
      }
      setConfirmed(false);
      setMessage(`Fertig: ${completed} Motive abgeglichen. Bitte die Druck- und App-Vorschau prüfen.`);
    } catch (error) {
      setConfirmed(false);
      setPreflight(null);
      setMessage(`Shopify-Import nach ${completed} vollständig bestätigten Motiven gestoppt: ` +
        `${error.message} Bitte Ursache prüfen und Vorprüfung neu starten; ` +
        "bereits umgestellte Motive werden bei Wiederholung erkannt.");
    } finally {
      runLock.current = false;
      setRunning(false);
    }
  };

  return (
    <div style={{ maxWidth: 760, margin: "2rem auto", padding: "1rem" }}>
      <h1>Motivmigration</h1>
      <p>Das lokal erstellte Importmanifest laden. Zuerst den 10-Motiv-Pilot prüfen
        und umstellen; erst nach Kontrolle der Druck- und App-Vorschau das Gesamtmanifest verwenden.</p>
      <p><input type="file" accept=".json,application/json" disabled={running}
        onChange={loadManifest} /></p>
      {manifest && <p><button type="button" disabled={running}
        onClick={runPreflight}>Alle Motive ohne Änderung vorprüfen</button></p>}
      {preflight?.manifest === manifest && <>
        <p><label><input type="checkbox" checked={confirmed} disabled={running}
          onChange={(event) => setConfirmed(event.target.checked)} /> Ich bestätige, dass
          genau diese {manifest.entries.length} Motive jetzt in Shopify umgestellt werden sollen.</label></p>
        <p><button type="button" disabled={running || !confirmed}
          onClick={apply}>Shopify-Metaobjekte jetzt umstellen</button></p>
      </>}
      <p role="status" aria-live="polite">{message}</p>
    </div>
  );
}
