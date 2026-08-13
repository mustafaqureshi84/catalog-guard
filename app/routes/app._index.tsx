import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];

  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );

  const responseJson = await response.json();
  const result = responseJson.data?.productCreate;

  /**
   * A rejected mutation returns HTTP 200 with `product: null` and the reason
   * in `userErrors`. Reading `product.variants` without checking produces a
   * TypeError twenty lines later instead of the actual message — which is
   * what the template shipped with, and why deleting an unused metafield
   * definition from shopify.app.toml surfaced as a null-property error.
   */
  if (!result || result.userErrors.length > 0) {
    throw new Error(
      `productCreate failed: ${JSON.stringify(
        result?.userErrors ?? responseJson,
      )}`,
    );
  }

  const product = result.product;
  const variantId = product.variants.edges[0].node.id;

  const variantResponse = await admin.graphql(
    `#graphql
      mutation updateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
            price
            barcode
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );

  const variantResponseJson = await variantResponse.json();
  const variantResult = variantResponseJson.data?.productVariantsBulkUpdate;

  if (!variantResult || variantResult.userErrors.length > 0) {
    throw new Error(
      `productVariantsBulkUpdate failed: ${JSON.stringify(
        variantResult?.userErrors ?? variantResponseJson,
      )}`,
    );
  }

  return {
    product,
    variant: variantResult.productVariants,
  };
};

export default function Index() {
  const fetcher = useFetcher<typeof action>();

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const productId = fetcher.data?.product?.id.replace(
    "gid://shopify/Product/",
    "",
  );

  useEffect(() => {
    if (productId) {
      /**
       * App Bridge is injected into the page by the Shopify admin at runtime,
       * so `window.shopify` has no type definition. It also only exists in the
       * browser — reading it at the top of the component would run during
       * server-side rendering and throw "window is not defined".
       */
      (window as unknown as { shopify: { toast: { show: (m: string) => void } } })
        .shopify.toast.show("Product created");
    }
  }, [productId]);

  const generateProduct = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page>
      <s-section heading="Catalog Guard — scaffold check">
        <s-paragraph>
          Temporary page confirming OAuth, session storage, and the
          authenticated GraphQL client all work. Will be replaced by the feed
          connection UI.
        </s-paragraph>

        <s-button loading={isLoading} onClick={generateProduct}>
          Generate a product
        </s-button>

        {fetcher.data?.product && (
          <>
            <s-heading>productCreate mutation</s-heading>
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <pre style={{ margin: 0, overflow: "auto" }}>
                <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
              </pre>
            </s-box>

            <s-heading>productVariantsBulkUpdate mutation</s-heading>
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <pre style={{ margin: 0, overflow: "auto" }}>
                <code>{JSON.stringify(fetcher.data.variant, null, 2)}</code>
              </pre>
            </s-box>
          </>
        )}
      </s-section>
    </s-page>
  );
}