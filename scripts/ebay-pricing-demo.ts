#!/usr/bin/env -S deno run -A
// eBay pricing formula demo (CLI) — ported from data-pimp Demos/E2E.
//
// Walks the pricing engine (packages/marketplace/ebay-pricing.ts) through a
// battery of real-world resale scenarios and prints, per scenario: the market
// anchor, the undercut, the fee-aware floor, the retail ceiling, the
// recommended Buy-It-Now price, the net after fees, and WHY. It then shows the
// velocity "walk-down" — the same unit re-priced as it ages, so you can watch
// the ask step toward the floor.
//
// This is the deterministic, offline demo of the formula (no network needed).
// Pass --live to ALSO price real products from the LP-OS catalog
// (GET /api/products) end-to-end.
//
// Usage:
//   deno task demo:ebay-pricing
//   deno task demo:ebay-pricing -- --live
//   deno task demo:ebay-pricing -- --live 1729587769570529799
//   deno task demo:ebay-pricing -- --live --api https://thirsty.store
//   deno run -A scripts/ebay-pricing-demo.ts --json     # machine-readable
//
// Flags:
//   --live [id ...]   price real catalog product(s); no ids = the 3 priciest
//   --api <url>       API base for --live (default http://localhost:8000)
//   --json            print the raw EbayPriceResult objects as JSON
//
// The visual version is /demos/ebay-pricing (Demos → eBay Pricing in the
// shell); the Marketplace window's Ask-price suggestion runs the same formula.

import {
  computeEbayPrice,
  type EbayPriceInput,
  type EbayPriceResult,
  markdownLadder,
} from "../packages/marketplace/ebay-pricing.ts";

// ---- tiny arg parse (mirrors data-pimp's demo) ------------------------------
function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key === "api" && next && !next.startsWith("--")) {
        o[key] = next;
        i++;
      } else o[key] = true;
    } else ids.push(a);
  }
  return { o, ids };
}
const { o, ids } = parseArgs(Deno.args);
// Guard against `--api` with no value (parseArgs would set it to boolean true).
const API = String(typeof o.api === "string" ? o.api : "http://localhost:8000")
  .replace(/\/+$/, "");
const AS_JSON = Boolean(o.json);
const LIVE = Boolean(o.live);

const usd = (n: number) => "$" + n.toFixed(2);
const pad = (
  s: string,
  n: number,
) => (s.length >= n ? s : s + " ".repeat(n - s.length));

// ---- scenario battery (the reference matrix + a few lifelike cases) --------
type Scenario = { title: string; note: string; input: EbayPriceInput };
const SCENARIOS: Scenario[] = [
  {
    title: "Hot item, 3 comps, fresh",
    note: "Ninja-style air fryer; undercut the cheapest credible comp",
    input: { retail: 89.99, costBasis: 0, comps: [58, 62, 65], daysListed: 0 },
  },
  {
    title: "Same item, aged 16 days",
    note: "velocity markdown kicks in — price walks down",
    input: { retail: 89.99, costBasis: 0, comps: [58, 62, 65], daysListed: 16 },
  },
  {
    title: "No comps, retail only",
    note: "anchor off the retail resale band (30%), no extra undercut",
    input: { retail: 45, costBasis: 0, comps: [], daysListed: 0 },
  },
  {
    title: "Single (noisy) comp",
    note: "one observation → gentle undercut, low confidence",
    input: { retail: 30, costBasis: 0, comps: [21.5], daysListed: 0 },
  },
  {
    title: "Market collapsed below break-even",
    note: "comps under our fee floor → floor wins, we won't list at a loss",
    input: { retail: 12, costBasis: 0, comps: [4.0, 4.5], daysListed: 25 },
  },
  {
    title: "Lowball outlier among good comps",
    note: "a predatory $5 comp is lifted by the median guard",
    input: {
      retail: 30,
      costBasis: 0,
      comps: [5, 22, 23, 24],
      condition: "used",
      daysListed: 40,
    },
  },
  {
    title: "Agency bulk lot ($8 cost), used, old, no comps",
    note: "floor-driven; still clears the $3 margin on the $8 cost",
    input: { costBasis: 8, comps: [], condition: "used", daysListed: 40 },
  },
  {
    title: "Bad buy: cost basis above retail ceiling",
    note: "floor > ceiling → flagged unprofitable-below-retail for review",
    input: { retail: 12, costBasis: 15, comps: [9, 11], daysListed: 0 },
  },
];

function flags(r: EbayPriceResult): string {
  const f: string[] = [];
  if (r.floorHit) f.push("FLOOR");
  if (r.unprofitableBelowRetail) f.push("⚠ UNPROFITABLE<RETAIL");
  if (r.lowConfidence) f.push("low-confidence");
  return f.length ? f.join(" · ") : "—";
}

