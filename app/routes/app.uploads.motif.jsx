import { authenticate } from "../shopify.server";
import {
  listAllMetaobjects,
  upsertMetaobject,
} from "../lib/customizer-data.server";
import {
  findDuplicateMotif,
  findMotifByStorageKey,
  isMotifUploadKeyForCategory,
  motifSlugFromFileName,
  slugifyMotif,
} from "../lib/motif-records";
import {
  completeMotifImages,
  createMotifUpload,
  motifWithCurrentPublicUrls,
  verifyMotifUpload,
} from "../lib/r2.server";

const value = (formData, key) => String(formData.get(key) || "").trim();

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = value(formData, "intent");

  try {
    if (intent === "prepare") {
      const categoryHandle = value(formData, "categoryHandle");
      const fileName = value(formData, "fileName");
      const categories = await listAllMetaobjects(admin, "categories");
      const category = categories.find(
        (item) => item.handle === categoryHandle && item.active !== false,
      );
      if (!category) {
        throw new Error("Die ausgewählte Kategorie wurde nicht gefunden.");
      }

      const incomingSlug = motifSlugFromFileName(fileName);
      const categoryMotifs = await listAllMetaobjects(
        admin,
        "motifs",
        `fields.category_handle:${categoryHandle}`,
      );
      const duplicate = findDuplicateMotif(categoryMotifs, incomingSlug);
      if (duplicate) {
        throw new Error(
          `Das Motiv „${duplicate.name || duplicate.displayName}“ existiert in dieser Kategorie bereits. Lösche zuerst den vorhandenen Eintrag.`,
        );
      }

      const result = await createMotifUpload({
        fileName,
        contentType: value(formData, "contentType"),
        fileSize: Number(formData.get("fileSize")),
        categoryHandle,
      });
      return Response.json({ ok: true, ...result });
    }

    if (intent === "complete") {
      const key = value(formData, "key");
      const name = value(formData, "name");
      const originalFilename = value(formData, "originalFilename");
      const categoryHandle = value(formData, "categoryHandle");
      const altText = value(formData, "altText") || name;
      if (!name) throw new Error("Der Motivname fehlt.");
      if (!isMotifUploadKeyForCategory(key, categoryHandle)) {
        throw new Error("Der Upload gehört nicht zu dieser Kategorie.");
      }

      await verifyMotifUpload(key);
      const categories = await listAllMetaobjects(admin, "categories");
      const category = categories.find(
        (item) => item.handle === categoryHandle && item.active !== false,
      );
      if (!category) {
        throw new Error("Die ausgewählte Kategorie wurde nicht gefunden.");
      }

      const categoryMotifs = await listAllMetaobjects(
        admin,
        "motifs",
        `fields.category_handle:${categoryHandle}`,
      );
      const alreadyCompleted = findMotifByStorageKey(categoryMotifs, key);
      if (alreadyCompleted) {
        if (key.startsWith("motifs-v2/")) await completeMotifImages(key);
        return Response.json({
          ok: true,
          motif: motifWithCurrentPublicUrls(alreadyCompleted),
        });
      }
      const slug = slugifyMotif(value(formData, "slug") || name);
      const duplicate = findDuplicateMotif(categoryMotifs, slug);
      if (duplicate) {
        throw new Error(
          `Das Motiv „${duplicate.name || duplicate.displayName}“ existiert in dieser Kategorie bereits. Lösche zuerst den vorhandenen Eintrag.`,
        );
      }
      const nextSortOrder =
        categoryMotifs.reduce(
          (maximum, motif) => Math.max(maximum, Number(motif.sort_order) || 0),
          0,
        ) + 1;
      const uniqueSuffix = key
        .split("/")
        .at(-1)
        .split("-")
        .slice(0, 2)
        .join("-");
      const handle = `${slug || "motiv"}-${uniqueSuffix}`;
      const { imageUrl, thumbnailUrl } = await completeMotifImages(key);
      const motif = await upsertMetaobject(admin, "motifs", handle, {
        name,
        slug: slug || handle,
        category: category.id,
        category_handle: categoryHandle,
        image_url: imageUrl,
        thumbnail_url: thumbnailUrl,
        r2_key: key,
        original_filename: originalFilename,
        alt_text: altText,
        sort_order: nextSortOrder,
        active: true,
      });

      return Response.json({ ok: true, motif: motifWithCurrentPublicUrls(motif) });
    }

    return Response.json({ error: "Ungültige Upload-Aktion." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
};
