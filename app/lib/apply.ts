import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export interface PendingChange {
  id: string;
  sku: string;
  variantGid: string | null;
  productGid: string | null;
  targetField: string;
  proposedValue: string | null;
}

export interface ApplyResult {
  applied: string[];
  failed: { id: string; error: string }[];
}

const VARIANTS_BULK_UPDATE = `#graphql
  mutation ApplyVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface VariantInput {
  id: string;
  price?: string;
  compareAtPrice?: string;
  barcode?: string;
  inventoryItem?: { cost: string };
}

/**
 * Applies changes, grouped by product.
 *
 * productVariantsBulkUpdate takes a product ID and a list of its variants,
 * so changes must be grouped rather than sent one at a time — the same
 * batching concern as everywhere else, and here it also avoids two requests
 * fighting over the same product.
 *
 * Inventory is deliberately excluded: it lives on InventoryLevel per
 * location, not on the variant, and writing it needs inventorySetQuantities
 * with an explicit location. That is a separate concern and a roadmap item.
 */
export async function applyChanges(
  admin: AdminApiContext,
  changes: PendingChange[],
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], failed: [] };

  const byProduct = new Map<string, PendingChange[]>();

  for (const change of changes) {
    if (!change.productGid || !change.variantGid) {
      result.failed.push({
        id: change.id,
        error: "change has no variant or product reference",
      });
      continue;
    }

    if (change.targetField === "inventory") {
      result.failed.push({
        id: change.id,
        error:
          "inventory writes require a location and are not yet implemented",
      });
      continue;
    }

    const existing = byProduct.get(change.productGid) ?? [];
    existing.push(change);
    byProduct.set(change.productGid, existing);
  }

  for (const [productGid, productChanges] of byProduct) {
    // One input per variant, merging every field being changed on it.
    const byVariant = new Map<string, VariantInput>();

    for (const change of productChanges) {
      const gid = change.variantGid!;
      const input = byVariant.get(gid) ?? { id: gid };
      const value = change.proposedValue ?? "";

      switch (change.targetField) {
        case "price":
          input.price = value;
          break;
        case "compareAtPrice":
          input.compareAtPrice = value;
          break;
        case "barcode":
          input.barcode = value;
          break;
        case "cost":
          input.inventoryItem = { cost: value };
          break;
        default:
          result.failed.push({
            id: change.id,
            error: `no write path for field ${change.targetField}`,
          });
          continue;
      }

      byVariant.set(gid, input);
    }

    if (byVariant.size === 0) continue;

    try {
      const response = await admin.graphql(VARIANTS_BULK_UPDATE, {
        variables: {
          productId: productGid,
          variants: [...byVariant.values()],
        },
      });

      const json = await response.json();
      const payload = json.data?.productVariantsBulkUpdate;

      /**
       * A rejected mutation returns HTTP 200 with userErrors populated.
       * Treating a 200 as success is how a failed write gets reported as
       * applied — the exact failure the Shopify template shipped with.
       */
      if (!payload || payload.userErrors.length > 0) {
        const message = JSON.stringify(payload?.userErrors ?? json);
        for (const change of productChanges) {
          result.failed.push({ id: change.id, error: message });
        }
        continue;
      }

      for (const change of productChanges) {
        result.applied.push(change.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const change of productChanges) {
        result.failed.push({ id: change.id, error: message });
      }
    }
  }

  return result;
}