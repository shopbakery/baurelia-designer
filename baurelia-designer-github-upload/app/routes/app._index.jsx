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

const SAFE_IMPORT_DUPLICATES = {
  categories: new Set(["fussball-1"]),
  motifs: new Set([
    "auto-2-1",
    "auto-21-1",
    "auto-54-1",
    "bagger-17-1",
    "bagger-18-1",
    "einhorn-21-1",
    "einhorn-55-1",
  ]),
};

const findImportDuplicates = (items, legacyItems) => {
  const expectedHandles = new Set(legacyItems.map((item) => item.handle));
  const expectedSlugs = new Set(legacyItems.map((item) => item.slug));

  return items
    .filter(
      (item) =>
        !expectedHandles.has(item.handle) && expectedSlugs.has(item.slug),
    )
    .map((item) => item.handle);
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
      categories: findImportDuplicates(categories, catalog.categories),
      motifs: findImportDuplicates(motifs, catalog.motifs),
    },
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "cleanup-import-duplicates") {
    return Response.json({ error: "Ungültige Aktion." }, { status: 400 });
  }

  const catalog = getLegacyCatalog();
  const deletedHandles = [];

  for (const resource of ["categories", "motifs"]) {
    const items = await listAllMetaobjects(admin, resource);
    const candidates = findImportDuplicates(items, catalog[resource]).filter(
      (handle) => SAFE_IMPORT_DUPLICATES[resource].has(handle),
    );

    for (const handle of candidates) {
      const item = items.find((candidate) => candidate.handle === handle);
      if (!item) continue;
      await deleteMetaobject(admin, item.id);
      deletedHandles.push(handle);
    }
  }

  return {
    ok: true,
    deletedHandles,
    message: `${deletedHandles.length} Import-Duplikate gelöscht.`,
  };
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
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="cleanup-import-duplicates"
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

      {actionData?.message && (
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
