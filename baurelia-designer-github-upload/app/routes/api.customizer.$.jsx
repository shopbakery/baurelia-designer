import { authenticate } from "../shopify.server";
import {
  getPublicBootstrap,
  getPublicMotifs,
} from "../lib/customizer-data.server";

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });

export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) {
    return json({ error: "App ist in diesem Shop nicht installiert." }, 401);
  }

  const url = new URL(request.url);
  const action = url.pathname.split("/").filter(Boolean).at(-1);

  if (action === "bootstrap") {
    return json(await getPublicBootstrap(admin));
  }

  if (action === "motifs") {
    const category = url.searchParams.get("category")?.trim();
    if (!category || !/^[a-z0-9][a-z0-9-]*$/.test(category)) {
      return json({ error: "Kategorie fehlt oder ist ungültig." }, 400);
    }
    return json(await getPublicMotifs(admin, category));
  }

  return json({ error: "Endpunkt nicht gefunden." }, 404);
};
