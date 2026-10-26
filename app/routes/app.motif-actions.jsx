import { authenticate } from "../shopify.server";
import {
  deleteMetaobject,
  listAllMetaobjects,
  upsertMetaobject,
} from "../lib/customizer-data.server";
import {
  currentMotifKey,
  deleteMotifAssets,
} from "../lib/r2.server";
import { findSharedMotifReferences } from "../lib/motif-records";
import { planActiveMotifMove } from "../lib/motif-position";

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
            { sort_order: nextOrder },
          );
        }),
      );

      return Response.json({ ok: true, intent });
    }

    if (intent === "move-to-position") {
      const categoryHandle = String(formData.get("categoryHandle") || "").trim();
      const handle = String(formData.get("handle") || "").trim();
      const positionInput = String(formData.get("position") || "").trim();
      if (!categoryHandle || !handle || !/^[1-9]\d*$/.test(positionInput)) {
        throw new Error("Bitte wähle ein Motiv und eine gültige Position aus.");
      }

      const motifs = (
        await listAllMetaobjects(
          admin,
          "motifs",
          `fields.category_handle:${categoryHandle}`,
        )
      ).filter((motif) => motif.category_handle === categoryHandle);
      const plan = planActiveMotifMove(motifs, handle, Number(positionInput));

      // Keep large cross-page moves within a small number of concurrent API calls.
      for (let offset = 0; offset < plan.updates.length; offset += 5) {
        await Promise.all(
          plan.updates.slice(offset, offset + 5).map(({ motif, sortOrder }) =>
            upsertMetaobject(
              admin,
              "motifs",
              motif.handle,
              { sort_order: sortOrder },
            ),
          ),
        );
      }

      if (plan.updates.length) {
        const savedMotifs = (
          await listAllMetaobjects(
            admin,
            "motifs",
            `fields.category_handle:${categoryHandle}`,
          )
        ).filter((motif) => motif.category_handle === categoryHandle);
        const savedActiveHandles = savedMotifs
          .sort(byStoredOrder)
          .filter((motif) => motif.active !== false)
          .map((motif) => motif.handle);
        const expectedActiveHandles = plan.ordered
          .filter((motif) => motif.active !== false)
          .map((motif) => motif.handle);
        if (JSON.stringify(savedActiveHandles) !== JSON.stringify(expectedActiveHandles)) {
          throw new Error(
            "Die neue Reihenfolge konnte nicht bestätigt werden. Bitte lade die Motivliste neu und prüfe die Position.",
          );
        }
      }

      return Response.json({
        ok: true,
        intent,
        position: plan.targetPosition,
      });
    }

    if (intent === "delete") {
      const handle = String(formData.get("handle") || "").trim();
      const motifs = await listAllMetaobjects(admin, "motifs");
      const motif = motifs.find((item) => item.handle === handle);
      if (!motif) throw new Error("Das Motiv wurde nicht gefunden.");

      const storageKeyForMotif = currentMotifKey;
      const r2Key = storageKeyForMotif(motif);
      await deleteMetaobject(admin, motif.id);

      let warning = "";
      if (!r2Key) {
        warning =
          "Der Shopify-Eintrag wurde gelöscht, aber für die R2-Datei ist kein Schlüssel gespeichert.";
      } else {
        const sharedReferences = findSharedMotifReferences(
          motifs,
          motif.id,
          r2Key,
          storageKeyForMotif,
        );
        if (sharedReferences.length) {
          warning = `Der Shopify-Eintrag wurde gelöscht. Die R2-Datei bleibt erhalten, weil sie noch von ${sharedReferences.length} weiteren Motiv(en) verwendet wird.`;
        } else {
          try {
            await deleteMotifAssets(r2Key);
          } catch {
            warning =
              "Der Shopify-Eintrag wurde gelöscht, die R2-Datei konnte jedoch nicht entfernt werden.";
          }
        }
      }

      return Response.json({ ok: true, intent, warning });
    }

    return Response.json({ error: "Ungültige Motiv-Aktion." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Die Aktion ist fehlgeschlagen.",
      },
      { status: 400 },
    );
  }
};
