import { authenticate } from "../shopify.server";
import {
  deleteMetaobject,
  listAllMetaobjects,
  upsertMetaobject,
} from "../lib/customizer-data.server";
import {
  deleteMotifObject,
  motifKeyFromPublicUrl,
} from "../lib/r2.server";

const motifValues = (motif, sortOrder = motif.sort_order) => ({
  name: motif.name || motif.displayName,
  slug: motif.slug,
  category: motif.category,
  category_handle: motif.category_handle,
  image_url: motif.image_url,
  thumbnail_url: motif.thumbnail_url,
  r2_key: motif.r2_key,
  original_filename: motif.original_filename,
  alt_text: motif.alt_text,
  sort_order: sortOrder,
  active: motif.active !== false,
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

    if (intent === "reorder") {
      const categoryHandle = String(
        formData.get("categoryHandle") || "",
      ).trim();
      let orderedHandles;
      try {
        orderedHandles = JSON.parse(
          String(formData.get("orderedHandles") || "[]"),
        );
      } catch {
        throw new Error("Die übertragene Reihenfolge ist ungültig.");
      }
      if (
        !categoryHandle ||
        !Array.isArray(orderedHandles) ||
        orderedHandles.length < 2 ||
        new Set(orderedHandles).size !== orderedHandles.length ||
        orderedHandles.some((item) => typeof item !== "string")
      ) {
        throw new Error("Die Sortieraktion ist ungültig.");
      }

      const motifs = (
        await listAllMetaobjects(
          admin,
          "motifs",
          `fields.category_handle:${categoryHandle}`,
        )
      ).sort(byStoredOrder);
      const motifsByHandle = new Map(
        motifs.map((motif) => [motif.handle, motif]),
      );
      if (orderedHandles.some((item) => !motifsByHandle.has(item))) {
        throw new Error("Mindestens ein Motiv gehört nicht zu dieser Kategorie.");
      }

      const reordered = [...motifs];
      const submittedHandles = new Set(orderedHandles);
      const submittedSlots = motifs
        .map((motif, index) => (submittedHandles.has(motif.handle) ? index : -1))
        .filter((index) => index >= 0);
      if (submittedSlots.length !== orderedHandles.length) {
        throw new Error("Die Motivliste hat sich geändert. Bitte lade sie neu.");
      }
      submittedSlots.forEach((slot, index) => {
        reordered[slot] = motifsByHandle.get(orderedHandles[index]);
      });

      await Promise.all(
        reordered.map((motif, index) => {
          const nextOrder = index + 1;
          if (Number(motif.sort_order) === nextOrder) return null;
          return upsertMetaobject(
            admin,
            "motifs",
            motif.handle,
            motifValues(motif, nextOrder),
          );
        }),
      );

      return Response.json({ ok: true, intent });
    }

    if (intent === "delete") {
      const handle = String(formData.get("handle") || "").trim();
      const matches = await listAllMetaobjects(
        admin,
        "motifs",
        `handle:${handle}`,
      );
      const motif = matches.find((item) => item.handle === handle);
      if (!motif) throw new Error("Das Motiv wurde nicht gefunden.");

      await deleteMetaobject(admin, motif.id);

      let warning = "";
      if (formData.get("deleteFile") === "true") {
        const r2Key = motif.r2_key || motifKeyFromPublicUrl(motif.image_url);
        if (!r2Key) {
          warning = "Der Shopify-Eintrag wurde gelöscht, aber für die R2-Datei ist kein Schlüssel gespeichert.";
        } else {
          try {
            await deleteMotifObject(r2Key);
          } catch {
            warning = "Der Shopify-Eintrag wurde gelöscht, die R2-Datei konnte jedoch nicht entfernt werden.";
          }
        }
      }

      return Response.json({ ok: true, intent, warning });
    }

    return Response.json({ error: "Ungültige Motiv-Aktion." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "Die Aktion ist fehlgeschlagen." },
      { status: 400 },
    );
  }
};
