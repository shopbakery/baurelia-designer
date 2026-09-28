import { authenticate } from "../shopify.server";
import {
  listAllMetaobjects,
  upsertMetaobject,
} from "../lib/customizer-data.server";
import {
  createMotifUpload,
  deleteMotifObject,
  r2PublicUrl,
  verifyMotifUpload,
} from "../lib/r2.server";

const value = (formData, key) => String(formData.get(key) || "").trim();

const slugify = (input) =>
  input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = value(formData, "intent");

  try {
    if (intent === "prepare") {
      const categoryHandle = value(formData, "categoryHandle");
      const categories = await listAllMetaobjects(admin, "categories");
      const category = categories.find(
        (item) => item.handle === categoryHandle && item.active !== false,
      );
      if (!category) {
        throw new Error("Die ausgewählte Kategorie wurde nicht gefunden.");
      }

      const result = await createMotifUpload({
        fileName: value(formData, "fileName"),
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

      try {
        await verifyMotifUpload(key);
        const categories = await listAllMetaobjects(admin, "categories");
        const category = categories.find(
          (item) => item.handle === categoryHandle,
        );
        if (!category) throw new Error("Die ausgewählte Kategorie wurde nicht gefunden.");

        const categoryMotifs = await listAllMetaobjects(
          admin,
          "motifs",
          `fields.category_handle:${categoryHandle}`,
        );
        const nextSortOrder =
          categoryMotifs.reduce(
            (maximum, motif) => Math.max(maximum, Number(motif.sort_order) || 0),
            0,
          ) + 1;
        const slug = slugify(value(formData, "slug") || name);
        const uniqueSuffix = key.split("/").at(-1).split("-").slice(0, 2).join("-");
        const handle = `${slug || "motiv"}-${uniqueSuffix}`;
        const imageUrl = r2PublicUrl(key);
        const motif = await upsertMetaobject(admin, "motifs", handle, {
          name,
          slug: slug || handle,
          category: category.id,
          category_handle: categoryHandle,
          image_url: imageUrl,
          thumbnail_url: imageUrl,
          r2_key: key,
          original_filename: originalFilename,
          alt_text: altText,
          sort_order: nextSortOrder,
          active: true,
        });

        return Response.json({ ok: true, motif });
      } catch (completeError) {
        try {
          await deleteMotifObject(key);
        } catch {
          // Keep the original error; an orphaned object can be cleaned up later.
        }
        throw completeError;
      }
    }

    return Response.json({ error: "Ungültige Upload-Aktion." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
};
