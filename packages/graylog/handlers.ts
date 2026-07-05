// HTTP handlers reproducing the Graylog REST surface (see docs/CONTRACTS.md).
// The shell app routes requests here; existing clients (extension, bookmarklets,
// graylog_query) work by changing only the base URL.

import type { GraylogStore } from "./store.ts";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Accept, Content-Type, X-Requested-By",
  "Access-Control-Max-Age": "86400",
};

function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

// POST /gelf — GELF HTTP input. 202 + empty body like real Graylog. When
// GRAYLOG_INGEST_TOKEN is set, every message must carry a matching
// _graylog_key (consumed for auth, never stored); mismatch ⇒ 403 (the shim's
// status, so clients branching on it keep working). A store failure surfaces
// as 500 instead of silently dropping the scrape behind a 202.
export async function handleGelfRequest(
  store: GraylogStore,
  req: Request,
): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400, headers: CORS_HEADERS });
  }
  const token = Deno.env.get("GRAYLOG_INGEST_TOKEN") ?? "";
  const items = Array.isArray(body) ? body : [body];
  let attempted = 0;
  let stored = 0;
  for (const g of items) {
    if (!g || typeof g !== "object") continue;
    const rec = g as Record<string, unknown>;
    if (token) {
      const key = typeof rec._graylog_key === "string" ? rec._graylog_key : "";
      if (key !== token) {
        return new Response("forbidden", {
          status: 403,
          headers: CORS_HEADERS,
        });
      }
    }
    attempted++;
    const res = await store.ingestGelf(rec);
    if (res.ok) stored++;
    else console.error("[graylog] ingest failed:", res.error);
  }
  if (attempted > 0 && stored === 0) {
    return new Response("ingest failed", {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
  return new Response(null, { status: 202, headers: CORS_HEADERS });
}

// GET /api/search/universal/relative?query=&range=&limit=&fields=
// Basic auth is accepted but NOT required (single-tenant behind LP-OS).
export async function handleSearchRequest(
  store: GraylogStore,
  req: Request,
): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const url = new URL(req.url);
  const fcsv = url.searchParams.get("fields");
  const result = await store.search({
    query: url.searchParams.get("query") ?? "*",
    rangeSeconds: Number(url.searchParams.get("range") ?? "0"),
    limit: Number(url.searchParams.get("limit") ?? "150"),
    fields: fcsv ? fcsv.split(",").map((s) => s.trim()).filter(Boolean) : null,
  });

  // EMPTY-WINDOW QUIRK: the index_not_found_exception 500 sentinel fires ONLY
  // when zero results AND the window's lower bound is strictly newer than the
  // newest stored doc (clients map it to {messages:[], _emptyWindow:true}).
  // Any other zero-result search is a normal 200 with total_results: 0.
  if (result.total_results === 0 && result.windowMinMs !== null) {
    const newest = (await store.newestTimestampMs()) ?? 0;
    if (result.windowMinMs > newest) {
      return json(
        {
          type: "ApiError",
          message: "index_not_found_exception no such index []",
        },
        500,
      );
    }
  }

  return json({
    messages: result.messages,
    total_results: result.total_results,
    from: result.from,
    to: result.to,
    fields: result.fields,
    used_indices: result.used_indices, // never empty on a 200
    time: result.time,
  });
}

// POST /api/system/sessions — benign stub so dashboard-style clients don't throw.
export function handleSessionsStub(req: Request): Response {
  const pf = preflight(req);
  if (pf) return pf;
  return json(
    {
      session_id: crypto.randomUUID(),
      valid_until: new Date(Date.now() + 36e5).toISOString(),
    },
    200,
    { "Set-Cookie": "authentication=stub; Path=/; HttpOnly; SameSite=Lax" },
  );
}

// GET|POST /api/views — benign stub (Graylog metadata).
export function handleViewsStub(req: Request): Response {
  const pf = preflight(req);
  if (pf) return pf;
  return json({ views: [], total: 0 });
}
