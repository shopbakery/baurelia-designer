import { existsSync } from "node:fs";

const SHOP = "3f14b7-2.myshopify.com";

if (existsSync(".env")) process.loadEnvFile(".env");

const clientId = process.env.SHOPIFY_API_KEY;
const clientSecret = process.env.SHOPIFY_API_SECRET;
if (!clientId || !clientSecret) throw new Error("SHOPIFY_API_KEY oder SHOPIFY_API_SECRET fehlt.");

const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }),
  redirect: "manual",
  signal: AbortSignal.timeout(30_000),
});

const contentType = response.headers.get("content-type") || "";
if (!contentType.includes("application/json")) {
  const redirect = response.headers.get("location");
  const destination = redirect ? new URL(redirect, `https://${SHOP}`) : null;
  const body = await response.text();
  const title = body.match(/<title[^>]*>([^<]{1,160})<\/title>/i)?.[1]?.trim();
  throw new Error(`Shopify-Tokenendpunkt antwortete mit HTTP ${response.status}, ${contentType || "ohne Content-Type"}` +
    (destination ? `; Weiterleitung zu ${destination.host}${destination.pathname}` : "") +
    (title ? `; Seitentitel: ${title}` : "") + ".");
}
const result = await response.json();
if (!response.ok || !result.access_token) {
  const code = typeof result.error === "string" ? result.error : "unbekannt";
  throw new Error(`Shopify-Tokenaustausch gescheitert: HTTP ${response.status}, ${code}.`);
}

console.log(`Shopify-App authentifiziert für ${SHOP}.`);
console.log(`Token-Gültigkeit: ${result.expires_in} Sekunden; Scopes: ${result.scope || "nicht angegeben"}.`);
console.log("Token wurde nicht ausgegeben oder gespeichert.");
