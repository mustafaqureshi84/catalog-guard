# Catalog Guard

A Shopify app for syncing supplier feeds into a merchant's catalogue — with the guard rails that make automation trustworthy at scale — plus a checkout discount function.

Feed sync itself is a commodity; several apps do it. The problem this solves is different: **a merchant will not hand four thousand products to automation unless they can say what it is allowed to touch, see what it intends to do, and be stopped when a supplier sends something wrong.**

## What it does

**Field ownership.** The merchant declares who controls each Shopify field. The supplier owns price and stock; the merchant owns titles and descriptions. A feed containing a title column is refused that column, and the refusal is visible in the diff rather than silent.

**Shadow mode.** Fetch the feed, match rows against the live catalogue, and report exactly what would change — writing nothing. Unmatched SKUs, ambiguous matches, and unparseable values are all reported rather than skipped.

**Risk scoring.** Every proposed change is graded against per-feed thresholds. A price moving 21% needs review; a price moving 92% is high risk, with the reason in plain language.

**Circuit breaker.** When too large a share of matched rows is high risk, the run is blocked. One bad price is a mistake; four hundred is a broken file.

**Selective apply.** Safe changes are written; risky ones are held. The merchant reviews a handful rather than approving in bulk.

**Flow integration.** Dangerous runs emit a custom trigger, so merchants can build their own workflows on top — alert a channel, tag affected products, pause a sales channel.

**Volume discounts.** A Shopify Function applying tiered pricing at checkout, configured by the merchant through an admin settings extension.

## Stack

- **React Router 7** (Shopify app template) with server-side rendering
- **TypeScript**, strict
- **Prisma 6** + SQLite for sessions and app data
- **Polaris web components** and App Bridge for the embedded UI
- **Preact** for the admin settings extension
- **JavaScript compiled to WebAssembly** via Javy for the checkout function
- **Papaparse** for CSV
- **Shopify Admin GraphQL API** `2026-07`, webhooks `2026-10`, functions `2026-07`
- **Flow trigger extension** for custom events

## Setup

### Prerequisites

- Node.js 22 LTS
- A Shopify Partner account and a development store
- Shopify CLI
- `pnpm` — required by the function extension template even in an npm project

### Install

```bash
npm install
npx prisma migrate deploy
npx prisma generate
```

### Run

```bash
npm run dev
```

The CLI provides its own tunnel and updates `application_url` automatically. Press `p` to open the app in the admin, `g` for GraphiQL against the store.

### Deploy extensions

```bash
npm run shopify app deploy
```

Scopes live in `shopify.app.toml`, not the Dev Dashboard, and are pushed on deploy. Config is therefore in version control and diffable, unlike a web form.

### Test the function

```bash
cd extensions/volume-discount
npm test
```

Builds the WebAssembly binary, validates every fixture against the function's schema, and runs the real binary. Adding a test means adding a fixture, not editing the test file.

## Structure

| File | Responsibility |
|---|---|
| `app/lib/coerce.ts` | CSV string → typed value, refusing rather than guessing |
| `app/lib/risk.ts` | Threshold grading and the run-level circuit breaker |
| `app/lib/shadow.ts` | The diff engine: SKU matching, ownership, coercion, classification |
| `app/lib/apply.ts` | Writes approved changes, grouped by product |
| `app/lib/flow.ts` | Fires the custom Flow trigger |
| `app/routes/app.feeds._index.tsx` | Feed list: add, fetch, parse, delete |
| `app/routes/app.feeds.$id.tsx` | Mapping, policy, shadow mode, apply |
| `app/routes/app.discounts.tsx` | Lists discount functions and creates discount records from them |
| `app/routes/app.tsx` | Layout, App Bridge provider, admin sidebar nav |
| `extensions/dangerous-change-detected/` | Flow trigger declaration |
| `extensions/volume-discount/src/*.graphql` | Function input queries — the entire data contract |
| `extensions/volume-discount/src/*.js` | Function logic, compiled to Wasm |
| `extensions/volume-discount/tests/fixtures/` | Input and expected output per scenario |
| `extensions/volume-discount-settings/` | Merchant-facing tier configuration, Preact |
| `prisma/schema.prisma` | Sessions plus feeds, mappings, policies, runs, changes |

