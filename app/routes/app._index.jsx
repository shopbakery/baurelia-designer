import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  deleteMetaobject,
  getLegacyCatalog,
  listAllMetaobjects,
} from "../lib/customizer-data.server";
import {
  findImportDuplicates,
  selectImportDuplicates,
} from "../lib/import-duplicates";

const unreferencedCategoryDuplicates = (categories, motifs, legacyCategories) => {
  const referencedHandles = new Set(motifs.map((motif) => motif.category_handle));
  const referencedIds = new Set(motifs.map((motif) => motif.category));
  const categoriesByHandle = new Map(
    categories.map((category) => [category.handle, category]),
  );

  return findImportDuplicates(categories, legacyCategories, "categories").filter(
    (handle) => {
      const category = categoriesByHandle.get(handle);
      return !referencedHandles.has(handle) && !referencedIds.has(category.id);
    },
  );
};

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const [categories, motifs, colors, fonts] = await Promise.all([
    listAllMetaobjects(admin, "categories"),
    listAllMetaobjects(admin, "motifs"),
    listAllMetaobjects(admin, "colors"),
    listAllMetaobjects(admin, "fonts"),
  ]);
  const catalog = getLegacyCatalog();

  return {
    totals: {
      categories: categories.length,
      motifs: motifs.length,
      colors: colors.length,
      fonts: fonts.length,
    },
    importDuplicates: {
      categories: unreferencedCategoryDuplicates(
        categories,
        motifs,
        catalog.categories,
      ),
      motifs: findImportDuplicates(motifs, catalog.motifs, "motifs"),
    },
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "cleanup-import-duplicates") {
    return Response.json({ error: "Ungültige Aktion." }, { status: 400 });
  }

  const deletedHandles = [];
  try {
    const catalog = getLegacyCatalog();
    const itemsByResource = {
      categories: await listAllMetaobjects(admin, "categories"),
      motifs: await listAllMetaobjects(admin, "motifs"),
    };
    const current = {
      categories: unreferencedCategoryDuplicates(
        itemsByResource.categories,
        itemsByResource.motifs,
        catalog.categories,
      ),
      motifs: findImportDuplicates(
        itemsByResource.motifs,
        catalog.motifs,
        "motifs",
      ),
    };
    const submitted = JSON.parse(String(formData.get("duplicates") || "null"));
    const selected = selectImportDuplicates(submitted, current);
    for (const resource of ["categories", "motifs"]) {
      for (const handle of selected[resource]) {
        const item = itemsByResource[resource].find(
          (candidate) => candidate.handle === handle,
        );
        const deletedId = await deleteMetaobject(admin, item.id);
        if (deletedId !== item.id) {
          throw new Error(`Shopify hat die Löschung von ${handle} nicht bestätigt.`);
        }
        deletedHandles.push(handle);
      }
    }

    return {
      ok: true,
      deletedHandles,
      message: `${deletedHandles.length} Import-Duplikate gelöscht.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Die Bereinigung ist fehlgeschlagen.";
    return Response.json(
      {
        error: deletedHandles.length
          ? `${deletedHandles.length} Einträge wurden gelöscht; danach trat ein Fehler auf: ${detail}`
          : detail,
      },
      { status: 400 },
    );
  }
};

const cards = [
  {
    resource: "categories",
    title: "Motivkategorien",
    description: "Kategorien anlegen, sortieren und ausblenden.",
    href: "/app/categories",
  },
  {
    resource: "motifs",
    title: "Motive",
    description: "R2-Bildadressen und Zuordnung zu Kategorien verwalten.",
    href: "/app/motifs",
  },
  {
    resource: "colors",
    title: "Farben",
    description: "Farbnamen, HEX-Werte und Reihenfolge pflegen.",
    href: "/app/colors",
  },
  {
    resource: "fonts",
    title: "Schriften",
    description: "Schriftdateien, Vorschau und Größenfaktor verwalten.",
    href: "/app/fonts",
  },
];

export default function Index() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const duplicateHandles = [
    ...loaderData.importDuplicates.categories,
    ...loaderData.importDuplicates.motifs,
  ];
  return (
    <s-page heading="Baurelia Designer">
      {duplicateHandles.length > 0 && (
        <s-banner heading="Mögliche Import-Duplikate erkannt" tone="warning">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {duplicateHandles.length} zusätzliche Metaobjekte: {duplicateHandles.join(", ")}
            </s-paragraph>
            <s-paragraph>
              Prüfe die Handles vor dem Löschen: Es handelt sich um gleiche Slugs
              in derselben Kategorie. R2-Dateien werden dabei nicht gelöscht.
            </s-paragraph>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="cleanup-import-duplicates"
              />
              <input
                type="hidden"
                name="duplicates"
                value={JSON.stringify(loaderData.importDuplicates)}
              />
              <s-button
                type="submit"
                tone="critical"
                loading={navigation.state !== "idle"}
              >
                Genau diese {duplicateHandles.length} Duplikate löschen
              </s-button>
            </Form>
          </s-stack>
        </s-banner>
      )}

      {actionData?.error && (
        <s-banner heading="Bereinigung fehlgeschlagen" tone="critical">
          {actionData.error}
        </s-banner>
      )}

      {actionData?.ok && (
        <s-banner heading="Bereinigung abgeschlossen" tone="success">
          {actionData.message}
        </s-banner>
      )}

      <s-section heading="Customizer-Inhalte">
        <s-paragraph>
          Hier verwaltest du alle Inhalte, die im Produkt-Customizer angezeigt
          werden. Änderungen werden in Shopify-Metaobjekten gespeichert.
        </s-paragraph>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {cards.map((card) => (
            <s-box
              key={card.resource}
              padding="base"
              background="subdued"
              border="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="base">
                <s-heading>{card.title}</s-heading>
                <s-text type="strong">
                  {loaderData.totals[card.resource]} vorhandene Einträge
                </s-text>
                <s-paragraph>{card.description}</s-paragraph>
                <Link to={card.href}>
                  Verwalten
                </Link>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Status">
        <s-stack direction="block" gap="base">
          <s-badge tone="success">App verbunden</s-badge>
          <s-paragraph>
            Die angezeigten Zahlen werden direkt aus den Shopify-Metaobjekten
            geladen.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}
