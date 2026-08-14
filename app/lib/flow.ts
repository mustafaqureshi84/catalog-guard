import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const TRIGGER_HANDLE = "dangerous-change-detected";

const FLOW_TRIGGER_RECEIVE = `#graphql
  mutation FlowTriggerReceive($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { field message }
    }
  }
`;

export interface DangerousChangePayload {
  feedName: string;
  highRiskCount: number;
  reviewCount: number;
  matchedRows: number;
  runBlocked: boolean;
  topReason: string;
}

/**
 * Fires the custom Flow trigger.
 *
 * Payload keys must match the field keys declared in the extension's TOML
 * exactly — including spaces and capitalisation, since Flow surfaces them to
 * merchants verbatim in the condition builder.
 *
 * Values must match the declared types. Sending a number as a string leaves
 * merchants with string operators only: "equals 5" instead of "greater than
 * 3", which is the condition they would actually reach for.
 */
export async function fireDangerousChange(
  admin: AdminApiContext,
  payload: DangerousChangePayload,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const response = await admin.graphql(FLOW_TRIGGER_RECEIVE, {
      variables: {
        handle: TRIGGER_HANDLE,
        payload: {
          "Feed name": payload.feedName,
          "High risk count": payload.highRiskCount,
          "Review count": payload.reviewCount,
          "Matched rows": payload.matchedRows,
          "Run blocked": payload.runBlocked,
          "Top reason": payload.topReason,
        },
      },
    });

    const json = await response.json();
    const result = json.data?.flowTriggerReceive;

    /**
     * A rejected trigger returns HTTP 200 with userErrors populated — the
     * same third error channel as every other Shopify mutation. Treating the
     * 200 as success would mean a workflow that silently never fires.
     */
    if (!result || result.userErrors.length > 0) {
      return {
        ok: false,
        error: JSON.stringify(result?.userErrors ?? json),
      };
    }

    return { ok: true, error: null };
  } catch (err) {
    /**
     * A failed notification must not fail the shadow run. The diff is the
     * valuable artefact; the Flow event is a convenience on top of it.
     */
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}