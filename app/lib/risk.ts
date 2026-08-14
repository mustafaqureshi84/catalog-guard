export type RiskLevel = "safe" | "review" | "high";

export interface RiskPolicySpec {
  priceChangePercent: number;
  inventoryDropPercent: number;
  flagZeroInventory: boolean;
  blockRunAbovePercent: number;
}

export const DEFAULT_POLICY: RiskPolicySpec = {
  priceChangePercent: 20,
  inventoryDropPercent: 90,
  flagZeroInventory: true,
  blockRunAbovePercent: 30,
};

export interface RiskVerdict {
  risk: RiskLevel;
  reason: string | null;
}

function percentChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 100;
  return ((to - from) / from) * 100;
}

/**
 * Grades one proposed change.
 *
 * These are threshold rules, not anomaly detection. Anomaly detection needs
 * a baseline of what normal looks like for a given supplier, and a new
 * install has none. Rules are honest about what they are, and a merchant can
 * reason about "more than 20%" in a way they cannot about a model's opinion.
 */
export function assessRisk(
  targetField: string,
  currentValue: string | null,
  proposedValue: string,
  policy: RiskPolicySpec,
): RiskVerdict {
  // A field with no current value is being set for the first time. There is
  // no change to measure, so nothing to be suspicious of.
  if (currentValue === null) {
    return { risk: "safe", reason: null };
  }

  const current = Number(currentValue);
  const proposed = Number(proposedValue);

  if (!Number.isFinite(current) || !Number.isFinite(proposed)) {
    return { risk: "safe", reason: null };
  }

  if (targetField === "price" || targetField === "compareAtPrice") {
    const change = percentChange(current, proposed);
    const magnitude = Math.abs(change);

    if (magnitude >= policy.priceChangePercent * 2) {
      return {
        risk: "high",
        reason: `price ${change < 0 ? "drops" : "rises"} ${magnitude.toFixed(0)}% — more than double the ${policy.priceChangePercent}% threshold`,
      };
    }

    if (magnitude >= policy.priceChangePercent) {
      return {
        risk: "review",
        reason: `price ${change < 0 ? "drops" : "rises"} ${magnitude.toFixed(0)}%, over the ${policy.priceChangePercent}% threshold`,
      };
    }

    return { risk: "safe", reason: null };
  }

  if (targetField === "inventory") {
    /**
     * Going to zero is graded separately from a percentage. A drop from 4 to
     * 0 is only 100% but means the product stops selling — a consequence a
     * percentage threshold does not capture.
     */
    if (proposed === 0 && current > 0 && policy.flagZeroInventory) {
      return {
        risk: "high",
        reason: `stock drops to zero from ${current} — product becomes unavailable`,
      };
    }

    const change = percentChange(current, proposed);

    if (change < 0 && Math.abs(change) >= policy.inventoryDropPercent) {
      return {
        risk: "review",
        reason: `stock drops ${Math.abs(change).toFixed(0)}%, over the ${policy.inventoryDropPercent}% threshold`,
      };
    }

    return { risk: "safe", reason: null };
  }

  return { risk: "safe", reason: null };
}

export interface CircuitBreakerVerdict {
  blocked: boolean;
  reason: string | null;
}

/**
 * Decides whether the whole run should be stopped.
 *
 * One bad price is a mistake worth reviewing. Four hundred is a broken file,
 * a wrong column mapping, or a supplier sending a test export — and applying
 * any part of it is wrong even if individual rows look plausible.
 */
export function assessRun(
  highRiskCount: number,
  matchedRows: number,
  policy: RiskPolicySpec,
): CircuitBreakerVerdict {
  if (matchedRows === 0) {
    return { blocked: false, reason: null };
  }

  const share = (highRiskCount / matchedRows) * 100;

  if (share > policy.blockRunAbovePercent) {
    return {
      blocked: true,
      reason:
        `${highRiskCount} of ${matchedRows} matched rows are high risk ` +
        `(${share.toFixed(0)}%, over the ${policy.blockRunAbovePercent}% limit). ` +
        `This looks like a broken feed rather than a normal update.`,
    };
  }

  return { blocked: false, reason: null };
}