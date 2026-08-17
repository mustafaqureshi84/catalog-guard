import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState, useMemo} from "preact/hooks";

const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "function-configuration";

export default async () => {
  /**
   * The $app namespace requires a definition on the DISCOUNT owner type
   * before anything may write to it — without one, applyMetafieldChange is
   * rejected with "Access to this namespace and key ... is not allowed."
   *
   * Created here rather than at install time because the extension is the
   * only thing that knows it needs this metafield.
   */
  const existing = await getMetafieldDefinition();

  if (!existing) {
    const created = await createMetafieldDefinition();

    if (!created) {
      render(
        <s-banner tone="critical">
          Could not create the metafield definition this discount needs.
        </s-banner>,
        document.body,
      );
      return;
    }
  }

  render(<App />, document.body);
};

async function getMetafieldDefinition() {
  const query = `#graphql
    query GetMetafieldDefinition {
      metafieldDefinitions(
        first: 1
        ownerType: DISCOUNT
        namespace: "${METAFIELD_NAMESPACE}"
        key: "${METAFIELD_KEY}"
      ) {
        nodes { id }
      }
    }
  `;

  const result = await shopify.query(query);

  return result?.data?.metafieldDefinitions?.nodes[0];
}

async function createMetafieldDefinition() {
  const definition = {
    /**
     * MERCHANT_READ_WRITE, not MERCHANT_READ. The extension writes this
     * metafield on the merchant's behalf, and a read-only definition rejects
     * the write with "Access to this namespace and key is not allowed" — an
     * error that names the namespace rather than the permission.
     */
    access: {admin: "MERCHANT_READ_WRITE"},
    key: METAFIELD_KEY,
    name: "Volume discount tiers",
    namespace: METAFIELD_NAMESPACE,
    ownerType: "DISCOUNT",
    type: "json",
  };

  const query = `#graphql
    mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message }
      }
    }
  `;

  const result = await shopify.query(query, {variables: {definition}});

  return result?.data?.metafieldDefinitionCreate?.createdDefinition;
}

/**
 * Highest quantity first — the function takes the first match, so order
 * matters. Used when a merchant has not configured anything yet.
 */
const DEFAULT_TIERS = [
  {minQuantity: 10, percentage: 20},
  {minQuantity: 5, percentage: 10},
  {minQuantity: 3, percentage: 5},
];

function App() {
  const {applyMetafieldChange, data, discounts} = shopify;

  const stored = useMemo(() => {
    const raw = data?.metafields?.find(
      (metafield) => metafield.key === "function-configuration",
    )?.value;

    if (!raw) return DEFAULT_TIERS;

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.tiers) && parsed.tiers.length > 0
        ? parsed.tiers
        : DEFAULT_TIERS;
    } catch {
      // A corrupted metafield should not leave the merchant with a blank
      // form and no way to recover.
      return DEFAULT_TIERS;
    }
  }, [data?.metafields]);

  const [tiers, setTiers] = useState(stored);
  const [error, setError] = useState(undefined);

  const discountClasses = discounts?.discountClasses?.value ?? [];
  const hasProductClass = discountClasses.includes("product");

  function updateTier(index, field, value) {
    setTiers((current) =>
      current.map((tier, i) =>
        i === index ? {...tier, [field]: Number(value)} : tier,
      ),
    );
  }

  /**
   * Tiers out of order silently produce wrong discounts: the function takes
   * the first match, so a low quantity listed above a high one shadows it.
   * Rejecting here is cheaper than debugging a customer's cart later.
   */
  function validate(candidate) {
    for (const tier of candidate) {
      if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 1) {
        return "Minimum quantity must be a whole number of at least 1.";
      }
      if (tier.percentage <= 0 || tier.percentage > 100) {
        return "Discount must be between 1 and 100 percent.";
      }
    }

    for (let i = 1; i < candidate.length; i++) {
      if (candidate[i].minQuantity >= candidate[i - 1].minQuantity) {
        return "Quantities must decrease down the list — highest tier first.";
      }
    }

    return undefined;
  }

  async function save() {
    const problem = validate(tiers);

    if (problem) {
      setError(problem);
      return;
    }

    const result = await applyMetafieldChange({
      type: "updateMetafield",
      namespace: "$app",
      key: "function-configuration",
      value: JSON.stringify({tiers}),
      valueType: "json",
    });

    setError(result?.type === "success" ? undefined : "Could not save tiers.");
  }

  function resetForm() {
    setTiers(stored);
    setError(undefined);
  }

  async function toggleProductClass() {
    const next = hasProductClass
      ? discountClasses.filter((c) => c !== "product")
      : [...discountClasses, "product"];

    const result = await discounts?.updateDiscountClasses?.(next);

    if (!result?.success) {
      setError("Could not update discount classes.");
    }
  }

  return (
    <s-function-settings
      onSubmit={(event) => {
        event.waitUntil?.(save());
      }}
      onReset={resetForm}
    >
      <s-heading>Volume discount tiers</s-heading>

      <s-section>
        <s-stack gap="base">
          {error ? <s-banner tone="critical">{error}</s-banner> : null}

          <s-paragraph>
            Buy more, pay less. The highest matching tier applies to each cart
            line.
          </s-paragraph>

          <s-checkbox
            checked={hasProductClass}
            onChange={toggleProductClass}
            label="Product discount"
            disabled={discountClasses.length === 1 && hasProductClass}
          />

          {hasProductClass
            ? tiers.map((tier, index) => (
                <s-stack key={index} gap="none">
                  <s-heading>Tier {index + 1}</s-heading>
                  <s-stack direction="inline" gap="base">
                    <s-number-field
                      label="Minimum quantity"
                      name={`minQuantity-${index}`}
                      value={String(tier.minQuantity)}
                      min={1}
                      onChange={(event) =>
                        updateTier(index, "minQuantity", event.currentTarget.value)
                      }
                    />
                    <s-number-field
                      label="Discount"
                      name={`percentage-${index}`}
                      value={String(tier.percentage)}
                      min={1}
                      max={100}
                      suffix="%"
                      onChange={(event) =>
                        updateTier(index, "percentage", event.currentTarget.value)
                      }
                    />
                  </s-stack>
                </s-stack>
              ))
            : null}
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}