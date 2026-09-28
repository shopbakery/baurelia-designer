/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import {
  redirect,
  useActionData,
  useLoaderData,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  RESOURCE_TYPES,
  deleteMetaobject,
  importLegacyBatch,
  legacyItemsFor,
  listAllMetaobjects,
  listMetaobjects,
  moveCategoryMotifs,
  normalizeCategorySortOrder,
  sortCategoriesAlphabetically,
  upsertMetaobject,
} from "../lib/customizer-data.server";
import styles from "../styles/resources.module.css";

const COLOR_USAGES = new Set(["text", "decoration", "both"]);

const colorUsageLabel = (usage) => {
  if (usage === "text") return "Textfarbe";
  if (usage === "decoration") return "Motiv-/Dekofarbe";
  return "Beides";
};

const byStoredOrder = (left, right) =>
  Number(left.sort_order || 0) - Number(right.sort_order || 0) ||
  String(left.name || left.displayName).localeCompare(
    String(right.name || right.displayName),
    "de",
  );

const labels = {
  categories: "Motivkategorien",
  motifs: "Motive",
  colors: "Farben",
  fonts: "Schriften",
};

const resourcesByPath = {
  "/app/categories": "categories",
  "/app/colors": "colors",
  "/app/fonts": "fonts",
};

const slugify = (value) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const required = (formData, key) => {
  const value = String(formData.get(key) || "").trim();
  if (!value) throw new Error(`${key} darf nicht leer sein.`);
  return value;
};

const validateFontUrl = (value, extension, label) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} muss eine vollständige URL sein.`);
  }
  if (url.protocol !== "https:" || !url.pathname.toLowerCase().endsWith(extension)) {
    throw new Error(`${label} muss eine HTTPS-URL zu einer ${extension}-Datei sein.`);
  }
  return value;
};

const requiredFontUrl = (formData, key, extension, label) =>
  validateFontUrl(required(formData, key), extension, label);

const optionalFontUrl = (formData, key, extension, label) => {
  const value = optionalValue(formData.get(key));
  return value ? validateFontUrl(value, extension, label) : undefined;
};

const optionalValue = (value) => {
  const normalized = String(value || "").trim();
  return normalized || undefined;
};

const postAuthenticatedAction = async (shopify, url, payload) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = new FormData();
    Object.entries(payload).forEach(([key, value]) =>
      body.set(key, String(value)),
    );
    const idToken = await shopify.idToken();
    const response = await fetch(url, {
      method: "POST",
      body,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${idToken}`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      if (attempt === 0) continue;
      throw new Error(
        "Der App-Server hat keine gültige Antwort geliefert. Bitte versuche es erneut.",
      );
    }
    const result = await response.json();
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      continue;
    }
    if (!response.ok || result.error) {
      throw new Error(result.error || "Die Aktion konnte nicht abgeschlossen werden.");
    }
    return result;
  }
  throw new Error("Die Aktion konnte nicht abgeschlossen werden.");
};

const buildValues = (resource, formData, categoriesByHandle) => {
  const name = required(formData, "name");
  const slug = required(formData, "slug");
  const common = {
    name,
    slug,
    sort_order: Number(formData.get("sortOrder") || 0),
    active: formData.get("active") === "true",
  };

  if (resource === "categories") {
    return {
      ...common,
      description: optionalValue(formData.get("description")),
    };
  }

  if (resource === "motifs") {
    const categoryHandle = required(formData, "categoryHandle");
    const categoryId = categoriesByHandle.get(categoryHandle);
    if (!categoryId) throw new Error("Die ausgewählte Kategorie wurde nicht gefunden.");
    return {
      ...common,
      category: categoryId,
      category_handle: categoryHandle,
      image_url: required(formData, "imageUrl"),
      thumbnail_url: optionalValue(formData.get("thumbnailUrl")),
      alt_text: optionalValue(formData.get("altText")) || name,
    };
  }

  if (resource === "colors") {
    const usage = String(formData.get("usage") || "both").trim();
    if (!COLOR_USAGES.has(usage)) {
      throw new Error("Die ausgewählte Farbverwendung ist ungültig.");
    }
    return {
      ...common,
      hex_value: required(formData, "hexValue"),
      usage,
    };
  }

  const woff2Url = requiredFontUrl(
    formData,
    "woff2Url",
    ".woff2",
    "WOFF2-Datei-URL",
  );
  const ttfUrl = requiredFontUrl(
    formData,
    "ttfUrl",
    ".ttf",
    "TTF-Datei-URL",
  );

  return {
    ...common,
    font_family: required(formData, "fontFamily"),
    font_url: woff2Url,
    woff2_url: woff2Url,
    ttf_url: ttfUrl,
    preview_text: optionalValue(formData.get("previewText")) || "Wunschtext",
    scale: Number(formData.get("scale") || 1),
  };
};