function renderScenario(title: string, note: string, r: EbayPriceResult) {
  const anchor = r.anchor === null ? "—" : usd(r.anchor);
  const under = r.undercutFromAnchor === null
    ? "—"
    : (r.undercutFromAnchor >= 0
      ? `-${usd(r.undercutFromAnchor)}`
      : `+${usd(-r.undercutFromAnchor)}`);
  console.log(`\n▶ ${title}`);
  console.log(`  ${note}`);
  console.log(
    `  anchor ${pad(anchor, 8)} (${pad(r.anchorSource, 6)})  ` +
      `floor ${pad(usd(r.floor), 8)}  ceiling ${pad(usd(r.ceiling), 8)}  ` +
      `age ${pad(String(r.daysListed) + "d", 5)} ×${r.ageFactor.toFixed(2)}`,
  );
  console.log(
    `  \x1b[1m→ ${pad(usd(r.price), 9)}\x1b[0m  vs anchor ${pad(under, 9)}  ` +
      `net ${pad(usd(r.netAtPrice), 8)}  [${flags(r)}]`,
  );
  console.log(`  ${r.explanation}`);
}

function renderLadder(input: EbayPriceInput) {
  const rows = markdownLadder(input);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("Velocity walk-down (same unit, priced as it ages):");
  console.log(
    "  " + pad("day", 6) + pad("factor", 8) + pad("price", 10) + "stage",
  );
  for (const row of rows) {
    console.log(
      "  " + pad(String(row.day) + "d", 6) +
        pad("×" + row.factor.toFixed(2), 8) +
        pad(usd(row.price), 10) + (row.floorHit ? "\x1b[33m" : "") +
        row.stage + (row.floorHit ? " (floor)\x1b[0m" : ""),
    );
  }
}

// ---- live catalog pricing ---------------------------------------------------
type CatalogProduct = { productId: string; name: string; retail: number };

async function fetchCatalog(): Promise<CatalogProduct[]> {
  const r = await fetch(`${API}/api/products`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GET ${API}/api/products → HTTP ${r.status}`);
  const rows = await r.json() as Record<string, unknown>[];
  return (Array.isArray(rows) ? rows : [])
    .map((p) => ({
      productId: String(p.productId ?? ""),
      name: String(p.name ?? ""),
      retail: Number(p.min_sku_original_price) || 0,
    }))
    .filter((p) => p.productId && p.name);
}

// ---- run -------------------------------------------------------------------
// Live pricing is collected up front so BOTH output modes include it —
// --json must not silently discard --live (or the ids passed with it).
type LiveRow = {
  title: string;
  note: string;
  input: EbayPriceInput;
  result: EbayPriceResult;
  live: true;
  unpriced: boolean;
};
let liveRows: LiveRow[] = [];
let liveNote: string | null = null; // error / empty-catalog message
if (LIVE) {
  try {
    const catalog = await fetchCatalog();
    const chosen = ids.length
      ? catalog.filter((p) => ids.includes(p.productId))
      : catalog.filter((p) => p.retail > 0)
        .sort((a, b) => b.retail - a.retail)
        .slice(0, 3);
    if (!chosen.length) {
      liveNote = ids.length
        ? `no catalog products match: ${ids.join(", ")}`
        : "catalog is empty (no DATABASE_URL, or no inventory yet)";
    }
    liveRows = chosen.map((p) => {
      const input: EbayPriceInput = {
        retail: p.retail > 0 ? p.retail : undefined,
        costBasis: 0,
        comps: [],
        daysListed: 0,
      };
      return {
        title: `${p.name} [${p.productId}]`,
        note: "live LP-OS catalog product (no eBay comps → retail-anchored)",
        input,
        result: computeEbayPrice(input),
        live: true as const,
        unpriced: !(p.retail > 0),
      };
    });
  } catch (error) {
    liveNote = `catalog unreachable (${
      error instanceof Error ? error.message : String(error)
    }) — is the shell running? try --api <url>`;
  }
}

if (AS_JSON) {
  const out: unknown[] = SCENARIOS.map((s) => ({
    ...s,
    result: computeEbayPrice(s.input),
  }));
  out.push(...liveRows);
  if (LIVE && liveNote) out.push({ title: "live catalog", error: liveNote });
  console.log(JSON.stringify(out, null, 2));
  Deno.exit(0);
}

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log(
  "║  eBay pricing formula · LP-OS demo                             ║",
);
console.log(
  "║  undercut the competition · move product fast · never at a loss ║",
);
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log(
  "\nDefaults: eBay fee 13.25% + $0.30 · min net margin $3 · charm .99 · " +
    "markdown 0/7/14/21/30d → 1.00/0.93/0.85/0.75/0.65",
);

for (const s of SCENARIOS) {
  renderScenario(s.title, s.note, computeEbayPrice(s.input));
}

// Show the walk-down for the hot-item scenario.
renderLadder({ retail: 89.99, costBasis: 0, comps: [58, 62, 65] });

if (LIVE) {
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`Live catalog → price (via ${API}/api/products):`);
  if (liveNote) console.log(`\n▶ ${liveNote}`);
  for (const row of liveRows) {
    if (row.unpriced) {
      console.log(
        `\n▶ ${row.title} — unpriced product; formula falls back to the fee floor`,
      );
    }
    renderScenario(row.title, row.note, row.result);
  }
}

console.log(
  "\n✓ demo complete. Visual version: /demos/ebay-pricing (Demos → eBay Pricing in the shell)\n",
);
Deno.exit(0);
