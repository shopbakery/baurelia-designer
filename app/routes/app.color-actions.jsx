import { authenticate } from "../shopify.server";
import {
  listAllMetaobjects,
  upsertMetaobject,
} from "../lib/customizer-data.server";

const COLOR_USAGES = new Set(["text", "decoration", "both"]);

const colorValues = (color, overrides = {}) => ({
  name: color.name || color.displayName,
  slug: color.slug,
  hex_value: color.hex_value,
  usage: color.usage || "both",
  sort_order: Number(color.sort_order) || 0,
  active: color.active !== false,
  ...overrides,
});

const byStoredOrder = (left, right) =>
  Number(left.sort_order || 0) - Number(right.sort_order || 0) ||
  String(left.name || left.displayName).localeCompare(
    String(right.name || right.displayName),
    "de",
  );

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const colors = (await listAllMetaobjects(admin, "colors")).sort(
      byStoredOrder,
    );
    const colorsByHandle = new Map(
      colors.map((color) => [color.handle, color]),
    );

    if (intent === "update") {
      const handle = String(formData.get("handle") || "").trim();
      const usage = String(formData.get("usage") || "").trim();
      const color = colorsByHandle.get(handle);
      if (!color) throw new Error("Die Farbe wurde nicht gefunden.");
      if (!COLOR_USAGES.has(usage)) {
        throw new Error("Die ausgewählte Farbverwendung ist ungültig.");
      }
      const item = await upsertMetaobject(
        admin,
        "colors",
        handle,
        colorValues(color, { usage }),
      );
      return Response.json({ ok: true, intent, item });
    }

    if (intent === "reorder") {
      let orderedHandles;
      try {
        orderedHandles = JSON.parse(
          String(formData.get("orderedHandles") || "[]"),
        );
      } catch {
        throw new Error("Die übertragene Reihenfolge ist ungültig.");
      }
      if (
        !Array.isArray(orderedHandles) ||
        orderedHandles.length !== colors.length ||
        new Set(orderedHandles).size !== colors.length ||
        orderedHandles.some(
          (handle) => typeof handle !== "string" || !colorsByHandle.has(handle),
        )
      ) {
        throw new Error("Die Farbliste hat sich geändert. Bitte lade sie neu.");
      }

      await Promise.all(
        orderedHandles.map((handle, index) => {
          const color = colorsByHandle.get(handle);
          const nextOrder = index + 1;
          if (Number(color.sort_order) === nextOrder) return null;
          return upsertMetaobject(
            admin,
            "colors",
            handle,
            colorValues(color, { sort_order: nextOrder }),
          );
        }),
      );
      return Response.json({ ok: true, intent });
    }

    return Response.json(
      { error: "Ungültige Farbaktion." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Die Farbaktion ist fehlgeschlagen.",
      },
      { status: 400 },
    );
  }
};