const fontValues = (font, overrides = {}) => ({
  name: font.name || font.displayName,
  slug: font.slug,
  font_family: font.font_family,
  font_url: font.font_url,
  woff2_url: font.woff2_url,
  ttf_url: font.ttf_url,
  preview_text: font.preview_text || "Wunschtext",
  scale: Number(font.scale || 1),
  sort_order: Number(font.sort_order || 0),
  active: font.active !== false,
  ...overrides,
});

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  const queryResource = url.searchParams.get("resource");
  const requestedResource =
    resourcesByPath[normalizedPath] || queryResource || "categories";
  if (requestedResource === "motifs") {
    const target = new URL("/app/motifs", url.origin);
    const category = url.searchParams.get("category");
    if (category) target.searchParams.set("category", category);
    throw redirect(`${target.pathname}${target.search}`);
  }
  if (
    normalizedPath === "/app/resources" &&
    resourcesByPath[`/app/${requestedResource}`]
  ) {
    const target = new URL(`/app/${requestedResource}`, url.origin);
    url.searchParams.forEach((value, key) => {
      if (key !== "resource") target.searchParams.append(key, value);
    });
    throw redirect(`${target.pathname}${target.search}`);
  }
  const resource = RESOURCE_TYPES[requestedResource]
    ? requestedResource
    : "categories";
  const category = url.searchParams.get("category") || "";
  const resumeParam = url.searchParams.get("resume");
  const requestedResumeOffset = resumeParam == null ? null : Number(resumeParam);
  const resumeOffset =
    requestedResumeOffset != null && Number.isInteger(requestedResumeOffset)
      ? Math.max(0, requestedResumeOffset)
      : null;
  const query =
    resource === "motifs" && category
      ? `fields.category_handle:${category}`
      : null;
  let page;
  let categories = [];
  let categoryMotifCounts = {};

  if (resource === "categories") {
    const [allCategories, motifs] = await Promise.all([
      listAllMetaobjects(admin, "categories"),
      listAllMetaobjects(admin, "motifs"),
    ]);
    const orderedCategories = await normalizeCategorySortOrder(
      admin,
      allCategories,
    );
    page = {
      items: orderedCategories,
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    categoryMotifCounts = motifs.reduce((counts, motif) => {
      const handle = String(motif.category_handle || "");
      if (handle) counts[handle] = (counts[handle] || 0) + 1;
      return counts;
    }, {});
  } else {
    [page, categories] = await Promise.all([
      listMetaobjects(admin, resource, { first: 100, query }),
      resource === "motifs" ? listAllMetaobjects(admin, "categories") : [],
    ]);
    categories = sortCategoriesAlphabetically(categories);
  }

  return {
    resource,
    items:
      resource === "colors" || resource === "fonts"
        ? [...page.items].sort(byStoredOrder)
        : page.items,
    pageInfo: page.pageInfo,
    categories,
    categoryMotifCounts,
    legacyTotal: legacyItemsFor(resource).length,
    category,
    resumeOffset,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const resource = String(formData.get("resource") || "");

  if (!RESOURCE_TYPES[resource]) {
    return Response.json({ error: "Ungültiger Ressourcentyp." }, { status: 400 });
  }

  try {
    if (intent === "delete") {
      if (resource === "categories") {
        const id = required(formData, "id");
        const handle = required(formData, "handle");
        const replacementHandle = String(
          formData.get("replacementHandle") || "",
        ).trim();
        const [categories, assignedMotifs] = await Promise.all([
          listAllMetaobjects(admin, "categories"),
          listAllMetaobjects(
            admin,
            "motifs",
            `fields.category_handle:${handle}`,
          ),
        ]);

        let movedCount = 0;
        if (assignedMotifs.length) {
          const replacement = categories.find(
            (category) => category.handle === replacementHandle,
          );
          if (!replacement || replacement.handle === handle) {
            throw new Error(
              `Die Kategorie enthält ${assignedMotifs.length} ${
                assignedMotifs.length === 1 ? "Motiv" : "Motive"
              }. Wähle zuerst eine Zielkategorie zum Verschieben aus.`,
            );
          }
          movedCount = await moveCategoryMotifs(
            admin,
            handle,
            replacement,
            assignedMotifs,
          );
        }

        await deleteMetaobject(admin, id);
        await normalizeCategorySortOrder(
          admin,
          categories.filter((category) => category.id !== id),
        );
        return {
          ok: true,
          message: movedCount
            ? `Kategorie gelöscht und ${movedCount} ${
                movedCount === 1 ? "Motiv" : "Motive"
              } verschoben.`
            : "Kategorie gelöscht.",
        };
      }
      await deleteMetaobject(admin, required(formData, "id"));
      return { ok: true, message: "Eintrag gelöscht." };
    }

    if (intent === "import") {
      const offset = Number(formData.get("offset") || 0);
      const result = await importLegacyBatch(admin, resource, offset);
      return { ok: true, resource, ...result };
    }

    if (resource === "fonts" && intent === "toggle-active") {
      const handle = required(formData, "handle");
      const font = (await listAllMetaobjects(admin, "fonts")).find(
        (item) => item.handle === handle,
      );
      if (!font) throw new Error("Die Schrift wurde nicht gefunden.");
      const active = formData.get("active") === "true";
      const item = await upsertMetaobject(
        admin,
        "fonts",
        handle,
        fontValues(font, { active }),
      );
      return {
        ok: true,
        item,
        message: active ? "Schrift aktiviert." : "Schrift deaktiviert.",
      };
    }

    if (resource === "fonts" && intent === "font-update") {
      const handle = required(formData, "handle");
      const font = (await listAllMetaobjects(admin, "fonts")).find(
        (item) => item.handle === handle,
      );
      if (!font) throw new Error("Die Schrift wurde nicht gefunden.");
      const woff2Url = optionalFontUrl(
        formData,
        "woff2Url",
        ".woff2",
        "WOFF2-Datei-URL",
      );
      const ttfUrl = optionalFontUrl(
        formData,
        "ttfUrl",
        ".ttf",
        "TTF-Datei-URL",
      );
      const values = fontValues(font, {
        name: required(formData, "name"),
        slug: required(formData, "slug"),
        font_family: required(formData, "fontFamily"),
        preview_text:
          optionalValue(formData.get("previewText")) || "Wunschtext",
        scale: Number(formData.get("scale") || 1),
        sort_order: Number(formData.get("sortOrder") || 0),
        active: formData.get("active") === "true",
        ...(woff2Url
          ? { font_url: woff2Url, woff2_url: woff2Url }
          : {}),
        ...(ttfUrl ? { ttf_url: ttfUrl } : {}),
      });
      const item = await upsertMetaobject(admin, "fonts", handle, values);
      return { ok: true, item, message: "Schrift gespeichert." };
    }

    const categories =
      resource === "motifs"
        ? await listAllMetaobjects(admin, "categories")
        : [];
    const categoriesByHandle = new Map(
      categories.map((category) => [category.handle, category.id]),
    );
    const values = buildValues(resource, formData, categoriesByHandle);
    const handle = String(formData.get("handle") || "").trim() || slugify(values.slug);
    const item = await upsertMetaobject(admin, resource, handle, values);

    if (resource === "categories") {
      await normalizeCategorySortOrder(admin);
      return {
        ok: true,
        item,
        message: "Kategorie gespeichert und alphabetisch eingeordnet.",
      };
    }

    return { ok: true, item, message: "Eintrag gespeichert." };
  } catch (error) {
    return Response.json(
      {
        error: error.message,
        resource,
        failedOffset: error.cause?.importOffset,
      },
      { status: 400 },
    );
  }
};

function ResourceForm({ resource, categories }) {
  return (
    <form method="post">
      <input type="hidden" name="intent" value="upsert" />
      <input type="hidden" name="resource" value={resource} />
      <s-stack direction="block" gap="base">
        <s-text-field label="Name" name="name" required></s-text-field>
        <s-text-field label="Slug" name="slug" required></s-text-field>

        {resource === "categories" && (
          <s-text-area label="Beschreibung" name="description" rows={3}></s-text-area>
        )}

        {resource === "motifs" && (
          <>
            <s-select label="Kategorie" name="categoryHandle" required>
              <s-option value="">Kategorie auswählen</s-option>
              {categories.map((category) => (
                <s-option key={category.id} value={category.handle}>
                  {category.name || category.displayName}
                </s-option>
              ))}
            </s-select>
            <s-url-field label="Cloudflare-R2-Bild-URL" name="imageUrl" required></s-url-field>
            <s-url-field label="Vorschaubild-URL" name="thumbnailUrl"></s-url-field>
            <s-text-field label="Alternativtext" name="altText"></s-text-field>
          </>
        )}

        {resource === "colors" && (
          <>
            <s-color-field label="Farbwert" name="hexValue" value="#000000"></s-color-field>
            <s-select label="Verwendung" name="usage" value="both">
              <s-option value="text">Textfarbe</s-option>
              <s-option value="decoration">Motiv-/Dekofarbe</s-option>
              <s-option value="both">Beides</s-option>
            </s-select>
          </>
        )}

        {resource === "fonts" && (
          <>
            <s-text-field label="CSS-Schriftfamilie" name="fontFamily" required></s-text-field>
            <s-url-field
              label="WOFF2-Datei-URL"
              details="Link zur .woff2-Datei unter Shopify → Inhalte → Dateien."
              placeholder="https://cdn.shopify.com/.../schrift.woff2"
              name="woff2Url"
              required
            ></s-url-field>
            <s-url-field
              label="TTF-Datei-URL"
              details="Link zur passenden .ttf-Datei derselben Schrift."
              placeholder="https://cdn.shopify.com/.../schrift.ttf"
              name="ttfUrl"
              required
            ></s-url-field>
            <s-text-field label="Vorschautext" name="previewText" value="Wunschtext"></s-text-field>
            <s-number-field label="Größenfaktor" name="scale" value="1" min="0.1" step="0.05"></s-number-field>
          </>
        )}

        {resource === "categories" ? (
          <input type="hidden" name="sortOrder" value="0" />
        ) : (
          <s-number-field label="Reihenfolge" name="sortOrder" value="0" min="0"></s-number-field>
        )}
        <input type="hidden" name="active" value="true" />
        <s-button type="submit" variant="primary">Speichern</s-button>
      </s-stack>
    </form>
  );
}

function ColorGrid({ items, canReorder }) {
  const shopify = useAppBridge();
  const [colors, setColors] = useState(() => [...items].sort(byStoredOrder));
  const [usageDrafts, setUsageDrafts] = useState(() =>
    Object.fromEntries(items.map((item) => [item.handle, item.usage || "both"])),
  );
  const [busyHandle, setBusyHandle] = useState("");
  const [draggedHandle, setDraggedHandle] = useState("");
  const [dragTarget, setDragTarget] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setColors([...items].sort(byStoredOrder));
    setUsageDrafts(
      Object.fromEntries(items.map((item) => [item.handle, item.usage || "both"])),
    );
  }, [items]);

  const saveUsage = async (color) => {
    const usage = usageDrafts[color.handle] || "both";
    setBusyHandle(color.handle);
    setError("");
    try {
      const result = await postAuthenticatedAction(shopify, "/app/color-actions", {
        intent: "update",
        handle: color.handle,
        usage,
      });
      setColors((current) =>
        current.map((entry) =>
          entry.handle === color.handle ? { ...entry, ...result.item, usage } : entry,
        ),
      );
      shopify.toast.show(`${color.name || color.displayName} gespeichert.`);
    } catch (saveError) {
      setError(saveError.message);
      shopify.toast.show(saveError.message, { isError: true });
    } finally {
      setBusyHandle("");
    }
  };

  const saveOrder = async (targetHandle, sourceHandle = draggedHandle) => {
    if (!canReorder || !sourceHandle || sourceHandle === targetHandle) {
      setDraggedHandle("");
      setDragTarget("");
      return;
    }

    const previous = colors;
    const fromIndex = previous.findIndex((color) => color.handle === sourceHandle);
    const targetIndex = previous.findIndex((color) => color.handle === targetHandle);
    if (fromIndex < 0 || targetIndex < 0) return;

    const next = [...previous];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    const ordered = next.map((color, index) => ({
      ...color,
      sort_order: index + 1,
    }));
    setColors(ordered);
    setDraggedHandle("");
    setDragTarget("");
    setError("");

    try {
      await postAuthenticatedAction(shopify, "/app/color-actions", {
        intent: "reorder",
        orderedHandles: JSON.stringify(ordered.map((color) => color.handle)),
      });
      shopify.toast.show("Reihenfolge gespeichert.");
    } catch (orderError) {
      setColors(previous);
      setError(orderError.message);
      shopify.toast.show(orderError.message, { isError: true });
    }
  };

  if (!colors.length) {
    return <s-paragraph>Noch keine Shopify-Metaobjekte vorhanden.</s-paragraph>;
  }

  return (
    <div className={styles.colorLibrary}>
      <div className={styles.colorIntro}>
        <s-paragraph>
          Ziehe die Farbkarten am Griff an die gewünschte Position. Die Reihenfolge
          wird automatisch gespeichert.
        </s-paragraph>
        {!canReorder && (
          <s-banner heading="Sortierung nicht verfügbar" tone="info">
            Für Drag-and-drop müssen alle Farben auf einer Seite sichtbar sein.
          </s-banner>
        )}
        {error && (
          <s-banner heading="Aktion nicht möglich" tone="critical">
            {error}
          </s-banner>
        )}
      </div>

      <div className={styles.colorGrid}>
        {colors.map((color, index) => {
          const usage = usageDrafts[color.handle] || color.usage || "both";
          return (
            <article
              key={color.id}
              draggable={canReorder && !busyHandle}
              className={`${styles.colorCard} ${
                draggedHandle === color.handle ? styles.dragging : ""
              } ${dragTarget === color.handle ? styles.dragTarget : ""}`}
              onDragStart={(event) => {
                if (!canReorder || busyHandle) return;
                setDraggedHandle(color.handle);
                setDragTarget(color.handle);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", color.handle);
              }}
              onDragOver={(event) => {
                if (!canReorder || busyHandle) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={() => {
                if (draggedHandle && !busyHandle) setDragTarget(color.handle);
              }}
              onDrop={(event) => {
                event.preventDefault();
                void saveOrder(
                  color.handle,
                  event.dataTransfer.getData("text/plain") || draggedHandle,
                );
              }}
              onDragEnd={() => {
                setDraggedHandle("");
                setDragTarget("");
              }}
            >
              <div
                className={styles.colorPreview}
                style={{ backgroundColor: color.hex_value }}
                title={`${color.name || color.displayName}: ${color.hex_value}`}
              ></div>
              <div className={styles.colorBody}>
                <div className={styles.colorHeading}>
                  <strong>{color.name || color.displayName}</strong>
                  <s-badge tone={color.active === false ? "critical" : "success"}>
                    {color.active === false ? "Inaktiv" : "Aktiv"}
                  </s-badge>
                </div>
                <div className={styles.colorMeta}>
                  <code>{color.hex_value}</code>
                  <span>{colorUsageLabel(color.usage || "both")}</span>
                </div>
                <s-select
                  label="Verwendung"
                  value={usage}
                  disabled={busyHandle === color.handle}
                  onChange={(event) => {
                    const nextUsage = event.currentTarget.value;
                    setUsageDrafts((current) => ({
                      ...current,
                      [color.handle]: nextUsage,
                    }));
                  }}
                >
                  <s-option value="text">Textfarbe</s-option>
                  <s-option value="decoration">Motiv-/Dekofarbe</s-option>
                  <s-option value="both">Beides</s-option>
                </s-select>
                <div className={styles.colorActions}>
                  <span
                    className={styles.dragHandle}
                    title="Zum Sortieren ziehen"
                  >
                    ⋮⋮ Position {index + 1}
                  </span>
                  <div className={styles.cardButtons}>
                    <s-button
                      variant="secondary"
                      loading={busyHandle === color.handle}
                      disabled={(color.usage || "both") === usage}
                      onClick={() => void saveUsage(color)}
                    >
                      Speichern
                    </s-button>
                    <form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="resource" value="colors" />
                      <input type="hidden" name="id" value={color.id} />
                      <s-button type="submit" tone="critical" variant="tertiary">
                        Löschen
                      </s-button>
                    </form>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const cssFontValue = (value) => String(value || "").replace(/["'\\\r\n]/g, "");

const fontFaceFor = (font) => {
  const family = `baurelia-admin-${String(font.handle).replace(/[^a-z0-9-]/gi, "")}`;
  const sources = [];
  if (font.woff2_url) {
    sources.push(`url("${cssFontValue(font.woff2_url)}") format("woff2")`);
  }
  if (font.ttf_url) {
    sources.push(`url("${cssFontValue(font.ttf_url)}") format("truetype")`);
  }
  if (!sources.length && font.font_url) {
    const url = cssFontValue(font.font_url);
    const format = /\.woff2(?:\?|$)/i.test(url)
      ? "woff2"
      : /\.ttf(?:\?|$)/i.test(url)
        ? "truetype"
        : "woff";
    sources.push(`url("${url}") format("${format}")`);
  }
  return {
    family,
    css: sources.length
      ? `@font-face{font-family:"${family}";src:${sources.join(",")};font-display:swap;}`
      : "",
  };
};

function FontLibrary({ items }) {
  if (!items.length) {
    return <s-paragraph>Noch keine Shopify-Metaobjekte vorhanden.</s-paragraph>;
  }

  const fontFaces = items.map(fontFaceFor);

  return (
    <div className={styles.fontLibrary}>
      <style>{fontFaces.map((font) => font.css).join("")}</style>
      <div className={styles.fontGrid}>
        {items.map((font, index) => {
          const modalId = `edit-font-${String(font.handle).replace(/[^a-z0-9-]/gi, "")}`;
          const completeFiles = Boolean(font.woff2_url && font.ttf_url);
          const face = fontFaces[index];
          return (
            <article className={styles.fontCard} key={font.id}>
              <div
                className={styles.fontPreview}
                style={{ fontFamily: `"${face.family}", sans-serif` }}
              >
                {font.preview_text || "Wunschtext"}
              </div>
              <div className={styles.fontBody}>
                <div className={styles.fontHeading}>
                  <strong>{font.name || font.displayName}</strong>
                  <s-badge tone={font.active === false ? "critical" : "success"}>
                    {font.active === false ? "Inaktiv" : "Aktiv"}
                  </s-badge>
                </div>
                <div className={styles.fontDetails}>
                  <span>{font.font_family}</span>
                  <span>Größenfaktor {Number(font.scale || 1)}</span>
                  <span>Position {Number(font.sort_order || 0)}</span>
                </div>
                <s-badge tone={completeFiles ? "success" : "info"}>
                  {completeFiles ? "WOFF2 + TTF hinterlegt" : "Legacy-Datei"}
                </s-badge>
                <div className={styles.fontActions}>
                  <s-button
                    commandFor={modalId}
                    command="--show"
                    variant="secondary"
                  >
                    Bearbeiten
                  </s-button>
                  <form method="post">
                    <input type="hidden" name="intent" value="toggle-active" />
                    <input type="hidden" name="resource" value="fonts" />
                    <input type="hidden" name="handle" value={font.handle} />
                    <input
                      type="hidden"
                      name="active"
                      value={font.active === false ? "true" : "false"}
                    />
                    <s-button
                      type="submit"
                      variant="tertiary"
                      tone={font.active === false ? "auto" : "critical"}
                    >
                      {font.active === false ? "Aktivieren" : "Deaktivieren"}
                    </s-button>
                  </form>
                </div>
                <form method="post">
                  <s-modal
                    id={modalId}
                    heading="Schrift bearbeiten"
                    size="large-100"
                  >
                    <input type="hidden" name="intent" value="font-update" />
                    <input type="hidden" name="resource" value="fonts" />
                    <input type="hidden" name="handle" value={font.handle} />
                    <s-stack direction="block" gap="base">
                      <div
                        className={styles.fontModalPreview}
                        style={{ fontFamily: `"${face.family}", sans-serif` }}
                      >
                        {font.preview_text || "Wunschtext"}
                      </div>
                      <s-text-field
                        label="Name"
                        name="name"
                        value={font.name || font.displayName}
                        required
                      ></s-text-field>
                      <s-text-field
                        label="Slug"
                        name="slug"
                        value={font.slug}
                        required
                      ></s-text-field>
                      <s-text-field
                        label="CSS-Schriftfamilie"
                        name="fontFamily"
                        value={font.font_family}
                        required
                      ></s-text-field>
                      <s-url-field
                        label="WOFF2-Datei-URL"
                        details="Leer lassen, wenn die bestehende Datei unverändert bleiben soll."
                        placeholder="https://cdn.shopify.com/.../schrift.woff2"
                        name="woff2Url"
                        value={font.woff2_url || ""}
                      ></s-url-field>
                      <s-url-field
                        label="TTF-Datei-URL"
                        details="Leer lassen, wenn die bestehende Datei unverändert bleiben soll."
                        placeholder="https://cdn.shopify.com/.../schrift.ttf"
                        name="ttfUrl"
                        value={font.ttf_url || ""}
                      ></s-url-field>
                      {!completeFiles && font.font_url && (
                        <s-banner heading="Bestehender Legacy-Eintrag" tone="info">
                          Diese Schrift verwendet weiterhin ihre bisherige Datei. Neue
                          WOFF2- und TTF-Links können bei Bedarf ergänzt werden.
                        </s-banner>
                      )}
                      <s-text-field
                        label="Vorschautext"
                        name="previewText"
                        value={font.preview_text || "Wunschtext"}
                      ></s-text-field>
                      <s-number-field
                        label="Größenfaktor"
                        name="scale"
                        value={String(Number(font.scale || 1))}
                        min={0.1}
                        step={0.05}
                      ></s-number-field>
                      <s-number-field
                        label="Reihenfolge"
                        name="sortOrder"
                        value={String(Number(font.sort_order || 0))}
                        min={0}
                      ></s-number-field>
                      <s-switch
                        label="Im Customizer aktiv"
                        name="active"
                        value="true"
                        defaultChecked={font.active !== false}
                      ></s-switch>
                    </s-stack>
                    <s-button
                      slot="secondary-actions"
                      commandFor={modalId}
                      command="--hide"
                    >
                      Abbrechen
                    </s-button>
                    <s-button slot="primary-action" type="submit" variant="primary">
                      Änderungen speichern
                    </s-button>
                  </s-modal>
                </form>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ResourceTable({ resource, items, categoryMotifCounts = {} }) {
  if (!items.length) {
    return <s-paragraph>Noch keine Shopify-Metaobjekte vorhanden.</s-paragraph>;
  }

  return (
    <s-table variant="auto">
      <s-table-header-row>
        <s-table-header listSlot="primary">Name</s-table-header>
        <s-table-header listSlot="labeled">Handle</s-table-header>
        {resource !== "categories" && (
          <s-table-header listSlot="labeled">Reihenfolge</s-table-header>
        )}
        {resource === "categories" && (
          <s-table-header listSlot="labeled">Motive</s-table-header>
        )}
        <s-table-header listSlot="labeled">Status</s-table-header>
        <s-table-header listSlot="labeled">Aktion</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {items.map((item) => (
          <s-table-row key={item.id}>
            <s-table-cell>{item.name || item.displayName}</s-table-cell>
            <s-table-cell>{item.handle}</s-table-cell>
            {resource !== "categories" && (
              <s-table-cell>{String(item.sort_order ?? 0)}</s-table-cell>
            )}
            {resource === "categories" && (
              <s-table-cell>
                {String(categoryMotifCounts[item.handle] || 0)}
              </s-table-cell>
            )}
            <s-table-cell>
              <s-badge tone={item.active === false ? "critical" : "success"}>
                {item.active === false ? "Inaktiv" : "Aktiv"}
              </s-badge>
            </s-table-cell>
            <s-table-cell>
              <form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="resource" value={resource} />
                <input type="hidden" name="id" value={item.id} />
                {resource === "categories" && (
                  <input type="hidden" name="handle" value={item.handle} />
                )}
                <div className={styles.categoryDeleteActions}>
                  {resource === "categories" &&
                    Number(categoryMotifCounts[item.handle] || 0) > 0 && (
                      <s-select
                        label="Motive verschieben nach"
                        labelAccessibilityVisibility="exclusive"
                        name="replacementHandle"
                        required
                      >
                        <s-option value="">Zielkategorie wählen</s-option>
                        {items
                          .filter((category) => category.handle !== item.handle)
                          .map((category) => (
                            <s-option
                              key={category.id}
                              value={category.handle}
                            >
                              {category.name || category.displayName}
                            </s-option>
                          ))}
                      </s-select>
                    )}
                  <s-button type="submit" tone="critical" variant="tertiary">
                    {resource === "categories" &&
                    Number(categoryMotifCounts[item.handle] || 0) > 0
                      ? "Verschieben & löschen"
                      : "Löschen"}
                  </s-button>
                </div>
              </form>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export default function Resources() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [, setSearchParams] = useSearchParams();

  return (
    <s-page heading={labels[loaderData.resource]}>
      {actionData?.message && (
        <s-banner heading="Änderung gespeichert" tone="success">
          {actionData.message}
        </s-banner>
      )}
      {actionData?.error && (
        <s-banner heading="Aktion nicht möglich" tone="critical">
          {actionData.error}
        </s-banner>
      )}
      {loaderData.resource === "motifs" && (
        <s-section heading="Kategorie filtern">
          <s-select
            label="Kategorie"
            value={loaderData.category}
            onChange={(event) => {
              const category = event.currentTarget.value;
              setSearchParams({ resource: "motifs", ...(category ? { category } : {}) });
            }}
          >
            <s-option value="">Alle Kategorien</s-option>
            {loaderData.categories.map((category) => (
              <s-option key={category.id} value={category.handle}>
                {category.name || category.displayName}
              </s-option>
            ))}
          </s-select>
        </s-section>
      )}

      <s-section heading={`Neue ${labels[loaderData.resource]} anlegen`}>
        <ResourceForm
          resource={loaderData.resource}
          categories={loaderData.categories}
        />
      </s-section>

      <s-section heading="Vorhandene Einträge">
        {loaderData.resource === "colors" ? (
          <ColorGrid
            items={loaderData.items}
            canReorder={!loaderData.pageInfo.hasNextPage}
          />
        ) : loaderData.resource === "fonts" ? (
          <FontLibrary items={loaderData.items} />
        ) : (
          <ResourceTable
            resource={loaderData.resource}
            items={loaderData.items}
            categoryMotifCounts={loaderData.categoryMotifCounts}
          />
        )}
        {loaderData.pageInfo.hasNextPage && (
          <s-banner heading="Weitere Einträge vorhanden" tone="info">
            Die Liste zeigt aktuell die ersten 100 Treffer. Nutze bei Motiven den
            Kategorienfilter.
          </s-banner>
        )}
      </s-section>
    </s-page>
  );
}