## Data model

Eight tables beyond the template's `Session`.

**Everything is scoped by `shop`.** One deployment serves many stores, so every query filters by shop — including deletes that already have a uuid. An id-only lookup would let one merchant reach another's data by guessing.

**`FieldMapping` has a unique constraint on `(feedId, targetField)`.** Only one supplier column may claim a Shopify field. Two columns competing for the same target is a conflict with no obvious resolution, so it is rejected at the schema level rather than resolved at write time.

**`ShadowRun` and `ShadowChange` are recorded, not computed on demand.** A merchant can review, leave, and come back — and the apply step acts on a concrete artefact rather than re-deriving the diff against a catalogue that moved in between.

**Rows that fail are recorded, not skipped.** Unmatched, ambiguous, and uncoercible rows all produce a `ShadowChange` with a reason. A silent skip is how a feed appears to sync successfully while ignoring a third of the catalogue.

**`FeedRun` records failures as well as successes.** A feed that quietly stopped updating is the failure merchants notice last and care about most.

## Design notes

### Trust

**Ownership is declared, not inferred.** The app cannot know whether a merchant wants supplier titles. Asking once and enforcing it thereafter is the entire reason this is installable on a real catalogue.

**Refusals are visible.** A blocked field still appears in the diff showing what the supplier asked for and why it was refused. Silence would leave the merchant unable to tell whether their supplier is sending prices at all.

**Ambiguous matches are skipped, not resolved.** Shopify does not enforce SKU uniqueness, so one SKU matching two variants is a real case. Applying to both is unrecoverable if wrong — two variants would hold a bad value with nothing recording which was intended. Skipping costs one manual fix and loses nothing.

**Coercion refuses rather than defaults.** A parser that turns `"N/A"` into `0` will zero out inventory across thousands of SKUs and report success. `"$1,299.00"` is cleaned to a number, but a value still containing a comma afterwards is rejected — `"1,5"` could mean 1.5 or 15, and guessing wrong on a price is worse than refusing.

**The circuit breaker gates risk, not everything.** A blocked run still permits changes the policy graded as safe. Blocking those too would train merchants to reach for the override, which is the opposite of what a breaker is for.

**The override requires typing the affected row count.** A one-click bypass returns you to where you started; friction proportional to blast radius does not.

**Risk scoring is threshold rules, not anomaly detection.** A new install has no baseline of what normal looks like for a supplier. Rules are honest about what they are, and a merchant can reason about "more than 20%" in a way they cannot about a model's opinion.

**Zero stock is graded separately from a percentage.** A drop from 4 to 0 is only 100%, but the product stops selling — a consequence a percentage threshold does not capture.

**The Flow trigger fires only when something warrants it.** A trigger that fires on every run trains merchants to ignore it, which is worse than not having one.

**A checkout function falls back rather than throwing.** `coerce` refuses bad input because a merchant is present to fix it. The discount function runs during checkout with no way to report anything to anyone, so malformed configuration degrades to defaults instead of failing a customer's cart. The settings UI validates at configuration time, where the error can actually be acted on.

### Engineering

**Values are compared as the type they will be written as.** `"89.99"` and `"89.9900"` are the same price, and a string comparison would call them different — producing a change that writes nothing and a diff full of noise the merchant learns to ignore.

**Writes are grouped by product.** `productVariantsBulkUpdate` takes a product ID and a list of its variants, so changes are batched rather than sent one at a time — which also avoids two requests fighting over the same product.

**A failed Flow notification does not fail the shadow run.** The diff is the valuable artefact; the event is a convenience on top of it.

