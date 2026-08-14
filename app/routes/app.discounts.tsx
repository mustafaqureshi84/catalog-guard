import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

const FUNCTIONS_QUERY = `#graphql
  query ShopifyFunctions {
    shopifyFunctions(first: 25) {
      nodes {
        id
        title
        apiType
        app { title }
      }
    }
  }
`;

const DISCOUNTS_QUERY = `#graphql
  query AppDiscounts {
    discountNodes(first: 25) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticApp {
            title
            status
            startsAt
            discountClasses
          }
        }
      }
    }
  }
`;

const CREATE_DISCOUNT = `#graphql
  mutation CreateVolumeDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId title status }
      userErrors { field message }
    }
  }
`;

const DELETE_DISCOUNT = `#graphql
  mutation DeleteDiscount($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const functionsResponse = await admin.graphql(FUNCTIONS_QUERY);
  const functionsJson = await functionsResponse.json();

  const discountsResponse = await admin.graphql(DISCOUNTS_QUERY);
  const discountsJson = await discountsResponse.json();

  /**
   * Only discount-type functions are relevant here. The app may own others —
   * cart transforms, delivery customisations — which cannot back a discount.
   */
  const functions = (functionsJson.data?.shopifyFunctions?.nodes ?? []).filter(
    (fn: { apiType: string }) => fn.apiType?.includes("discount"),
  );

  const discounts = (discountsJson.data?.discountNodes?.nodes ?? []).filter(
    (node: { discount: { __typename: string } }) =>
      node.discount.__typename === "DiscountAutomaticApp",
  );

  return { functions, discounts };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "create") {
    const functionId = String(formData.get("functionId"));
    const title = String(formData.get("title") ?? "").trim();

    if (!functionId || !title) {
      return { error: "Function and title are both required." };
    }

    const response = await admin.graphql(CREATE_DISCOUNT, {
      variables: {
        discount: {
          title,
          functionId,
          /**
           * Declaring only the classes the discount actually uses. Enabling
           * all three by default creates needless conflicts and confusing
           * combination behaviour — and this function declines anything that
           * is not PRODUCT anyway.
           */
          discountClasses: ["PRODUCT"],
          /**
 * Backdated by a minute. A startsAt of exactly "now" is treated as
 * future-dated by the time the mutation is processed, leaving the discount
 * SCHEDULED rather than ACTIVE.
 */
startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });

    const json = await response.json();
    const result = json.data?.discountAutomaticAppCreate;

    // A rejected mutation returns HTTP 200 with the reason in userErrors.
    if (!result || result.userErrors.length > 0) {
      return {
        error: JSON.stringify(result?.userErrors ?? json),
      };
    }

    return { created: result.automaticAppDiscount.title };
  }

  if (intent === "delete") {
    const id = String(formData.get("discountId"));

    const response = await admin.graphql(DELETE_DISCOUNT, {
      variables: { id },
    });

    const json = await response.json();
    const result = json.data?.discountAutomaticDelete;

    if (!result || result.userErrors.length > 0) {
      return { error: JSON.stringify(result?.userErrors ?? json) };
    }

    return { deleted: true };
  }

  return { error: `Unknown intent: ${intent}` };
};

export default function Discounts() {
  const { functions, discounts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isBusy = fetcher.state !== "idle";

  return (
    <s-page>
      <s-section heading="Volume discounts">
        <s-paragraph>
          Function-backed discounts do not appear in Shopify&apos;s native
          create-discount list. The app deploys the function; a discount record
          pointing at it has to be created here.
        </s-paragraph>

        {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
          <s-banner tone="critical" heading="Error">
            <s-paragraph>{fetcher.data.error}</s-paragraph>
          </s-banner>
        )}

        {fetcher.data && "created" in fetcher.data && fetcher.data.created && (
          <s-banner tone="success" heading="Discount created">
            <s-paragraph>
              {fetcher.data.created} is now active. Add a qualifying quantity to
              a cart to see it apply.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>

      <s-section heading={`Available functions (${functions.length})`}>
        {functions.length === 0 ? (
          <s-banner tone="warning" heading="No discount functions found">
            <s-paragraph>
              Deploy the app with `npm run shopify app deploy` first.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-stack direction="block" gap="base">
            {functions.map(
              (fn: {
                id: string;
                title: string;
                apiType: string;
                app: { title: string } | null;
              }) => (
                <s-box
                  key={fn.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-heading>{fn.title}</s-heading>
                    <s-text>{fn.apiType}</s-text>
                    <s-text>{fn.id}</s-text>

                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="create" />
                      <input type="hidden" name="functionId" value={fn.id} />

                      <s-stack direction="block" gap="small-200">
                        <s-text-field
                          label="Discount title"
                          name="title"
                          value="Volume discount"
                        />
                        <s-button
                          type="submit"
                          variant="primary"
                          loading={isBusy}
                        >
                          Create discount from this function
                        </s-button>
                      </s-stack>
                    </fetcher.Form>
                  </s-stack>
                </s-box>
              ),
            )}
          </s-stack>
        )}
      </s-section>

      {discounts.length > 0 && (
        <s-section heading={`Active discounts (${discounts.length})`}>
          <s-stack direction="block" gap="base">
            {discounts.map(
              (node: {
                id: string;
                discount: {
                  title: string;
                  status: string;
                  discountClasses: string[];
                };
              }) => (
                <s-box
                  key={node.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-heading>{node.discount.title}</s-heading>
                    <s-text>Status: {node.discount.status}</s-text>
                    <s-text>
                      Classes: {node.discount.discountClasses.join(", ")}
                    </s-text>

                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="discountId" value={node.id} />
                      <s-button type="submit" tone="critical">
                        Delete
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
                </s-box>
              ),
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}