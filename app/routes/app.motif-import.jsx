import { createHmac, timingSafeEqual } from "node:crypto";
import { useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  headMotifImportObject,
  motifKeyFromPublicUrl,
  r2PublicUrl,
} from "../lib/r2.server";
import {
  applyMotifImportBatch,
  inspectMotifImportBatch,
} from "../lib/motif-import.server";

const SHOP = "3f14b7-2.myshopify.com";
const MAX_BATCH = 10;
const MAX_MANIFEST_ENTRIES = 1_500;
const PREFLIGHT_TTL_MS = 24 * 60 * 60 * 1_000;

const assertShop = (session) => {
  if (session.shop !== SHOP) throw new Response("Falscher Shopify-Shop.", { status: 403 });
};

const storedKey = (motif) =>
  String(motif.r2_key || motifKeyFromPublicUrl(motif.image_url) || "");

const preflightSignature = (shop, entries, issuedAt) => {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Shopify-App-Secret fehlt auf dem Server.");
  return createHmac("sha256", secret)
    .update(JSON.stringify({ shop, entries, issuedAt }), "utf8")
    .digest("hex");
};

const issuePreflightToken = (shop, entries) => {
  const issuedAt = Date.now();
  return `${issuedAt}.${preflightSignature(shop, entries, issuedAt)}`;
};

const assertPreflightToken = (shop, entries, token) => {
  const match = String(token || "").match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match) throw new Error("Vorprüfung fehlt. Bitte alle Motive erneut prüfen.");
  const issuedAt = Number(match[1]);
  if (issuedAt > Date.now() || Date.now() - issuedAt > PREFLIGHT_TTL_MS) {
    throw new Error("Vorprüfung ist abgelaufen. Bitte erneut prüfen.");
  }
  const expected = Buffer.from(preflightSignature(shop, entries, issuedAt), "hex");
  const received = Buffer.from(match[2], "hex");
  if (!timingSafeEqual(expected, received)) {
    throw new Error("Vorprüfung passt nicht zu diesem Batch.");
  }
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  assertShop(session);
  return { shop: session.shop };
};

const getMotifById = async (admin, id) => {
  const response = await admin.graphql(`#graphql
    query BaureliaImportMotifById($id: ID!) {
      metaobject(id: $id) {
        id
        handle
        type
        updatedAt
        fields { key jsonValue }
      }
    }
  `, { variables: { id } });
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
  const node = payload.data?.metaobject;
  if (!node) return null;
  const fields = Object.fromEntries(
    (node.fields || []).map((field) => [field.key, field.jsonValue]),
  );
  return {
    ...fields,
    id: node.id,
    handle: node.handle,
    type: node.type,
    updatedAt: node.updatedAt,
    r2_key: storedKey(fields),
  };
};

const updateMotifById = async (admin, id, values) => {
  const response = await admin.graphql(`#graphql
    mutation BaureliaImportUpdateMotif($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message code }
      }
    }
  `, {
    variables: {
      id,
      metaobject: {
        fields: Object.entries(values).map(([key, value]) => ({ key, value })),
      },
    },
  });
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  const result = payload.data?.metaobjectUpdate;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join("; "));
  }
  if (result?.metaobject?.id !== id) {
    throw new Error(`Shopify hat ein anderes Metaobjekt zurückgegeben: ${id}`);
  }
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  assertShop(session);
  const body = await request.formData();
  const intent = body.get("intent");
  if (intent !== "preflight-batch" && intent !== "apply-batch") {
    return Response.json({ error: "Ungültige Aktion." }, { status: 400 });
  }
  try {
    const raw = String(body.get("entries") || "");
    if (raw.length > 35_000) throw new Error("Batch ist zu groß.");
    const entries = JSON.parse(raw);
    if (intent === "apply-batch") {
      assertPreflightToken(session.shop, entries, body.get("preflight_token"));
    }
    const dependencies = {
      loadMotif: (id) => getMotifById(admin, id),
      headObject: (key) => headMotifImportObject(key),
      publicUrlForKey: r2PublicUrl,
      keyFromPublicUrl: motifKeyFromPublicUrl,
    };
    const inspected = await inspectMotifImportBatch(entries, dependencies);
    if (intent === "preflight-batch") {
      return Response.json({ ok: true, results: inspected.results,
        preflight_token: issuePreflightToken(session.shop, entries) });
    }
    const results = await applyMotifImportBatch(inspected.checked, {
      loadMotif: dependencies.loadMotif,
      updateMotif: (id, values) => updateMotifById(admin, id, values),
      publicUrlForKey: r2PublicUrl,
      keyFromPublicUrl: motifKeyFromPublicUrl,
    });
    return Response.json({ ok: true, results });
  } catch (error) {
    return Response.json({ error: error.message || "Import fehlgeschlagen." }, { status: 400 });
  }
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
    const response = await fetch("/app/motif-import", {
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
      throw new Error("Die App hat keine gültige Antwort geliefert. Bitte die App neu öffnen.");
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
