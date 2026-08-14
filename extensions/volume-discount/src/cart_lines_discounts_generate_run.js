import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/** Used when a merchant has not configured tiers, or the config is unusable. */
const DEFAULT_TIERS = [
  { minQuantity: 10, percentage: 20 },
  { minQuantity: 5, percentage: 10 },
  { minQuantity: 3, percentage: 5 },
];

/**
 * Reads tiers from the discount's metafield.
 *
 * A function has no network access, so configuration arrives in the input or
 * not at all. It also cannot report an error to anyone — throwing at checkout
 * would fail a customer's cart. So a malformed config falls back to defaults
 * rather than breaking the purchase.
 *
 * @param {RunInput} input
 */
function tiersFrom(input) {
  const raw = input.discount.metafield?.value;

  if (!raw) return DEFAULT_TIERS;

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed?.tiers) || parsed.tiers.length === 0) {
      return DEFAULT_TIERS;
    }

    const valid = parsed.tiers.filter(
      (t) =>
        Number.isFinite(t?.minQuantity) &&
        Number.isFinite(t?.percentage) &&
        t.minQuantity > 0 &&
        t.percentage > 0 &&
        t.percentage <= 100,
    );

    if (valid.length === 0) return DEFAULT_TIERS;

    // Sort defensively: the first match wins, so a low quantity listed above
    // a high one would shadow it.
    return valid.sort((a, b) => b.minQuantity - a.minQuantity);
  } catch {
    return DEFAULT_TIERS;
  }
}

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  /**
   * A volume discount is meaningless at order level, so the function declines
   * rather than guessing at what the merchant meant.
   */
  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasProductDiscountClass) {
    return { operations: [] };
  }

  const tiers = tiersFrom(input);
  const candidates = [];

  for (const line of input.cart.lines) {
    const tier = tiers.find((t) => line.quantity >= t.minQuantity);

    if (!tier) continue;

    candidates.push({
      message: `${tier.percentage}% off ${tier.minQuantity}+`,
      targets: [{ cartLine: { id: line.id } }],
      value: { percentage: { value: tier.percentage } },
    });
  }

  if (candidates.length === 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          /**
           * Every candidate targets a different line, so they do not compete.
           * FIRST would apply one and silently drop the rest.
           */
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}