**`userErrors` is checked on every mutation.** A rejected mutation returns HTTP 200 with a null payload and the reason in `userErrors`. Reading the result without checking produces a TypeError twenty lines later instead of the actual message — which is what the Shopify template ships with, and how deleting an unused metafield definition from `shopify.app.toml` surfaced as `Cannot read properties of null`.

**Tier boundaries are tested on both sides.** Tiered pricing is where off-by-one hides: a merchant advertises "3 or more, 5% off", a customer buys exactly 3, and gets nothing because a `>` should have been `>=`. Fixtures cover 2, 3, 4, 5, 10, and 12.

## Shopify Functions

The discount function is pure compute: input in, operations out. No network calls, no async, no database. It runs during checkout at roughly 418,000 instructions against an 11 million limit — under 4% of the budget.

**Three pieces, deliberately separate.**

The **function** computes discounts from an input query it declares itself. Anything not requested in that query is unavailable, because there is no way to fetch it.

The **settings extension** renders inside Shopify's discount detail page and writes merchant configuration to an app-scoped metafield.

The **discount record** links a merchant-visible discount to the function. Shopify's native create-discount UI only offers its own four types, so an app-provided discount must be created via `discountAutomaticAppCreate` — which is what `app/routes/app.discounts.tsx` exists for.

**The metafield is the bridge.** A function cannot fetch anything at runtime, so configuration has to arrive in the input. The settings UI writes it; the function's input query requests it; Shopify passes it through.

**Testing needs no store, tunnel, or deploy.** A JSON fixture in, a JSON result out. The constraints that make functions restrictive also make them trivially testable, and the feedback loop is faster than anything else in this project.

## Platform findings

Verified against a live development store, not taken from documentation.

**`flatRoutes` nests on dots.** A file at `app.feeds.tsx` becomes the **parent layout** for `app.feeds.$id.tsx`, and a parent renders its child only if it contains `<Outlet />`. Without one, navigating to the child changes the URL and renders the parent — a symptom that looks nothing like a routing problem. Renaming to `app.feeds._index.tsx` makes them siblings.

**React's `onClick` does not reliably bind to Polaris web components.** A button using `onClick` produced no network request at all, while `type="submit"` buttons inside forms worked throughout — native browser behaviour with no React listener involved. Navigation between routes uses a form GET rather than a handler.

**`s-app-nav` renders into the admin's sidebar, not the app iframe.** Nav links appear under the app's entry in Shopify's left menu, nowhere in the app's own page area.

**Flow trigger field keys accept only alphabetic characters and spaces.** No underscores, no digits. The keys are shown to merchants verbatim in the condition builder.

**Flow trigger descriptions are capped at 140 characters.**

**Flow trigger property types are fixed at declaration and silently constrain what merchants can build.** A count declared as `single_line_text_field` produces a trigger that fires correctly, populates the property, and runs the workflow — but offers only string operators. A merchant can check `equals "5"` and cannot check `greater than 3`, which is the condition anyone would actually want. Nothing observable is broken; the only symptom is a missing operator in a dropdown. Available types include `number_decimal`, `boolean`, `email`, `url`, and `single_line_text_field`. There is no integer type.

**A function extension needs `[extensions.ui]` naming its settings extension.** Without it the two are unrelated as far as Shopify is concerned, and clicking the discount in the admin falls back to the app root with nothing rendered.

**Function-backed discounts do not appear in the native create-discount list.** Deploying the function makes it available; a `DiscountAutomaticApp` record pointing at its function ID is what merchants actually see and manage. The app has to create it.

**`startsAt: new Date()` produces a `SCHEDULED` discount, not an `ACTIVE` one.** By the time the mutation is processed, "now" is in the past-but-not-quite. Backdating by a minute fixes it.

**`$app` metafield definitions need `MERCHANT_READ_WRITE` access.** `MERCHANT_READ` produces "Access to this namespace and key on Metafields for this resource type is not allowed" — an error naming the namespace rather than the permission, which sends you looking in entirely the wrong place.

