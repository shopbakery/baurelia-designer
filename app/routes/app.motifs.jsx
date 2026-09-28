/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { listAllMetaobjects } from "../lib/customizer-data.server";
import {
  motifDisplayLabel,
  motifOriginalFilename,
} from "../lib/motif-labels";
import { motifKeyFromPublicUrl } from "../lib/r2.server";
import styles from "../styles/motifs.module.css";

const PAGE_SIZE = 48;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const normalized = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const nameFromFile = (fileName) =>
  fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const byStoredOrder = (left, right) =>
  Number(left.sort_order || 0) - Number(right.sort_order || 0) ||
  String(left.name || left.displayName).localeCompare(
    String(right.name || right.displayName),
    "de",
  );

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "";
  const category = url.searchParams.get("category")?.trim() || "";
  const requestedStatus = url.searchParams.get("status") || "active";
  const status = ["active", "inactive", "all"].includes(requestedStatus)
    ? requestedStatus
    : "active";
  const requestedPage = Number(url.searchParams.get("page") || 1);
  const page = Number.isInteger(requestedPage) && requestedPage > 0
    ? requestedPage
    : 1;

  const [categories, motifs] = await Promise.all([
    listAllMetaobjects(admin, "categories"),
    listAllMetaobjects(
      admin,
      "motifs",
      category ? `fields.category_handle:${category}` : null,
    ),
  ]);

  const categoryNames = new Map(
    categories.map((item) => [item.handle, item.name || item.displayName]),
  );
  const preparedMotifs = [...motifs]
    .sort(byStoredOrder)
    .map((motif, index) => ({
      ...motif,
      display_label: motifDisplayLabel(
        motif,
        categoryNames.get(motif.category_handle),
        index + 1,
      ),
      original_filename: motifOriginalFilename(motif),
    }));
  const searchTerm = normalized(query);
  const filtered = preparedMotifs
    .filter((motif) => {
      if (status === "active" && motif.active === false) return false;
      if (status === "inactive" && motif.active !== false) return false;
      if (!searchTerm) return true;
      return [
        motif.display_label,
        motif.original_filename,
        motif.name,
        motif.displayName,
        motif.slug,
        motif.handle,
      ].some((candidate) => normalized(candidate).includes(searchTerm));
    })
    .sort(byStoredOrder);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;

  return {
    categories: categories
      .filter((item) => item.active !== false)
      .sort(
        (left, right) =>
          Number(left.sort_order || 0) - Number(right.sort_order || 0),
      ),
    items: filtered.slice(start, start + PAGE_SIZE).map((motif) => ({
      ...motif,
      canDeleteR2: Boolean(
        motif.r2_key || motifKeyFromPublicUrl(motif.image_url),
      ),
    })),
    totalCount: preparedMotifs.length,
    filteredCount: filtered.length,
    query,
    category,
    status,
    page: currentPage,
    pageCount,
  };
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

const postUploadAction = (shopify, payload) =>
  postAuthenticatedAction(shopify, "/app/uploads/motif", payload);

const postMotifAction = (shopify, payload) =>
  postAuthenticatedAction(shopify, "/app/motif-actions", payload);

