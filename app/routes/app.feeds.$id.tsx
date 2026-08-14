import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TARGET_FIELDS, typeForField } from "../lib/coerce";
import { runShadow } from "../lib/shadow";
import { applyChanges } from "../lib/apply";
import { DEFAULT_POLICY } from "../lib/risk";
import { fireDangerousChange } from "../lib/flow";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const feed = await prisma.feedConnection.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      mappings: { orderBy: { createdAt: "asc" } },
      runs: { orderBy: { startedAt: "desc" }, take: 1 },
      riskPolicy: true,
      shadowRuns: {
        orderBy: { startedAt: "desc" },
        take: 1,
        include: { changes: { take: 200 } },
      },
    },
  });

  if (!feed) {
    throw new Response("Feed not found", { status: 404 });
  }

  const columns = feed.runs[0]?.columnNames?.split(",") ?? [];

  return { feed, columns, defaults: DEFAULT_POLICY };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

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

    try {
      await prisma.fieldMapping.create({
        data: {
          feedId: feed.id,
          sourceColumn,
          targetField,
          owner,
          dataType: typeForField(targetField),
        },
      });
    } catch {
      return {
        error: `${targetField} is already mapped. Remove the existing mapping first.`,
      };
    }

    return { mapped: true };
  }

  if (intent === "unmap") {
    await prisma.fieldMapping.deleteMany({
      where: { id: String(formData.get("mappingId")), feedId: feed.id },
    });
    return { unmapped: true };
  }

  if (intent === "toggleOwner") {
    const mapping = await prisma.fieldMapping.findFirst({
      where: { id: String(formData.get("mappingId")), feedId: feed.id },
    });

    if (!mapping) return { error: "Mapping not found." };

    await prisma.fieldMapping.update({
      where: { id: mapping.id },
      data: { owner: mapping.owner === "supplier" ? "merchant" : "supplier" },
    });

    return { toggled: true };
  }

  if (intent === "policy") {
    const values = {
      priceChangePercent: Number(formData.get("priceChangePercent")),
      inventoryDropPercent: Number(formData.get("inventoryDropPercent")),
      blockRunAbovePercent: Number(formData.get("blockRunAbovePercent")),
      flagZeroInventory: formData.get("flagZeroInventory") === "on",
    };

    if (
      !Number.isInteger(values.priceChangePercent) ||
      values.priceChangePercent < 1
    ) {
      return { error: "Price threshold must be a positive whole number." };
    }

    await prisma.riskPolicy.upsert({
      where: { feedId: feed.id },
      create: { feedId: feed.id, ...values },
      update: values,
    });

    return { policySaved: true };
  }

  if (intent === "shadow") {
    const mappings = await prisma.fieldMapping.findMany({
      where: { feedId: feed.id },
    });

    if (mappings.length === 0) {
      return {
        error: "Map at least the SKU column before running shadow mode.",
      };
    }

    const stored = await prisma.riskPolicy.findUnique({
      where: { feedId: feed.id },
    });

    const policy = stored ?? DEFAULT_POLICY;

    const shadowRun = await prisma.shadowRun.create({
      data: { feedId: feed.id, shop: session.shop },
    });

    try {
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Feed returned ${response.status}`);
      }

      const result = await runShadow(
        admin,
        await response.text(),
        mappings,
        policy,
      );

      await prisma.shadowChange.createMany({
        data: result.changes.map((c) => ({
          shadowRunId: shadowRun.id,
          sku: c.sku,
          variantGid: c.variantGid,
          productGid: c.productGid,
          targetField: c.targetField,
          currentValue: c.currentValue,
          proposedValue: c.proposedValue,
          verdict: c.verdict,
          risk: c.risk,
          riskReason: c.riskReason,
          note: c.note,
        })),
      });

      await prisma.shadowRun.update({
        where: { id: shadowRun.id },
        data: {
          status: "completed",
          rowsInFeed: result.rowsInFeed,
          rowsMatched: result.rowsMatched,
          rowsUnmatched: result.rowsUnmatched,
          rowsAmbiguous: result.rowsAmbiguous,
          rowsInvalid: result.rowsInvalid,
          fieldsChanged: result.fieldsChanged,
          fieldsUnchanged: result.fieldsUnchanged,
          fieldsBlocked: result.fieldsBlocked,
          fieldsSafe: result.fieldsSafe,
          fieldsReview: result.fieldsReview,
          fieldsHigh: result.fieldsHigh,
          runBlocked: result.runBlocked,
          blockReason: result.blockReason,
          finishedAt: new Date(),
        },
      });

      /**
       * Fire the Flow trigger only when there is something worth reacting to.
       * A trigger that fires on every run trains merchants to ignore it,
       * which is worse than not having one at all.
       */
      let flowFired = false;
      let flowError: string | null = null;

      if (result.fieldsHigh > 0 || result.runBlocked) {
        const worst =
          result.changes.find((c) => c.risk === "high" && c.riskReason)
            ?.riskReason ?? "high-risk changes detected";

        const fired = await fireDangerousChange(admin, {
          feedName: feed.name,
          highRiskCount: result.fieldsHigh,
          reviewCount: result.fieldsReview,
          matchedRows: result.rowsMatched,
          runBlocked: result.runBlocked,
          topReason: result.blockReason ?? worst,
        });

        flowFired = fired.ok;
        flowError = fired.error;
      }

      return { shadowComplete: true, flowFired, flowError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await prisma.shadowRun.update({
        where: { id: shadowRun.id },
        data: { status: "failed", error: message, finishedAt: new Date() },
      });

      return { error: message };
    }
  }

  if (intent === "apply") {
    const shadowRunId = String(formData.get("shadowRunId"));
    const includeRisky = formData.get("includeRisky") === "yes";
    const override = String(formData.get("override") ?? "").trim();

    const shadowRun = await prisma.shadowRun.findFirst({
      where: { id: shadowRunId, shop: session.shop },
      include: { changes: true },
    });

    if (!shadowRun) return { error: "Shadow run not found." };

    if (shadowRun.appliedAt) {
      return { error: "This run has already been applied." };
    }

    /**
     * The circuit breaker gates risky changes, not everything.
     *
     * A blocked run means the feed looks broken overall, but a change the
     * policy graded as safe is still safe — refusing it as well would train
     * merchants to reach for the override, which is the opposite of what a
     * breaker is for.
     */
    if (shadowRun.runBlocked && includeRisky) {
      if (override !== String(shadowRun.rowsMatched)) {
        return {
          error: `This run is blocked. To override and apply risky changes, type ${shadowRun.rowsMatched} in the confirmation field.`,
        };
      }
    }

    const eligible = shadowRun.changes.filter((c) => {
      if (c.verdict !== "changed") return false;
      if (c.appliedAt) return false;
      if (includeRisky) return true;
      return c.risk === "safe";
    });

    if (eligible.length === 0) {
      return { error: "No eligible changes to apply." };
    }

    const result = await applyChanges(
      admin,
      eligible.map((c) => ({
        id: c.id,
        sku: c.sku,
        variantGid: c.variantGid,
        productGid: c.productGid,
        targetField: c.targetField,
        proposedValue: c.proposedValue,
      })),
    );

    if (result.applied.length > 0) {
      await prisma.shadowChange.updateMany({
        where: { id: { in: result.applied } },
        data: { appliedAt: new Date() },
      });
    }

    await prisma.shadowRun.update({
      where: { id: shadowRun.id },
      data: {
        status: "applied",
        appliedAt: new Date(),
        appliedCount: result.applied.length,
        applyError:
          result.failed.length > 0
            ? JSON.stringify(result.failed.slice(0, 5))
            : null,
      },
    });

    return {
      applied: result.applied.length,
      failed: result.failed.length,
      firstError: result.failed[0]?.error ?? null,
    };
  }

  return { error: `Unknown intent: ${intent}` };
};

export default function FeedMapping() {
  const { feed, columns, defaults } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isBusy = fetcher.state !== "idle";
  const mappedTargets = new Set(feed.mappings.map((m) => m.targetField));
  const availableTargets = TARGET_FIELDS.filter(
    (f) => !mappedTargets.has(f.value),
  );

  const policy = feed.riskPolicy ?? defaults;
  const lastShadow = feed.shadowRuns[0];

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

        {fetcher.data &&
          "flowFired" in fetcher.data &&
          fetcher.data.flowFired && (
            <s-banner tone="info" heading="Flow notified">
              <s-paragraph>
                A &quot;dangerous change detected&quot; event was sent to Shopify Flow.
              </s-paragraph>
            </s-banner>
          )}

        {fetcher.data &&
          "flowError" in fetcher.data &&
          fetcher.data.flowError && (
            <s-banner tone="warning" heading="Flow trigger failed">
              <s-paragraph>{fetcher.data.flowError}</s-paragraph>
            </s-banner>
          )}

        {fetcher.data &&
          "applied" in fetcher.data &&
          typeof fetcher.data.applied === "number" && (
            <s-banner
              tone={(fetcher.data.failed ?? 0) > 0 ? "warning" : "success"}
              heading="Apply complete"
            >
              <s-paragraph>
                {fetcher.data.applied} change(s) written,{" "}
                {fetcher.data.failed ?? 0} failed.
                {fetcher.data.firstError
                  ? ` First error: ${fetcher.data.firstError}`
                  : ""}
              </s-paragraph>
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
                      <input
                        type="hidden"
                        name="mappingId"
                        value={mapping.id}
                      />
                      <s-button type="submit">
                        Switch to{" "}
                        {mapping.owner === "supplier" ? "merchant" : "supplier"}
                      </s-button>
                    </fetcher.Form>

                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="unmap" />
                      <input
                        type="hidden"
                        name="mappingId"
                        value={mapping.id}
                      />
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

      <s-section heading="Risk policy">
        <s-paragraph>
          Threshold rules, not anomaly detection. A change beyond a threshold
          needs review; a change beyond double it is high risk.
        </s-paragraph>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="policy" />

          <s-stack direction="block" gap="base">
            <s-text-field
              label="Price change threshold (%)"
              name="priceChangePercent"
              value={String(policy.priceChangePercent)}
            />
            <s-text-field
              label="Inventory drop threshold (%)"
              name="inventoryDropPercent"
              value={String(policy.inventoryDropPercent)}
            />
            <s-text-field
              label="Block run above this share of high-risk rows (%)"
              name="blockRunAbovePercent"
              value={String(policy.blockRunAbovePercent)}
            />
            <s-checkbox
              name="flagZeroInventory"
              label="Flag any drop to zero stock as high risk"
              checked={policy.flagZeroInventory}
            />

            <s-button type="submit" loading={isBusy}>
              Save policy
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {feed.mappings.length > 0 && (
        <s-section heading="Shadow mode">
          <s-paragraph>
            Compares the feed against your catalogue and reports what would
            change. Nothing is written.
          </s-paragraph>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="shadow" />
            <s-button type="submit" variant="primary" loading={isBusy}>
              Run shadow mode
            </s-button>
          </fetcher.Form>
        </s-section>
      )}

      {lastShadow && (
        <s-section heading="Last shadow run">
          {lastShadow.runBlocked && (
            <s-banner tone="critical" heading="Run blocked">
              <s-paragraph>{lastShadow.blockReason}</s-paragraph>
            </s-banner>
          )}

          <s-stack direction="block" gap="small-200">
            <s-text>
              {lastShadow.rowsInFeed} rows — {lastShadow.rowsMatched} matched,{" "}
              {lastShadow.rowsUnmatched} unmatched, {lastShadow.rowsAmbiguous}{" "}
              ambiguous, {lastShadow.rowsInvalid} invalid
            </s-text>
            <s-text>
              {lastShadow.fieldsChanged} would change — {lastShadow.fieldsSafe}{" "}
              safe, {lastShadow.fieldsReview} review, {lastShadow.fieldsHigh}{" "}
              high risk. {lastShadow.fieldsBlocked} blocked by ownership.
            </s-text>

            {lastShadow.appliedAt && (
              <s-text tone="success">
                Applied {lastShadow.appliedCount} change(s) at{" "}
                {new Date(lastShadow.appliedAt).toLocaleString()}
              </s-text>
            )}

            {lastShadow.error && (
              <s-text tone="critical">{lastShadow.error}</s-text>
            )}
          </s-stack>

          {!lastShadow.appliedAt && lastShadow.fieldsChanged > 0 && (
            <s-stack direction="block" gap="base">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="apply" />
                <input type="hidden" name="shadowRunId" value={lastShadow.id} />
                <input type="hidden" name="includeRisky" value="no" />
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Apply {lastShadow.fieldsSafe} safe change(s)
                </s-button>
              </fetcher.Form>

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="apply" />
                <input type="hidden" name="shadowRunId" value={lastShadow.id} />
                <input type="hidden" name="includeRisky" value="yes" />

                {lastShadow.runBlocked && (
                  <s-text-field
                    label={`Type ${lastShadow.rowsMatched} to override the block`}
                    name="override"
                  />
                )}

                <s-button type="submit" tone="critical" loading={isBusy}>
                  Apply all {lastShadow.fieldsChanged} change(s), including
                  risky
                </s-button>
              </fetcher.Form>
            </s-stack>
          )}

          {lastShadow.changes.length > 0 && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <pre style={{ margin: 0, overflow: "auto" }}>
                <code>
                  {lastShadow.changes
                    .map(
                      (c) =>
                        `${c.risk.padEnd(7)} ${c.verdict.padEnd(10)} ${c.sku.padEnd(14)} ${c.targetField.padEnd(14)} ${c.currentValue ?? "—"} → ${c.proposedValue ?? "—"}${c.riskReason ? `  (${c.riskReason})` : c.note ? `  (${c.note})` : ""}`,
                    )
                    .join("\n")}
                </code>
              </pre>
            </s-box>
          )}
        </s-section>
      )}
    </s-page>
  );
}