**Deleting a definition in a reserved namespace requires `deleteAllAssociatedMetafields: true`.** The flag exists because deletion orphans every metafield using the definition, and Shopify wants that acknowledged rather than assumed.

**Editing a function's source does not rebuild its WebAssembly.** `npm run build` does. A stale binary produces output that looks plausible and is simply the previous version — which is why the test harness builds before running rather than testing the JavaScript directly.

**The function extension template hardcodes `pnpm`.** It runs regardless of the project's package manager, and pnpm 11's build-script security default fails the scaffold with the extension folder never written.

**Config and code are coupled with no warning.** Deleting the template's demo metafield definition from `shopify.app.toml` broke a mutation in a `.tsx` file that referenced it.

**Cloudflare quick tunnels are not stable across a long session.** Three deaths during one session produced symptoms indistinguishable from code bugs — clicks reaching nothing while the page kept rendering its last state. When several fixes in a row change nothing, verify the environment before writing more code.

**VS Code validates function input queries against the Admin API schema.** A function's own `schema.graphql` is not picked up automatically, so `cart` and `discount` are flagged as unknown fields with Admin API suggestions. The build and typegen are unaffected.

**Prisma's VS Code extension and the installed CLI can disagree.** The v7 extension flags `url` in a datasource block as unsupported while the installed v6.19 CLI accepts it. The migration succeeding settles it.

**Windows cannot replace a DLL a running process holds.** `prisma generate` fails with `EPERM` while the dev server is up. Stop it first.

## Known limitations

1. **Inventory writes are not implemented.** Inventory lives on `InventoryLevel` per location, not on the variant, and writing it needs `inventorySetQuantities` with an explicit location. `applyChanges` refuses those changes with that reason rather than silently dropping them.

2. **The merchant supplies a URL the server fetches.** That is a server-side request forgery surface — a URL pointing at cloud metadata or an internal service would be fetched with this server's credentials and network access. Only an `https://` scheme check exists; production needs private-IP blocking and an allowlist.

3. **CSV only.** XML, JSON, FTP/SFTP, and Google Sheets are roadmap items. The parsing layer is the only part that differs.

4. **No scheduling.** Feeds are fetched and evaluated on demand. A production version would run on a schedule with alerting.

5. **No rollback.** Applied changes cannot be reversed from within the app. Reversing safely requires versioned per-field history and a merge strategy for concurrent edits.

6. **SQLite.** Fine for a single-instance development app; a deployed multi-tenant app needs Postgres.

7. **Risk thresholds are global per feed.** No per-product or per-collection overrides, and no supplier reliability score across runs.

8. **Only the discount function is tested.** `coerce` and `assessRisk` are pure functions and the obvious next candidates — everything they guard against is a data-corruption failure that would be silent in production.

9. **Only one Flow trigger, and no custom actions.** A "feed failed" trigger and an action letting a workflow request a sync are natural extensions.

10. **Shadow runs load all changes into memory.** Fine at hundreds of rows; a 50,000-row feed would need streaming and pagination in the UI.

11. **Volume discount tiers are fixed at three.** The settings UI has no add or remove, so a merchant wanting two tiers or five cannot have them.

12. **The discount function's delivery-options target is untouched.** It still contains the template's shipping discount logic and is neither used nor removed.

## Roadmap

- Inventory writes via `inventorySetQuantities` with location selection
- Scheduled fetch and evaluation, with alerting on blocked runs
- Canary sync: apply to a subset, verify, then release the rest
- Conflict-aware rollback
- Supplier reliability scoring across runs
- Additional feed formats
- Custom Flow action so workflows can request a sync
- Tests for `coerce` and `assessRisk`
- Add/remove rows in the volume tier editor

## Related

Built alongside [shopify-automation](https://github.com/mustafaqureshi84/shopify-automation) — a headless integration layer covering bulk operations, adaptive rate limiting, webhook processing with a durable queue, idempotent handlers, and cross-system reconciliation. Several patterns here originate there, particularly the treatment of ambiguous outcomes and the preference for recording failures over skipping them.