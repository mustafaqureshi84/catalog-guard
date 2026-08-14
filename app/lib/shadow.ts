import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import Papa from "papaparse";
import { coerce, type DataType } from "./coerce";
import {
  assessRisk,
  assessRun,
  type RiskLevel,
  type RiskPolicySpec,
} from "./risk";

export interface MappingSpec {
  sourceColumn: string;
  targetField: string;
  owner: string;
  dataType: string;
}

export interface ChangeRecord {
  sku: string;
  variantGid: string | null;
  productGid: string | null;
  targetField: string;
  currentValue: string | null;
  proposedValue: string | null;
  verdict:
    | "changed"
    | "unchanged"
    | "blocked"
    | "unmatched"
    | "ambiguous"
    | "invalid";
  risk: RiskLevel;
  riskReason: string | null;
  note: string | null;
}

export interface ShadowResult {
  rowsInFeed: number;
  rowsMatched: number;
  rowsUnmatched: number;
  rowsAmbiguous: number;
  rowsInvalid: number;
  fieldsChanged: number;
  fieldsUnchanged: number;
  fieldsBlocked: number;
  fieldsSafe: number;
  fieldsReview: number;
  fieldsHigh: number;
  runBlocked: boolean;
  blockReason: string | null;
  changes: ChangeRecord[];
}

interface VariantMatch {
  variantGid: string;
  productGid: string;
  price: string | null;
  compareAtPrice: string | null;
  cost: string | null;
  inventory: number | null;
  barcode: string | null;
}

const VARIANTS_BY_SKU = `#graphql
  query VariantsBySku($query: String!) {
    productVariants(first: 50, query: $query) {
      nodes {
        id
        sku
        price
        compareAtPrice
        barcode
        inventoryQuantity
        inventoryItem {
          unitCost { amount }
        }
        product { id }
      }
    }
  }
`;

/**
 * Looks up variants by SKU in batches.
 *
 * Shopify's search syntax allows OR-ing terms, so one query covers many SKUs
 * rather than one request each.
 */
async function fetchVariantsBySku(
  admin: AdminApiContext,
  skus: string[],
): Promise<Map<string, VariantMatch[]>> {
  const bySku = new Map<string, VariantMatch[]>();
  const BATCH = 20;

  for (let i = 0; i < skus.length; i += BATCH) {
    const batch = skus.slice(i, i + BATCH);
    const query = batch.map((s) => `sku:'${s}'`).join(" OR ");

    const response = await admin.graphql(VARIANTS_BY_SKU, {
      variables: { query },
    });

    const json = await response.json();
    const nodes = json.data?.productVariants?.nodes ?? [];

    for (const node of nodes) {
      if (!node.sku) continue;

      const existing = bySku.get(node.sku) ?? [];

      existing.push({
        variantGid: node.id,
        productGid: node.product.id,
        price: node.price ?? null,
        compareAtPrice: node.compareAtPrice ?? null,
        cost: node.inventoryItem?.unitCost?.amount ?? null,
        inventory: node.inventoryQuantity ?? null,
        barcode: node.barcode ?? null,
      });

      bySku.set(node.sku, existing);
    }
  }

  return bySku;
}

function currentValueFor(
  variant: VariantMatch,
  targetField: string,
): string | null {
  switch (targetField) {
    case "price":
      return variant.price;
    case "compareAtPrice":
      return variant.compareAtPrice;
    case "cost":
      return variant.cost;
    case "inventory":
      return variant.inventory === null ? null : String(variant.inventory);
    case "barcode":
      return variant.barcode;
    case "sku":
      return null; // SKU is the match key, never a target for change.
    default:
      return null;
  }
}

/**
 * Compares two values as the type they will be written as.
 *
 * "89.99" and "89.9900" are the same price, and a string comparison would
 * call them different — producing a change that writes nothing and a diff
 * full of noise the merchant learns to ignore.
 */
function valuesMatch(
  current: string | null,
  proposed: string | number,
  dataType: DataType,
): boolean {
  if (current === null) return false;

  if (dataType === "string") {
    return current.trim() === String(proposed).trim();
  }

  return Number(current) === Number(proposed);
}

