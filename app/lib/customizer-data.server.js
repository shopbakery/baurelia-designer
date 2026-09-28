import legacyCatalog from "../data/legacy-catalog.json";
import { motifOriginalFilename } from "./motif-labels";

const compactValues = (values) =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== "" && value != null),
  );

const activeImportBatches = new Map();
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const categoryValues = (category) => ({
  name: category.name || category.displayName,
  slug: category.slug || category.handle,
  description: category.description,
  sort_order: Number(category.sort_order ?? category.sortOrder ?? 0),
  active: category.active !== false,
});

export const sortCategoriesAlphabetically = (categories) =>
  [...categories].sort(
    (left, right) =>
      String(left.name || left.displayName || "").localeCompare(
        String(right.name || right.displayName || ""),
        "de",
        { sensitivity: "base", numeric: true },
      ) || String(left.handle).localeCompare(String(right.handle), "de"),
  );

export const RESOURCE_TYPES = {
  categories: "$app:motif_category",
  motifs: "$app:motif",
  colors: "$app:customizer_color",
  palettes: "$app:color_palette",
  fonts: "$app:customizer_font",
};

const LIST_METAOBJECTS = `#graphql
  query BaureliaListMetaobjects(
    $type: String!
    $first: Int!
    $after: String
    $query: String
  ) {
    metaobjects(
      type: $type
      first: $first
      after: $after
      query: $query
      sortKey: "display_name"
    ) {
      nodes {
        id
        handle
        displayName
        updatedAt
        fields {
          key
          jsonValue
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LIST_MOTIF_CATEGORY_HANDLES = `#graphql
  query BaureliaListMotifCategoryHandles($first: Int!, $after: String) {
    metaobjects(
      type: "$app:motif"
      first: $first
      after: $after
      sortKey: "id"
    ) {
      nodes {
        categoryHandle: field(key: "category_handle") {
          jsonValue
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const UPSERT_METAOBJECT = `#graphql
  mutation BaureliaUpsertMetaobject(
    $handle: MetaobjectHandleInput!
    $metaobject: MetaobjectUpsertInput!
  ) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject {
        id
        handle
        displayName
        updatedAt
        fields {
          key
          jsonValue
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DELETE_METAOBJECT = `#graphql
  mutation BaureliaDeleteMetaobject($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const throwGraphqlErrors = (payload) => {
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
};

const throwUserErrors = (userErrors = []) => {
  if (userErrors.length) {
    throw new Error(userErrors.map((error) => error.message).join("; "));
  }
};

const normalizeNode = (node) => ({
  id: node.id,
  handle: node.handle,
  displayName: node.displayName,
  updatedAt: node.updatedAt,
  ...Object.fromEntries(
    (node.fields || []).map((field) => [field.key, field.jsonValue]),
  ),
});

const serializeFields = (values) =>
  Object.entries(compactValues(values)).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));

export async function listMetaobjects(
  admin,
  resource,
  { first = 100, after = null, query = null } = {},
) {
  const response = await admin.graphql(LIST_METAOBJECTS, {
    variables: {
      type: RESOURCE_TYPES[resource],
      first,
      after,
      query,
    },
  });
  const payload = await response.json();
  throwGraphqlErrors(payload);

  const connection = payload.data.metaobjects;
  return {
    items: connection.nodes.map(normalizeNode),
    pageInfo: connection.pageInfo,
  };
}

export async function listAllMetaobjects(admin, resource, query = null) {
  const items = [];
  let after = null;

  do {
    const page = await listMetaobjects(admin, resource, {
      first: 250,
      after,
      query,
    });
    items.push(...page.items);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return items;
}

export async function countMotifsByCategory(admin) {
  const counts = {};
  let after = null;

  do {
    const response = await admin.graphql(LIST_MOTIF_CATEGORY_HANDLES, {
      variables: { first: 250, after },
    });
    const payload = await response.json();
    throwGraphqlErrors(payload);
    const connection = payload.data.metaobjects;

    for (const node of connection.nodes) {
      const handle = String(node.categoryHandle?.jsonValue || "");
      if (handle) counts[handle] = (counts[handle] || 0) + 1;
    }
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return counts;
}

export async function upsertMetaobject(admin, resource, handle, values) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await admin.graphql(UPSERT_METAOBJECT, {
      variables: {
        handle: { type: RESOURCE_TYPES[resource], handle },
        metaobject: { fields: serializeFields(values) },
      },
    });
    const payload = await response.json();
    throwGraphqlErrors(payload);

    const userErrors = payload.data.metaobjectUpsert.userErrors;
    const handleConflict = userErrors.some(
      (error) =>
        error.code === "TAKEN" ||
        error.code === "URL_HANDLE_TAKEN" ||
        error.message.toLowerCase().includes("handle has already been taken"),
    );

    if (handleConflict && attempt < 2) {
      await wait(250 * (attempt + 1));
      continue;
    }

    throwUserErrors(userErrors);
    return normalizeNode(payload.data.metaobjectUpsert.metaobject);
  }
}

export async function deleteMetaobject(admin, id) {
  const response = await admin.graphql(DELETE_METAOBJECT, {
    variables: { id },
  });
  const payload = await response.json();
  throwGraphqlErrors(payload);
  throwUserErrors(payload.data.metaobjectDelete.userErrors);
  return payload.data.metaobjectDelete.deletedId;
}

export async function normalizeCategorySortOrder(admin, categories = null) {
  const ordered = sortCategoriesAlphabetically(
    categories || (await listAllMetaobjects(admin, "categories")),
  );

  for (const [index, category] of ordered.entries()) {
    const sortOrder = index + 1;
    if (Number(category.sort_order) === sortOrder) continue;
    await upsertMetaobject(admin, "categories", category.handle, {
      ...categoryValues(category),
      sort_order: sortOrder,
    });
    category.sort_order = sortOrder;
  }

  return ordered;
}

const motifValues = (motif, overrides = {}) => ({
  name: motif.name || motif.displayName,
  slug: motif.slug || motif.handle,
  category: motif.category,
  category_handle: motif.category_handle,
  image_url: motif.image_url,
  thumbnail_url: motif.thumbnail_url,
  r2_key: motif.r2_key,
  original_filename: motif.original_filename,
  alt_text: motif.alt_text || motif.name || motif.displayName,
  sort_order: Number(motif.sort_order || 0),
  active: motif.active !== false,
  ...overrides,
});

export async function moveCategoryMotifs(
  admin,
  sourceHandle,
  targetCategory,
  motifs = null,
) {
  const assignedMotifs =
    motifs ||
    (await listAllMetaobjects(
      admin,
      "motifs",
      `fields.category_handle:${sourceHandle}`,
    ));

  for (const motif of assignedMotifs) {
    await upsertMetaobject(admin, "motifs", motif.handle, {
      ...motifValues(motif),
      category: targetCategory.id,
      category_handle: targetCategory.handle,
    });
  }

  return assignedMotifs.length;
}

export function getLegacyCatalog() {
  return legacyCatalog;
}

export function legacyItemsFor(resource) {
  return legacyCatalog[resource] || [];
}

export async function getPublicBootstrap(admin) {
  const [categories, colors, fonts] = await Promise.all([
    listAllMetaobjects(admin, "categories"),
    listAllMetaobjects(admin, "colors"),
    listAllMetaobjects(admin, "fonts"),
  ]);

  if (!categories.length) {
    return {
      source: "legacy",
      categories: legacyCatalog.categories,
      colors: legacyCatalog.colors,
      fonts: legacyCatalog.fonts,
    };
  }

  return {
    source: "shopify",
    categories: sortCategoriesAlphabetically(
      categories.filter((item) => item.active !== false),
    ),
    colors: colors.filter((item) => item.active !== false),
    fonts: fonts.filter((item) => item.active !== false),
  };
}

export async function getPublicMotifs(admin, categoryHandle) {
  const categoryPage = await listMetaobjects(admin, "categories", {
    first: 1,
    query: `handle:${categoryHandle}`,
  });

  if (!categoryPage.items.length) {
    return {
      source: "legacy",
      motifs: legacyCatalog.motifs.filter(
        (item) => item.categoryHandle === categoryHandle && item.active,
      ),
    };
  }

  const motifs = await listAllMetaobjects(
    admin,
    "motifs",
    `fields.category_handle:${categoryHandle}`,
  );

  return {
    source: "shopify",
    motifs: motifs.filter((item) => item.active !== false),
  };
}

async function performLegacyBatch(
  admin,
  resource,
  offset = 0,
  batchSize = 25,
) {
  const source = legacyItemsFor(resource);
  const batch = source.slice(offset, offset + batchSize);
  let categoriesByHandle = null;

  if (resource === "motifs") {
    const categories = await listAllMetaobjects(admin, "categories");
    categoriesByHandle = new Map(
      categories.map((category) => [category.handle, category.id]),
    );
  }

  for (const [batchIndex, item] of batch.entries()) {
    try {
      if (resource === "categories") {
        await upsertMetaobject(
          admin,
          resource,
          item.handle,
          categoryValues(item),
        );
      }

      if (resource === "motifs") {
        let categoryId = categoriesByHandle.get(item.categoryHandle);
        if (!categoryId) {
          const legacyCategory = legacyCatalog.categories.find(
            (category) => category.handle === item.categoryHandle,
          );
          if (!legacyCategory) {
            throw new Error(`Kategorie ${item.categoryHandle} wurde nicht gefunden.`);
          }
          const category = await upsertMetaobject(
            admin,
            "categories",
            legacyCategory.handle,
            categoryValues(legacyCategory),
          );
          categoryId = category.id;
          categoriesByHandle.set(item.categoryHandle, categoryId);
        }
        await upsertMetaobject(admin, resource, item.handle, {
          name: item.name,
          slug: item.slug,
          category: categoryId,
          category_handle: item.categoryHandle,
          image_url: item.imageUrl,
          thumbnail_url: item.thumbnailUrl,
          original_filename:
            item.originalFilename || motifOriginalFilename(item),
          alt_text: item.altText,
          sort_order: item.sortOrder,
          active: item.active,
        });
      }

      if (resource === "colors") {
        await upsertMetaobject(admin, resource, item.handle, {
          name: item.name,
          slug: item.slug,
          hex_value: item.hexValue,
          usage: item.usage || "both",
          sort_order: item.sortOrder,
          active: item.active,
        });
      }

      if (resource === "fonts") {
        await upsertMetaobject(admin, resource, item.handle, {
          name: item.name,
          slug: item.slug,
          font_family: item.fontFamily,
          font_url: item.fontUrl,
          preview_text: item.previewText,
          scale: item.scale,
          sort_order: item.sortOrder,
          active: item.active,
        });
      }
    } catch (error) {
      const itemNumber = offset + batchIndex + 1;
      error.importOffset = offset + batchIndex;
      throw new Error(
        `Import bei Eintrag ${itemNumber} (${item.handle}) gestoppt: ${error.message}`,
        { cause: error },
      );
    }
  }

  const nextOffset = offset + batch.length;
  return {
    imported: batch.length,
    nextOffset: nextOffset < source.length ? nextOffset : null,
    total: source.length,
  };
}

export function importLegacyBatch(
  admin,
  resource,
  offset = 0,
  batchSize = 25,
) {
  const batchKey = `${resource}:${offset}:${batchSize}`;
  const activeBatch = activeImportBatches.get(batchKey);
  if (activeBatch) return activeBatch;

  const batch = performLegacyBatch(admin, resource, offset, batchSize);
  activeImportBatches.set(batchKey, batch);

  const releaseBatch = () => {
    setTimeout(() => {
      if (activeImportBatches.get(batchKey) === batch) {
        activeImportBatches.delete(batchKey);
      }
    }, 5000);
  };
  batch.then(releaseBatch, releaseBatch);

  return batch;
}
