/**
 * Maps directories to their GraphQL schemas.
 *
 * Without this, VS Code validates every .graphql file against the Admin API
 * schema — so a function's input query reports "Cannot query field cart on
 * type QueryRoot", suggesting Admin API fields like blogsCount. The build
 * and typegen were always correct; only the editor was pointed at the wrong
 * schema.
 */
export default {
  projects: {
    default: {
      schema: 'https://shopify.dev/admin-graphql-direct-proxy/2026-07',
      documents: ['./app/**/*.{js,ts,jsx,tsx}'],
    },
    volumeDiscount: {
      schema: './extensions/volume-discount/schema.graphql',
      documents: ['./extensions/volume-discount/src/**/*.graphql'],
    },
  },
};