export async function runShadow(
  admin: AdminApiContext,
  csvText: string,
  mappings: MappingSpec[],
  policy: RiskPolicySpec,
): Promise<ShadowResult> {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  const rows = parsed.data;

  const skuMapping = mappings.find((m) => m.targetField === "sku");

  if (!skuMapping) {
    throw new Error(
      "No column is mapped to Variant SKU. Rows cannot be matched to products without it.",
    );
  }

  // Fields the feed is actually allowed to write.
  const writable = mappings.filter(
    (m) => m.targetField !== "sku" && m.owner === "supplier",
  );

  const blocked = mappings.filter(
    (m) => m.targetField !== "sku" && m.owner === "merchant",
  );

  const skus = rows
    .map((r) => r[skuMapping.sourceColumn]?.trim())
    .filter((s): s is string => Boolean(s));

  const bySku = await fetchVariantsBySku(admin, [...new Set(skus)]);

  const changes: ChangeRecord[] = [];
  const result: ShadowResult = {
    rowsInFeed: rows.length,
    rowsMatched: 0,
    rowsUnmatched: 0,
    rowsAmbiguous: 0,
    rowsInvalid: 0,
    fieldsChanged: 0,
    fieldsUnchanged: 0,
    fieldsBlocked: 0,
    fieldsSafe: 0,
    fieldsReview: 0,
    fieldsHigh: 0,
    runBlocked: false,
    blockReason: null,
    changes,
  };

  for (const row of rows) {
    const sku = row[skuMapping.sourceColumn]?.trim() ?? "";

    if (!sku) {
      result.rowsInvalid += 1;
      changes.push({
        sku: "(blank)",
        variantGid: null,
        productGid: null,
        targetField: "sku",
        currentValue: null,
        proposedValue: null,
        verdict: "invalid",
        risk: "safe",
        riskReason: null,
        note: "row has no SKU value",
      });
      continue;
    }

    const matches = bySku.get(sku) ?? [];

    if (matches.length === 0) {
      result.rowsUnmatched += 1;
      changes.push({
        sku,
        variantGid: null,
        productGid: null,
        targetField: "sku",
        currentValue: null,
        proposedValue: null,
        verdict: "unmatched",
        risk: "safe",
        riskReason: null,
        note: "no variant in this store has this SKU",
      });
      continue;
    }

    /**
     * Shopify does not enforce SKU uniqueness, so one SKU matching several
     * variants is a real case. Applying to all of them is unrecoverable if
     * wrong — two variants would hold a bad value with nothing recording
     * which was intended. Skipping costs one manual fix and loses nothing.
     */
    if (matches.length > 1) {
      result.rowsAmbiguous += 1;
      changes.push({
        sku,
        variantGid: null,
        productGid: null,
        targetField: "sku",
        currentValue: null,
        proposedValue: null,
        verdict: "ambiguous",
        risk: "safe",
        riskReason: null,
        note: `${matches.length} variants share this SKU — skipped`,
      });
      continue;
    }

    const variant = matches[0];
    result.rowsMatched += 1;

    // Record what ownership refused, so the lock is visible in the diff
    // rather than silently absent from it.
    for (const mapping of blocked) {
      const raw = row[mapping.sourceColumn];
      if (raw === undefined) continue;

      result.fieldsBlocked += 1;
      changes.push({
        sku,
        variantGid: variant.variantGid,
        productGid: variant.productGid,
        targetField: mapping.targetField,
        currentValue: currentValueFor(variant, mapping.targetField),
        proposedValue: raw.trim(),
        verdict: "blocked",
        risk: "safe",
        riskReason: null,
        note: "merchant owns this field — the feed may not write it",
      });
    }

    for (const mapping of writable) {
      const raw = row[mapping.sourceColumn];

      if (raw === undefined) continue;

      const coerced = coerce(raw, mapping.dataType as DataType);

      if (!coerced.ok) {
        result.rowsInvalid += 1;
        changes.push({
          sku,
          variantGid: variant.variantGid,
          productGid: variant.productGid,
          targetField: mapping.targetField,
          currentValue: currentValueFor(variant, mapping.targetField),
          proposedValue: raw.trim(),
          verdict: "invalid",
          risk: "safe",
          riskReason: null,
          note: coerced.error ?? "value could not be coerced",
        });
        continue;
      }

      const current = currentValueFor(variant, mapping.targetField);
      const proposed = coerced.value!;

      if (valuesMatch(current, proposed, mapping.dataType as DataType)) {
        result.fieldsUnchanged += 1;
        changes.push({
          sku,
          variantGid: variant.variantGid,
          productGid: variant.productGid,
          targetField: mapping.targetField,
          currentValue: current,
          proposedValue: String(proposed),
          verdict: "unchanged",
          risk: "safe",
          riskReason: null,
          note: null,
        });
        continue;
      }

      const assessment = assessRisk(
        mapping.targetField,
        current,
        String(proposed),
        policy,
      );

      result.fieldsChanged += 1;

      if (assessment.risk === "high") result.fieldsHigh += 1;
      else if (assessment.risk === "review") result.fieldsReview += 1;
      else result.fieldsSafe += 1;

      changes.push({
        sku,
        variantGid: variant.variantGid,
        productGid: variant.productGid,
        targetField: mapping.targetField,
        currentValue: current,
        proposedValue: String(proposed),
        verdict: "changed",
        risk: assessment.risk,
        riskReason: assessment.reason,
        note: null,
      });
    }
  }

  const breaker = assessRun(result.fieldsHigh, result.rowsMatched, policy);
  result.runBlocked = breaker.blocked;
  result.blockReason = breaker.reason;

  return result;
}