const putFile = (uploadUrl, file, onProgress) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.timeout = 120000;
    request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Cloudflare R2 antwortete mit HTTP ${request.status}.`));
    };
    request.onerror = () => reject(new Error("Die Verbindung zu Cloudflare R2 ist fehlgeschlagen."));
    request.ontimeout = () => reject(new Error("Der Upload zu Cloudflare R2 hat zu lange gedauert."));
    request.onabort = () => reject(new Error("Der Upload wurde abgebrochen."));
    request.send(file);
  });

function UploadModal({ categories, initialCategory, multiple, onUploaded }) {
  const shopify = useAppBridge();
  const [files, setFiles] = useState([]);
  const [categoryHandle, setCategoryHandle] = useState(
    initialCategory || categories[0]?.handle || "",
  );
  const [altText, setAltText] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const primaryFile = files[0] || null;

  useEffect(() => {
    if (initialCategory) setCategoryHandle(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    if (!files[0]) {
      setPreviewUrl("");
      return undefined;
    }
    const nextPreview = URL.createObjectURL(files[0]);
    setPreviewUrl(nextPreview);
    return () => URL.revokeObjectURL(nextPreview);
  }, [files]);

  const selectFiles = (event) => {
    const selected = Array.from(event.currentTarget.files || []);
    const accepted = multiple ? selected : selected.slice(0, 1);
    const invalid = accepted.find(
      (file) => !ALLOWED_TYPES.has(file.type) || file.size > MAX_FILE_SIZE,
    );
    if (invalid) {
      setError("Erlaubt sind PNG, JPG und WebP mit maximal 10 MB pro Datei.");
      setFiles([]);
      return;
    }
    setError("");
    setFiles(accepted);
    if (accepted.length === 1) {
      const suggestedName = nameFromFile(accepted[0].name);
      setAltText(suggestedName);
    }
  };

  const reset = () => {
    setPreviewUrl("");
    setFiles([]);
    setAltText("");
    setProgress(0);
    setError("");
  };

  const upload = async () => {
    if (!files.length) {
      setError("Bitte wähle mindestens eine Bilddatei aus.");
      return;
    }
    if (!categoryHandle) {
      setError("Bitte wähle eine Kategorie aus.");
      return;
    }
    setUploading(true);
    setError("");
    setProgress(0);

    let completedCount = 0;
    try {
      for (const [index, file] of files.entries()) {
        const itemName = nameFromFile(file.name);
        const prepared = await postUploadAction(shopify, {
          intent: "prepare",
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
          categoryHandle,
        });
        await putFile(prepared.uploadUrl, file, (fileProgress) => {
          setProgress(((index + fileProgress) / files.length) * 100);
        });
        const completed = await postUploadAction(shopify, {
          intent: "complete",
          key: prepared.key,
          name: itemName,
          slug: itemName,
          categoryHandle,
          originalFilename: file.name,
          altText: files.length === 1 ? altText.trim() || itemName : itemName,
        });
        onUploaded([completed.motif], categoryHandle);
        setProgress(((index + 1) / files.length) * 100);
        completedCount += 1;
      }

      shopify.toast.show(
        files.length === 1
          ? "Motiv wurde hochgeladen."
          : `${files.length} Motive wurden hochgeladen.`,
      );
      reset();
      document.getElementById("motif-upload-modal")?.hideOverlay();
    } catch (uploadError) {
      if (files.length > 1 && completedCount > 0) {
        setFiles((currentFiles) => currentFiles.slice(completedCount));
        setProgress(0);
        setError(
          `${completedCount} Datei(en) wurden gespeichert. Die übrigen Dateien wurden nicht hochgeladen: ${uploadError.message}`,
        );
      } else {
        setError(uploadError.message);
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <s-modal id="motif-upload-modal" heading="Neue Motive hochladen" size="large-100">
      <div className={styles.uploadLayout}>
        <div>
          <s-drop-zone
            label="Bilddatei"
            accessibilityLabel="Motivbilder auswählen"
            accept=".png,.jpg,.jpeg,.webp"
            multiple={multiple}
            disabled={uploading}
            onInput={selectFiles}
          ></s-drop-zone>

          {previewUrl && primaryFile && (
            <div className={styles.uploadPreview}>
              <img src={previewUrl} alt="Vorschau des neuen Motivs" />
              <div>
                <strong>{primaryFile.name}</strong>
                <span>
                  {files.length > 1
                    ? `${files.length} Dateien ausgewählt`
                    : `${(primaryFile.size / 1024 / 1024).toFixed(1)} MB`}
                </span>
              </div>
            </div>
          )}
        </div>

        <s-stack direction="block" gap="base">
          <s-select
            label="Kategorie"
            value={categoryHandle}
            disabled={uploading}
            onChange={(event) => setCategoryHandle(event.currentTarget.value)}
          >
            <s-option value="">Kategorie auswählen</s-option>
            {categories.map((category) => (
              <s-option key={category.id} value={category.handle}>
                {category.name || category.displayName}
              </s-option>
            ))}
          </s-select>

          {files.length <= 1 && (
            <s-text-area
              label="Alternativtext"
              value={altText}
              rows={3}
              disabled={uploading}
              onInput={(event) => setAltText(event.currentTarget.value)}
            ></s-text-area>
          )}

          {files.length > 1 && (
            <s-banner heading="Mehrfachupload" tone="info">
              Die Namen werden automatisch aus den Dateinamen erstellt. Alle
              Motive werden der ausgewählten Kategorie zugeordnet.
            </s-banner>
          )}

          {uploading && (
            <div className={styles.progressBlock}>
              <progress value={progress} max="100" />
              <span>{Math.round(progress)} % hochgeladen</span>
            </div>
          )}

          {error && (
            <s-banner heading="Upload nicht möglich" tone="critical">
              {error}
            </s-banner>
          )}
        </s-stack>
      </div>

      <s-button
        slot="primary-action"
        variant="primary"
        loading={uploading}
        disabled={!files.length || !categoryHandle}
        onClick={upload}
      >
        Hochladen und speichern
      </s-button>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        commandFor="motif-upload-modal"
        command="--hide"
        disabled={uploading}
        onClick={reset}
      >
        Abbrechen
      </s-button>
    </s-modal>
  );
}

function DeleteModal({ motif, onDeleted }) {
  const shopify = useAppBridge();
  const [deleteFile, setDeleteFile] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDeleteFile(false);
    setError("");
  }, [motif]);

  const remove = async () => {
    if (!motif) return;
    setDeleting(true);
    setError("");
    try {
      const result = await postMotifAction(shopify, {
        intent: "delete",
        handle: motif.handle,
        deleteFile,
      });
      shopify.toast.show(
        result.warning || `${motif.display_label || motif.name || motif.displayName} wurde gelöscht.`,
        result.warning ? { isError: true } : undefined,
      );
      document.getElementById("motif-delete-modal")?.hideOverlay();
      onDeleted();
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <s-modal
      id="motif-delete-modal"
      heading={`„${motif?.display_label || motif?.name || motif?.displayName || "Motiv"}“ löschen?`}
      size="base"
    >
      <s-stack direction="block" gap="base">
        <s-text>
          Das Motiv wird aus Shopify entfernt und erscheint danach nicht mehr im
          Customizer. Diese Aktion kann nicht rückgängig gemacht werden.
        </s-text>
        {motif?.canDeleteR2 ? (
          <s-checkbox
            label="Bilddatei ebenfalls dauerhaft aus Cloudflare R2 löschen"
            checked={deleteFile}
            disabled={deleting}
            onChange={(event) => setDeleteFile(event.currentTarget.checked)}
          ></s-checkbox>
        ) : (
          <s-banner tone="info">
            Für dieses ältere Motiv ist kein R2-Dateischlüssel gespeichert. Nur
            der Shopify-Eintrag wird gelöscht.
          </s-banner>
        )}
        {error && (
          <s-banner heading="Löschen nicht möglich" tone="critical">
            {error}
          </s-banner>
        )}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        loading={deleting}
        onClick={remove}
      >
        Motiv löschen
      </s-button>
      <s-button
        slot="secondary-actions"
        commandFor="motif-delete-modal"
        command="--hide"
        disabled={deleting}
      >
        Abbrechen
      </s-button>
    </s-modal>
  );
}

export default function Motifs() {
  const data = useLoaderData();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [multiple, setMultiple] = useState(false);
  const [busyHandle, setBusyHandle] = useState("");
  const [actionError, setActionError] = useState("");
  const [selectedMotif, setSelectedMotif] = useState(null);
  const [visibleItems, setVisibleItems] = useState(data.items);
  const [totalCount, setTotalCount] = useState(data.totalCount);
  const [filteredCount, setFilteredCount] = useState(data.filteredCount);
  const [draggedHandle, setDraggedHandle] = useState("");
  const [dragOverHandle, setDragOverHandle] = useState("");
  const categoryNames = useMemo(
    () =>
      new Map(
        data.categories.map((category) => [
          category.handle,
          category.name || category.displayName,
        ]),
      ),
    [data.categories],
  );

  useEffect(() => {
    setVisibleItems(data.items);
    setTotalCount(data.totalCount);
    setFilteredCount(data.filteredCount);
  }, [data.items, data.totalCount, data.filteredCount]);

  const pageCount = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));

  const addUploadedMotifs = (uploadedMotifs, uploadedCategoryHandle) => {
    const prepared = uploadedMotifs.map((motif) => ({
      ...motif,
      original_filename: motifOriginalFilename(motif),
      canDeleteR2: Boolean(motif.r2_key),
    }));
    setTotalCount((currentCount) => currentCount + prepared.length);

    const categoryMatches =
      !data.category || data.category === uploadedCategoryHandle;
    const statusMatches = data.status !== "inactive";
    const matching = prepared.filter((motif) => {
      if (!categoryMatches || !statusMatches) return false;
      if (!data.query) return true;
      const categoryName =
        categoryNames.get(motif.category_handle) || motif.category_handle;
      const displayLabel = motifDisplayLabel(motif, categoryName);
      return [
        displayLabel,
        motif.original_filename,
        motif.name,
        motif.displayName,
        motif.slug,
        motif.handle,
      ].some((candidate) => normalized(candidate).includes(normalized(data.query)));
    });

    if (!matching.length) return;
    setFilteredCount((currentCount) => currentCount + matching.length);
    if (data.page !== data.pageCount) return;
    setVisibleItems((currentItems) =>
      [...currentItems, ...matching]
        .filter(
          (motif, index, items) =>
            items.findIndex((item) => item.id === motif.id) === index,
        )
        .sort(byStoredOrder)
        .slice(0, PAGE_SIZE),
    );
  };

  const pageUrl = (page) => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    if (data.query) params.set("q", data.query);
    if (data.category) params.set("category", data.category);
    if (data.status !== "active") params.set("status", data.status);
    return `/app/motifs?${params}`;
  };

  const startDrag = (event, motif) => {
    if (!data.category || busyHandle) return;
    setDraggedHandle(motif.handle);
    setDragOverHandle(motif.handle);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", motif.handle);
  };

  const dropMotif = async (event, targetHandle) => {
    event.preventDefault();
    const sourceHandle =
      draggedHandle || event.dataTransfer.getData("text/plain");
    setDraggedHandle("");
    setDragOverHandle("");
    if (!data.category || !sourceHandle || sourceHandle === targetHandle) return;

    const previousItems = visibleItems;
    const sourceIndex = previousItems.findIndex(
      (motif) => motif.handle === sourceHandle,
    );
    const targetIndex = previousItems.findIndex(
      (motif) => motif.handle === targetHandle,
    );
    if (sourceIndex < 0 || targetIndex < 0) return;

    const slotOrders = previousItems.map(
      (motif, index) => Number(motif.sort_order) || index + 1,
    );
    const reorderedItems = [...previousItems];
    const [moved] = reorderedItems.splice(sourceIndex, 1);
    reorderedItems.splice(targetIndex, 0, moved);
    const nextItems = reorderedItems.map((motif, index) => ({
      ...motif,
      sort_order: slotOrders[index],
    }));
    setVisibleItems(nextItems);
    setBusyHandle(sourceHandle);
    setActionError("");
    try {
      await postMotifAction(shopify, {
        intent: "reorder",
        categoryHandle: data.category,
        orderedHandles: JSON.stringify(
          nextItems.map((motif) => motif.handle),
        ),
      });
      shopify.toast.show("Reihenfolge wurde gespeichert.");
      revalidator.revalidate();
    } catch (reorderError) {
      setVisibleItems(previousItems);
      setActionError(reorderError.message);
    } finally {
      setBusyHandle("");
    }
  };

  const openDelete = (motif) => {
    setSelectedMotif(motif);
    requestAnimationFrame(() => {
      document.getElementById("motif-delete-modal")?.showOverlay();
    });
  };

  return (
    <s-page heading="Motive" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        commandFor="motif-upload-modal"
        command="--show"
        onClick={() => setMultiple(false)}
      >
        Neues Motiv
      </s-button>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        commandFor="motif-upload-modal"
        command="--show"
        onClick={() => setMultiple(true)}
      >
        Mehrere hochladen
      </s-button>

      <s-section>
        <div className={styles.heroRow}>
          <div>
            <s-heading>Motivbibliothek</s-heading>
            <s-paragraph>
              Bilder werden in Cloudflare R2 gespeichert und automatisch mit
              Shopify verbunden.
            </s-paragraph>
          </div>
          <s-badge tone="success">{totalCount} Motive verbunden</s-badge>
        </div>

        <Form method="get" className={styles.filters}>
          <s-search-field
            label="Motive durchsuchen"
            labelAccessibilityVisibility="exclusive"
            name="q"
            value={data.query}
            placeholder="Motive durchsuchen"
          ></s-search-field>
          <s-select label="Kategorie" name="category" value={data.category}>
            <s-option value="">Alle Kategorien</s-option>
            {data.categories.map((category) => (
              <s-option key={category.id} value={category.handle}>
                {category.name || category.displayName}
              </s-option>
            ))}
          </s-select>
          <s-select label="Status" name="status" value={data.status}>
            <s-option value="active">Aktiv</s-option>
            <s-option value="inactive">Inaktiv</s-option>
            <s-option value="all">Alle</s-option>
          </s-select>
          <s-button type="submit" variant="secondary">Anwenden</s-button>
          {(data.query || data.category || data.status !== "active") && (
            <Link to="/app/motifs" className={styles.resetLink}>Zurücksetzen</Link>
          )}
        </Form>
      </s-section>

      <s-section>
        <div className={styles.resultHeader}>
          <div>
            <s-text type="strong">{filteredCount} Treffer</s-text>
            <p className={styles.orderingHint}>
              {data.category
                ? "Ziehe die Kacheln mit der Maus an die gewünschte Position. Die Reihenfolge wird automatisch gespeichert."
                : "Wähle eine Kategorie, um die Reihenfolge der Motive zu bearbeiten."}
            </p>
          </div>
          <s-text color="subdued">Seite {data.page} von {pageCount}</s-text>
        </div>

        {actionError && (
          <div className={styles.actionError}>
            <s-banner heading="Aktion nicht möglich" tone="critical">
              {actionError}
            </s-banner>
          </div>
        )}

        {visibleItems.length ? (
          <div className={styles.motifGrid}>
            {visibleItems.map((motif, index) => {
              const absoluteIndex = (data.page - 1) * PAGE_SIZE + index;
              const categoryName =
                categoryNames.get(motif.category_handle) || motif.category_handle;
              const displayLabel = motifDisplayLabel(
                motif,
                categoryName,
                absoluteIndex + 1,
              );
              const cardClassName = [
                styles.motifCard,
                draggedHandle === motif.handle ? styles.dragging : "",
                dragOverHandle === motif.handle && draggedHandle !== motif.handle
                  ? styles.dragTarget
                  : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <article
                  className={cardClassName}
                  key={motif.id}
                  draggable={Boolean(data.category) && !busyHandle}
                  onDragStart={(event) => startDrag(event, motif)}
                  onDragOver={(event) => {
                    if (!data.category || busyHandle) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDragEnter={() => {
                    if (draggedHandle && !busyHandle) {
                      setDragOverHandle(motif.handle);
                    }
                  }}
                  onDrop={(event) => dropMotif(event, motif.handle)}
                  onDragEnd={() => {
                    setDraggedHandle("");
                    setDragOverHandle("");
                  }}
                >
                  <div className={styles.imageFrame}>
                    <img
                      src={motif.thumbnail_url || motif.image_url}
                      alt={motif.alt_text || motif.name || motif.displayName}
                      loading="lazy"
                      draggable={false}
                    />
                  </div>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitleRow}>
                      <strong>{displayLabel}</strong>
                      <s-badge tone={motif.active === false ? "critical" : "success"}>
                        {motif.active === false ? "Inaktiv" : "Aktiv"}
                      </s-badge>
                    </div>
                    <span className={styles.categoryLabel}>
                      {categoryName}
                    </span>
                    <span className={styles.fileName} title={motif.original_filename}>
                      Datei: {motif.original_filename || "nicht verfügbar"}
                    </span>
                    <div className={styles.cardActions}>
                      {data.category ? (
                        <div
                          className={styles.dragHandle}
                          title="Kachel ziehen und ablegen"
                        >
                          <span aria-hidden="true">⋮⋮</span>
                          <span>Position {absoluteIndex + 1}</span>
                        </div>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        className={styles.deleteButton}
                        onClick={() => openDelete(motif)}
                      >
                        Löschen
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyState}>
            <s-heading>Keine Motive gefunden</s-heading>
            <s-paragraph>Ändere die Suche oder lade ein neues Motiv hoch.</s-paragraph>
          </div>
        )}

        {pageCount > 1 && (
          <nav className={styles.pagination} aria-label="Seitennavigation">
            {data.page > 1 ? <Link to={pageUrl(data.page - 1)}>Zurück</Link> : <span />}
            <span>{data.page} / {pageCount}</span>
            {data.page < pageCount ? (
              <Link to={pageUrl(data.page + 1)}>Weiter</Link>
            ) : <span />}
          </nav>
        )}
      </s-section>

      <UploadModal
        categories={data.categories}
        initialCategory={data.category}
        multiple={multiple}
        onUploaded={addUploadedMotifs}
      />
      <DeleteModal
        motif={selectedMotif}
        onDeleted={() => {
          setSelectedMotif(null);
          revalidator.revalidate();
        }}
      />
    </s-page>
  );
}
