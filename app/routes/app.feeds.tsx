import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import Papa from "papaparse";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const feeds = await prisma.feedConnection.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    include: {
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
      },
    },
  });

  return { feeds };
};

interface ParseResult {
  rowCount: number;
  columns: string[];
  bytes: number;
  sample: Record<string, string>[];
}

async function fetchAndParse(url: string): Promise<ParseResult> {
  /**
   * The merchant supplies this URL and the server fetches it. That is a
   * server-side request forgery surface — a URL pointing at cloud metadata
   * or an internal service would be fetched with this server's credentials
   * and network access. Production needs scheme validation and private-IP
   * blocking; noted as a limitation rather than solved here.
   */
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Feed returned ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    // Suppliers send inconsistent casing and stray whitespace in headers.
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`CSV parse error on row ${first.row}: ${first.message}`);
  }

  return {
    rowCount: parsed.data.length,
    columns: parsed.meta.fields ?? [],
    bytes: text.length,
    sample: parsed.data.slice(0, 5),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "create") {
    const name = String(formData.get("name") ?? "").trim();
    const url = String(formData.get("url") ?? "").trim();

    if (!name || !url) {
      return { error: "Name and URL are both required." };
    }

    if (!url.startsWith("https://")) {
      return { error: "Feed URL must use https." };
    }

    await prisma.feedConnection.create({
      data: { shop: session.shop, name, url },
    });

    return { created: true };
  }

  if (intent === "fetch") {
    const feedId = String(formData.get("feedId"));

    const feed = await prisma.feedConnection.findFirst({
      // Scoped by shop as well as id — an id alone would let one merchant
      // fetch another's feed by guessing a uuid.
      where: { id: feedId, shop: session.shop },
    });

    if (!feed) {
      return { error: "Feed not found." };
    }

    const run = await prisma.feedRun.create({
      data: { feedId: feed.id },
    });

    try {
      const result = await fetchAndParse(feed.url);

      await prisma.feedRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          rowCount: result.rowCount,
          columnNames: result.columns.join(","),
          bytes: result.bytes,
          finishedAt: new Date(),
        },
      });

      await prisma.feedConnection.update({
        where: { id: feed.id },
        data: {
          lastFetchedAt: new Date(),
          lastRowCount: result.rowCount,
          lastError: null,
        },
      });

      return { parsed: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await prisma.feedRun.update({
        where: { id: run.id },
        data: { status: "failed", error: message, finishedAt: new Date() },
      });

      await prisma.feedConnection.update({
        where: { id: feed.id },
        data: { lastError: message },
      });

      return { error: message };
    }
  }

  if (intent === "delete") {
    const feedId = String(formData.get("feedId"));

    await prisma.feedConnection.deleteMany({
      where: { id: feedId, shop: session.shop },
    });

    return { deleted: true };
  }

  return { error: `Unknown intent: ${intent}` };
};

export default function Feeds() {
  const { feeds } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isBusy = fetcher.state !== "idle";

  return (
    <s-page>
      <s-section heading="Supplier feeds">
        <s-paragraph>
          Connect a supplier CSV feed by URL. Nothing is written to your
          catalogue yet — this fetches the file and reports what it contains.
        </s-paragraph>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />

          <s-stack direction="block" gap="base">
            <s-text-field
              label="Feed name"
              name="name"
              placeholder="Acme Supplies"
            />
            <s-text-field
              label="CSV URL"
              name="url"
              placeholder="https://example.com/feed.csv"
            />
            <s-button type="submit" variant="primary" loading={isBusy}>
              Add feed
            </s-button>
          </s-stack>
        </fetcher.Form>

        {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
          <s-banner tone="critical" heading="Error">
            <s-paragraph>{fetcher.data.error}</s-paragraph>
          </s-banner>
        )}
      </s-section>

      {feeds.length > 0 && (
        <s-section heading={`Connected feeds (${feeds.length})`}>
          <s-stack direction="block" gap="base">
            {feeds.map((feed) => {
              const lastRun = feed.runs[0];

              return (
                <s-box
                  key={feed.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-heading>{feed.name}</s-heading>
                    <s-text>{feed.url}</s-text>

                    <s-text>
                      {feed.lastFetchedAt
                        ? `Last fetched ${new Date(feed.lastFetchedAt).toLocaleString()} — ${feed.lastRowCount} rows`
                        : "Never fetched"}
                    </s-text>

                    {feed.lastError && (
                      <s-text tone="critical">Error: {feed.lastError}</s-text>
                    )}

                    {lastRun?.columnNames && (
                      <s-text>Columns: {lastRun.columnNames}</s-text>
                    )}

                    <s-stack direction="inline" gap="small-200">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="fetch" />
                        <input type="hidden" name="feedId" value={feed.id} />
                        <s-button type="submit" loading={isBusy}>
                          Fetch now
                        </s-button>
                      </fetcher.Form>

                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="feedId" value={feed.id} />
                        <s-button type="submit" tone="critical">
                          Delete
                        </s-button>
                      </fetcher.Form>
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-section>
      )}

      {fetcher.data && "parsed" in fetcher.data && fetcher.data.parsed && (
        <s-section heading="Last fetch result">
          <s-text>
            {fetcher.data.parsed.rowCount} rows, {fetcher.data.parsed.bytes}{" "}
            bytes
          </s-text>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <pre style={{ margin: 0, overflow: "auto" }}>
              <code>{JSON.stringify(fetcher.data.parsed.sample, null, 2)}</code>
            </pre>
          </s-box>
        </s-section>
      )}
    </s-page>
  );
}