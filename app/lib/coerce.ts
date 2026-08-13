export type DataType = "string" | "decimal" | "integer";

export interface CoercionResult {
  ok: boolean;
  value?: string | number;
  error?: string;
}

/**
 * Every CSV value arrives as a string. Converting them is where a supplier
 * feed quietly destroys a catalogue: a parser that turns "N/A" into 0 will
 * zero out inventory across thousands of SKUs and report success.
 *
 * So coercion refuses rather than guesses. An unparseable value produces an
 * error the caller must handle, never a default.
 */
export function coerce(raw: string, type: DataType): CoercionResult {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return { ok: false, error: "empty value" };
  }

  if (type === "string") {
    return { ok: true, value: trimmed };
  }

  /**
   * Strip currency symbols and thousands separators, which suppliers include
   * inconsistently: "$1,299.00", "£45.00". Stripping is safe; interpreting a
   * comma as a decimal separator would not be, so a value still containing a
   * comma after this is rejected rather than guessed at.
   */
  const cleaned = trimmed
    .replace(/[$£€]/g, "")
    .replace(/,(?=\d{3}\b)/g, "")
    .trim();

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, error: `"${trimmed}" is not a valid ${type}` };
  }

  const parsed = Number(cleaned);

  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `"${trimmed}" is not a finite number` };
  }

  if (type === "integer") {
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: `"${trimmed}" is not a whole number` };
    }
    return { ok: true, value: parsed };
  }

  if (parsed < 0) {
    return { ok: false, error: `"${trimmed}" is negative` };
  }

  return { ok: true, value: parsed };
}

/** Shopify fields a feed can map to, with their expected type. */
export const TARGET_FIELDS = [
  { value: "sku", label: "Variant SKU", type: "string" as DataType },
  { value: "price", label: "Variant price", type: "decimal" as DataType },
  {
    value: "compareAtPrice",
    label: "Compare-at price",
    type: "decimal" as DataType,
  },
  { value: "cost", label: "Cost per item", type: "decimal" as DataType },
  {
    value: "inventory",
    label: "Inventory quantity",
    type: "integer" as DataType,
  },
  { value: "barcode", label: "Barcode", type: "string" as DataType },
] as const;

export function typeForField(target: string): DataType {
  return TARGET_FIELDS.find((f) => f.value === target)?.type ?? "string";
}