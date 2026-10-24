import { createHmac, timingSafeEqual } from "node:crypto";
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

// Resource route: a normal fetch() receives this action's JSON Response directly.
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
