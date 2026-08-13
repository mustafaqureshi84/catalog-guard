import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TARGET_FIELDS, typeForField } from "../lib/coerce";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  console.log("[feeds.$id] loader start — id:", params.id, "shop:", session.shop);

  const feed = await prisma.feedConnection.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      mappings: { orderBy: { createdAt: "asc" } },
      runs: { orderBy: { startedAt: "desc" }, take: 1 },
    },
  });

  console.log("[feeds.$id] feed:", feed ? feed.name : "NOT FOUND");

  if (!feed) {
    throw new Response("Feed not found", { status: 404 });
  }

  const columns = feed.runs[0]?.columnNames?.split(",") ?? [];

  console.log("[feeds.$id] columns:", columns);

  return { feed, columns };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const feed = await prisma.feedConnection.findFirst({
    where: { id: params.id, shop: session.shop },
  });

  if (!feed) {
    return { error: "Feed not found." };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "map") {
    const sourceColumn = String(formData.get("sourceColumn") ?? "").trim();
    const targetField = String(formData.get("targetField") ?? "").trim();
    const owner = String(formData.get("owner") ?? "supplier");

    if (!sourceColumn || !targetField) {
      return { error: "Column and target field are both required." };
    }

    const dataType = typeForField(targetField);

    try {
      await prisma.fieldMapping.create({
        data: { feedId: feed.id, sourceColumn, targetField, owner, dataType },
      });
    } catch {
      // The unique constraint on (feedId, targetField) rejects a second
      // column claiming the same Shopify field.
      return {
        error: `${targetField} is already mapped. Remove the existing mapping first.`,
      };
    }

    return { mapped: true };
  }

  if (intent === "unmap") {
    const mappingId = String(formData.get("mappingId"));

    await prisma.fieldMapping.deleteMany({
      where: { id: mappingId, feedId: feed.id },
    });

    return { unmapped: true };
  }

  if (intent === "toggleOwner") {
    const mappingId = String(formData.get("mappingId"));

    const mapping = await prisma.fieldMapping.findFirst({
      where: { id: mappingId, feedId: feed.id },
    });

    if (!mapping) return { error: "Mapping not found." };

    await prisma.fieldMapping.update({
      where: { id: mapping.id },
      data: { owner: mapping.owner === "supplier" ? "merchant" : "supplier" },
    });

    return { toggled: true };
  }

  return { error: `Unknown intent: ${intent}` };
};

export default function FeedMapping() {
  const { feed, columns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isBusy = fetcher.state !== "idle";
  const mappedTargets = new Set(feed.mappings.map((m) => m.targetField));
  const availableTargets = TARGET_FIELDS.filter(
    (f) => !mappedTargets.has(f.value),
  );

  return (
    <s-page>
      <s-section heading={feed.name}>
        <s-paragraph>{feed.url}</s-paragraph>

        {columns.length === 0 ? (
          <s-banner tone="warning" heading="No columns detected">
            <s-paragraph>
              Fetch this feed first so its columns can be read.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-text>Detected columns: {columns.join(", ")}</s-text>
        )}

        {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
          <s-banner tone="critical" heading="Error">
            <s-paragraph>{fetcher.data.error}</s-paragraph>
          </s-banner>
        )}
      </s-section>

      {columns.length > 0 && availableTargets.length > 0 && (
        <s-section heading="Add a mapping">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="map" />

            <s-stack direction="block" gap="base">
              <s-select label="Supplier column" name="sourceColumn">
                {columns.map((col) => (
                  <s-option key={col} value={col}>
                    {col}
                  </s-option>
                ))}
              </s-select>

              <s-select label="Shopify field" name="targetField">
                {availableTargets.map((field) => (
                  <s-option key={field.value} value={field.value}>
                    {field.label}
                  </s-option>
                ))}
              </s-select>

              <s-select label="Who owns this field?" name="owner">
                <s-option value="supplier">
                  Supplier — the feed may update it
                </s-option>
                <s-option value="merchant">
                  Merchant — never write this field
                </s-option>
              </s-select>

              <s-button type="submit" variant="primary" loading={isBusy}>
                Add mapping
              </s-button>
            </s-stack>
          </fetcher.Form>
        </s-section>
      )}

      {feed.mappings.length > 0 && (
        <s-section heading={`Mappings (${feed.mappings.length})`}>
          <s-stack direction="block" gap="base">
            {feed.mappings.map((mapping) => (
              <s-box
                key={mapping.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-200">
                  <s-text>
                    <strong>{mapping.sourceColumn}</strong> →{" "}
                    {TARGET_FIELDS.find((f) => f.value === mapping.targetField)
                      ?.label ?? mapping.targetField}{" "}
                    ({mapping.dataType})
                  </s-text>

                  <s-text
                    tone={mapping.owner === "merchant" ? "critical" : undefined}
                  >
                    Owner: {mapping.owner}
                    {mapping.owner === "merchant" && " — never written"}
                  </s-text>

                  <s-stack direction="inline" gap="small-200">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="toggleOwner" />
                      <input type="hidden" name="mappingId" value={mapping.id} />
                      <s-button type="submit">
                        Switch to{" "}
                        {mapping.owner === "supplier" ? "merchant" : "supplier"}
                      </s-button>
                    </fetcher.Form>

                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="unmap" />
                      <input type="hidden" name="mappingId" value={mapping.id} />
                      <s-button type="submit" tone="critical">
                        Remove
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}