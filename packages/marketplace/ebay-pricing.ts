// eBay resale pricing formula — undercut the competition AND move product fast.
//
// We resell TikTok Shop *free product samples* on eBay: a creator gets a free
// sample, makes content, then we list the physical unit. This module turns a
// product (retail/MSRP, cost basis, observed competitor prices, condition, and
// how long the unit has been sitting) into a recommended Buy-It-Now list price.
//
// Business priorities, in order:
//   1. UNDERCUT — price just below the cheapest CREDIBLE competitor so ours is
//      the most attractive Buy-It-Now.
//   2. MOVE FAST — the longer a unit sits, the more aggressively we mark it down
//      (dead inventory is dead money; cost basis is usually $0).
//   3. NEVER knowingly list at a loss after eBay fees — an inviolable, fee-aware
//      floor wins over both the undercut and the age markdown.
//
// It replaces the old naive `Math.round(retail * 0.8)` used by the E2E showcase.
//
// The engine is a pure, deterministic 10-step pipeline (STEP 0..9). It never
// throws and never returns NaN: every input is sanitized, divide-by-zero is
// guarded (1 - feePct is clamped > 0.1), and the final price is guaranteed
// finite, >= a hard minimum, >= the fee floor, and net-positive vs the target.
//
// The fee-net identity matches the sold flow in core/lifecycle.ts:
//   net = salePrice - fees - shipping - costBasis,  fees = salePrice*feePct + fixedFee
// so the floor computed here is consistent with what the resale event records.

export type EbayCondition = "new" | "used";

// One [dayThreshold, multiplier] rung of the velocity markdown ladder.
export type MarkdownRung = [day: number, factor: number];

export type EbayPriceInput = {
  // Market inputs
  retail?: number | string; // MSRP / min_sku_original_price — anchor ceiling
  costBasis?: number | string; // what we paid; 0 for free samples
  comps?: Array<number | string> | null; // observed competitor prices
  condition?: string; // "new" (default, sealed samples) | "used"
  daysListed?: number | string; // age of the unit → velocity markdown

  // Fee model
  feePct?: number | string; // eBay final value fee fraction (default 0.1325)
  fixedFee?: number | string; // per-order fixed fee $ (default 0.30)
  shipping?: number | string; // seller-borne shipping $ (default 0)

  // Floor / margin
  minMarginAbs?: number | string; // min NET profit $ (default 3.00)
  minMarginPct?: number | string; // min net margin vs costBasis (default 0)
  minListPrice?: number | string; // hard viability floor $ (default 1.00)

  // Anchor / undercut
  retailAnchorRate?: number | string; // no-comp anchor = retail*this (default 0.30)
  undercutPct?: number | string; // multi-comp undercut fraction (default 0.05)
  undercutAbs?: number | string; // multi-comp undercut floor $ (default 1.00)
  gentleUndercutPct?: number | string; // single-comp undercut fraction (default 0.03)
  gentleUndercutAbs?: number | string; // single-comp undercut floor $ (default 0.50)

  // Comp cleaning
  trimFrac?: number | string; // top fraction trimmed as outliers (default 0.10)
  medianFloorFrac?: number | string; // lone-lowball lift threshold (default 0.50)
  absurdHighMult?: number | string; // drop comps > retail*this (default 1.5)
  absurdLowMult?: number | string; // drop comps < retail*this (default 0.05)

  // Condition / ceiling / rounding
  usedMult?: number | string; // anchor haircut for used (default 0.85)
  newCeilingRate?: number | string; // ceiling = retail*this, new (default 0.95)
  usedCeilingRate?: number | string; // ceiling = retail*this, used (default 0.80)
  noRetailCeilingMult?: number | string; // ceiling = floor*this w/o retail (default 3.0)
  charmCents?: number | string; // charm target cents (default 0.99)

  // Velocity ladder — [dayThreshold, factor] rungs, or a {day: factor} map.
  markdownSchedule?: MarkdownRung[] | Record<string, number> | null;
};

export type EbayPriceResult = {
  price: number; // the recommended Buy-It-Now list price
  floor: number; // fee-aware break-even+margin floor (never priced below)
  ceiling: number; // upper clamp (retail-derived, or floor*mult w/o retail)
  anchor: number | null; // the reference we undercut from (null if floor-driven)
  anchorSource: "comp" | "retail" | "floor";
  ageFactor: number; // velocity multiplier applied for the current age
  floorHit: boolean; // the floor bound the price (market/age would've gone lower)
  unprofitableBelowRetail: boolean; // costBasis so high floor > retail ceiling
  lowConfidence: boolean; // exactly one comp — softer undercut used
  netAtPrice: number; // net after fees+shipping+cost at the recommended price
  stage: string; // human label for the current age bucket
  condition: EbayCondition;
  daysListed: number;
  compsUsed: number; // credible comps after cleaning
  undercutFromAnchor: number | null; // $ below the anchor (null if floor-driven)
  explanation: string; // one-line human summary
};

export type EbayPricingParams = {
  feePct: number;
  fixedFee: number;
  shipping: number;
  minMarginAbs: number;
  minMarginPct: number;
  minListPrice: number;
  retailAnchorRate: number;
  undercutPct: number;
  undercutAbs: number;
  gentleUndercutPct: number;
  gentleUndercutAbs: number;
  trimFrac: number;
  medianFloorFrac: number;
  absurdHighMult: number;
  absurdLowMult: number;
  usedMult: number;
  newCeilingRate: number;
  usedCeilingRate: number;
  noRetailCeilingMult: number;
  charmCents: number;
  markdownSchedule: MarkdownRung[];
};

// The default velocity ladder: day 0-6 full price, then a weekly step-down that
// saturates at 35% off for 30+ days. Factors are monotonically non-increasing so
// the recommended price only ever walks DOWN as a unit ages, and it never runs
// away past the terminal rung (or below the fee floor).
export const DEFAULT_MARKDOWN_SCHEDULE: MarkdownRung[] = [
  [0, 1.0],
  [7, 0.93],
  [14, 0.85],
  [21, 0.75],
  [30, 0.65],
];

export const DEFAULT_EBAY_PRICING: EbayPricingParams = {
  feePct: 0.1325,
  fixedFee: 0.30,
  shipping: 0,
  minMarginAbs: 3.0,
  minMarginPct: 0,
  minListPrice: 1.0,
  retailAnchorRate: 0.30,
  undercutPct: 0.05,
  undercutAbs: 1.0,
  gentleUndercutPct: 0.03,
  gentleUndercutAbs: 0.50,
  trimFrac: 0.10,
  medianFloorFrac: 0.50,
  absurdHighMult: 1.5,
  absurdLowMult: 0.05,
  usedMult: 0.85,
  newCeilingRate: 0.95,
  usedCeilingRate: 0.80,
  noRetailCeilingMult: 3.0,
  charmCents: 0.99,
  markdownSchedule: DEFAULT_MARKDOWN_SCHEDULE,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Finite number or undefined — the sanitize primitive. Strips "$"/"," so string
// prices ("$25.00") coerce cleanly. A blank/empty string is treated as ABSENT
// (undefined), not 0 — otherwise `?feePct=&minMarginAbs=` (empty params from a
// serialized form) would read as 0 via Number(""), silently zeroing the fee and
// margin and dropping the floor below its intended fee-aware value.
function num(x: unknown): number | undefined {
  if (typeof x === "number") return Number.isFinite(x) ? x : undefined;
  if (typeof x === "string") {
    const t = x.replace(/[$,\s]/g, "");
    if (t === "") return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Finite number with a default (used for tunables that must always resolve).
function numOr(x: unknown, d: number): number {
  const n = num(x);
  return n === undefined ? d : n;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Normalize a schedule (array of rungs or {day: factor} map) into sorted,
// sanitized rungs: finite day>=0, factor>0, enforced monotonically non-increasing
// (running-min) so the "only ever walks down" guarantee holds even for a
// caller-supplied ladder. Falls back to the default if nothing usable survives.
function normalizeSchedule(
  input: MarkdownRung[] | Record<string, number> | null | undefined,
): MarkdownRung[] {
  let rungs: MarkdownRung[] = [];
  if (Array.isArray(input)) {
    rungs = input
      .map((r) =>
        [num(r?.[0]), num(r?.[1])] as [number | undefined, number | undefined]
      )
      .filter((r): r is MarkdownRung =>
        r[0] !== undefined && r[1] !== undefined
      );
  } else if (input && typeof input === "object") {
    rungs = Object.entries(input)
      .map(([k, v]) =>
        [num(k), num(v)] as [number | undefined, number | undefined]
      )
      .filter((r): r is MarkdownRung =>
        r[0] !== undefined && r[1] !== undefined
      );
  }
  rungs = rungs
    .filter(([day, factor]) => day >= 0 && factor > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!rungs.length) return DEFAULT_MARKDOWN_SCHEDULE;
  // A velocity ladder only ever marks DOWN: cap every factor at 1.0 (so a
  // caller-supplied rung > 1 can't inflate the price above the anchor) and
  // enforce non-increasing factors via a running minimum.
  let prev = 1;
  return rungs.map(([day, factor]) => {
    const f = Math.min(factor, prev);
    prev = f;
    return [day, f] as MarkdownRung;
  });
}

// The velocity multiplier for a given age: the factor of the highest dayThreshold
// <= age, or 1.00 when the unit is younger than every threshold. Non-increasing
// in age by construction (schedule is sorted + running-min normalized).
function markdownFactor(age: number, schedule: MarkdownRung[]): number {
  let factor = 1.0;
  for (const [day, f] of schedule) {
    if (day <= age) factor = f;
    else break;
  }
  return factor;
}

// Human label for the current age bucket, derived from the schedule rungs so a
// custom ladder still gets sensible stage names.
function stageLabel(age: number, schedule: MarkdownRung[]): string {
  // Find the active rung and the next one (if any).
  let activeIdx = -1;
  for (let i = 0; i < schedule.length; i++) {
    if (schedule[i][0] <= age) activeIdx = i;
    else break;
  }
  if (activeIdx < 0) {
    const first = schedule[0]?.[0] ?? 0;
    return `fresh (0-${Math.max(0, first - 1)}d)`;
  }
  const start = schedule[activeIdx][0];
  const next = schedule[activeIdx + 1]?.[0];
  const off = Math.round((1 - schedule[activeIdx][1]) * 100);
  const range = next === undefined ? `${start}d+` : `${start}-${next - 1}d`;
  const label = activeIdx === 0 ? "fresh" : off >= 30 ? "clearance" : "aging";
  return off > 0 ? `${label} (${range}, -${off}%)` : `${label} (${range})`;
}

// Load the effective params for a run, applying defaults and clamping the fee
// fraction so the gross-up denominator (1 - feePct) can never be <= 0.
export function resolveParams(input: EbayPriceInput = {}): EbayPricingParams {
  const feePct = Math.min(
    0.9,
    Math.max(0, numOr(input.feePct, DEFAULT_EBAY_PRICING.feePct)),
  );
  return {
    feePct,
    fixedFee: Math.max(0, numOr(input.fixedFee, DEFAULT_EBAY_PRICING.fixedFee)),
    shipping: Math.max(0, numOr(input.shipping, DEFAULT_EBAY_PRICING.shipping)),
    minMarginAbs: Math.max(
      0,
      numOr(input.minMarginAbs, DEFAULT_EBAY_PRICING.minMarginAbs),
    ),
    minMarginPct: Math.max(
      0,
      numOr(input.minMarginPct, DEFAULT_EBAY_PRICING.minMarginPct),
    ),
    minListPrice: Math.max(
      0.01,
      numOr(input.minListPrice, DEFAULT_EBAY_PRICING.minListPrice),
    ),
    retailAnchorRate: Math.max(
      0,
      numOr(input.retailAnchorRate, DEFAULT_EBAY_PRICING.retailAnchorRate),
    ),
    undercutPct: Math.max(
      0,
      numOr(input.undercutPct, DEFAULT_EBAY_PRICING.undercutPct),
    ),
    undercutAbs: Math.max(
      0,
      numOr(input.undercutAbs, DEFAULT_EBAY_PRICING.undercutAbs),
    ),
    gentleUndercutPct: Math.max(
      0,
      numOr(input.gentleUndercutPct, DEFAULT_EBAY_PRICING.gentleUndercutPct),
    ),
    gentleUndercutAbs: Math.max(
      0,
      numOr(input.gentleUndercutAbs, DEFAULT_EBAY_PRICING.gentleUndercutAbs),
    ),
    trimFrac: Math.min(
      0.9,
      Math.max(0, numOr(input.trimFrac, DEFAULT_EBAY_PRICING.trimFrac)),
    ),
    medianFloorFrac: Math.max(
      0,
      numOr(input.medianFloorFrac, DEFAULT_EBAY_PRICING.medianFloorFrac),
    ),
    absurdHighMult: Math.max(
      1,
      numOr(input.absurdHighMult, DEFAULT_EBAY_PRICING.absurdHighMult),
    ),
    absurdLowMult: Math.max(
      0,
      numOr(input.absurdLowMult, DEFAULT_EBAY_PRICING.absurdLowMult),
    ),
    // Capped at 1: a used haircut only ever REDUCES the anchor — a value > 1
    // would raise a comp anchor and could price us above the cheapest comp
    // (same reasoning as the markdown-factor cap in normalizeSchedule).
    usedMult: Math.min(
      1,
      Math.max(0, numOr(input.usedMult, DEFAULT_EBAY_PRICING.usedMult)),
    ),
    newCeilingRate: Math.max(
      0,
      numOr(input.newCeilingRate, DEFAULT_EBAY_PRICING.newCeilingRate),
    ),
    usedCeilingRate: Math.max(
      0,
      numOr(input.usedCeilingRate, DEFAULT_EBAY_PRICING.usedCeilingRate),
    ),
    noRetailCeilingMult: Math.max(
      1,
      numOr(
        input.noRetailCeilingMult,
        DEFAULT_EBAY_PRICING.noRetailCeilingMult,
      ),
    ),
    charmCents: Math.min(
      0.99,
      Math.max(0, numOr(input.charmCents, DEFAULT_EBAY_PRICING.charmCents)),
    ),
    markdownSchedule: normalizeSchedule(input.markdownSchedule),
  };
}

/**
 * Compute the recommended eBay Buy-It-Now price for a resale unit.
 *
 * Pure and deterministic — see the STEP 0..9 pipeline below, which mirrors the
 * documented formula. Returns the price plus diagnostics (floor, ceiling, anchor,
 * why the floor/ceiling bound it, projected net) for UI/audit.
 */
export function computeEbayPrice(input: EbayPriceInput = {}): EbayPriceResult {
  const p = resolveParams(input);

  // ---- STEP 0 — SANITIZE ---------------------------------------------------
  const retailRaw = num(input.retail);
  const retail = retailRaw !== undefined && retailRaw > 0
    ? retailRaw
    : undefined;
  const costBasis = (() => {
    const c = num(input.costBasis);
    return c !== undefined && c > 0 ? c : 0;
  })();
  const condition: EbayCondition =
    String(input.condition ?? "").toLowerCase() === "used" ? "used" : "new";
  const daysListed = (() => {
    const d = num(input.daysListed);
    return d !== undefined && d > 0 ? Math.floor(d) : 0;
  })();
  let comps = (Array.isArray(input.comps) ? input.comps : [])
    .map(num)
    .filter((c): c is number => c !== undefined && c > 0);

  // ---- STEP 1a — CLEAN COMPS FOR OUTLIERS ----------------------------------
  if (retail !== undefined) {
    const hi = retail * p.absurdHighMult;
    const lo = retail * p.absurdLowMult;
    comps = comps.filter((c) => c <= hi && c >= lo);
  }
  const C = comps.slice().sort((a, b) => a - b);
  const n = C.length;

  // ---- STEP 1b — ROBUST COMP ANCHOR ----------------------------------------
  let compAnchor: number | undefined;
  let lowConfidence = false;
  if (n === 1) {
    compAnchor = C[0];
    lowConfidence = true;
  } else if (n >= 2) {
    const k = Math.min(Math.ceil(p.trimFrac * n), n - 1); // trim top outliers, keep >=1
    const trimmed = C.slice(0, n - k);
    const lowCredible = trimmed[0];
    const med = median(trimmed);
    compAnchor = lowCredible < med * p.medianFloorFrac
      ? med * p.medianFloorFrac // lift a lone lowball so it can't drag us to a loss
      : lowCredible;
  }

  // ---- STEP 2 — BASE ANCHOR + FALLBACK CHAIN -------------------------------
  let baseAnchor: number | undefined;
  let anchorSource: "comp" | "retail" | "floor";
  if (compAnchor !== undefined) {
    baseAnchor = compAnchor;
    anchorSource = "comp";
  } else if (retail !== undefined) {
    baseAnchor = retail * p.retailAnchorRate;
    anchorSource = "retail";
  } else {
    baseAnchor = undefined;
    anchorSource = "floor";
  }

  // The market reference we price against (cheapest credible comp, or the retail
  // resale anchor) BEFORE the condition haircut — this is what we report as the
  // anchor and undercut from, since the used haircut is our own adjustment, not
  // the competition's price.
  const marketAnchor = baseAnchor;

  // ---- STEP 3 — CONDITION HAIRCUT ------------------------------------------
  if (condition === "used" && baseAnchor !== undefined) {
    baseAnchor = baseAnchor * p.usedMult;
  }

  // ---- STEP 4 — UNDERCUT ---------------------------------------------------
  let priceAfterUndercut: number | undefined;
  if (anchorSource === "comp" && baseAnchor !== undefined) {
    const pct = lowConfidence ? p.gentleUndercutPct : p.undercutPct;
    const abs = lowConfidence ? p.gentleUndercutAbs : p.undercutAbs;
    const undercut = Math.max(baseAnchor * pct, abs);
    priceAfterUndercut = baseAnchor - undercut;
  } else if (anchorSource === "retail" && baseAnchor !== undefined) {
    priceAfterUndercut = baseAnchor; // retail*rate already sits below market
  } else {
    priceAfterUndercut = undefined; // floor-driven
  }

  // ---- STEP 5 — VELOCITY MARKDOWN ------------------------------------------
  const ageFactor = markdownFactor(daysListed, p.markdownSchedule);
  const priceAfterVelocity = priceAfterUndercut !== undefined
    ? priceAfterUndercut * ageFactor
    : undefined;

  // ---- STEP 6 — FEE-AWARE FLOOR (the load-bearing clamp) --------------------
  const requiredNet = costBasis +
    Math.max(p.minMarginAbs, costBasis * p.minMarginPct);
  const floorRaw = (requiredNet + p.shipping + p.fixedFee) / (1 - p.feePct);
  const absoluteFloor = round2(Math.max(floorRaw, p.minListPrice));
  let candidate = priceAfterVelocity !== undefined
    ? Math.max(priceAfterVelocity, absoluteFloor)
    : absoluteFloor;
  const floorHit = priceAfterVelocity === undefined ||
    priceAfterVelocity < absoluteFloor;

  // ---- STEP 7 — CEILING ----------------------------------------------------
  let ceiling: number;
  let unprofitableBelowRetail = false;
  if (retail !== undefined) {
    const ceilingRate = condition === "used"
      ? p.usedCeilingRate
      : p.newCeilingRate;
    ceiling = round2(retail * ceilingRate);
    if (ceiling < absoluteFloor) {
      // Cost basis so high we can't sell under retail without a loss — floor
      // wins, and we surface the conflict for human review.
      candidate = absoluteFloor;
      unprofitableBelowRetail = true;
    } else if (candidate > ceiling) {
      candidate = ceiling;
    }
  } else {
    ceiling = round2(absoluteFloor * p.noRetailCeilingMult);
    candidate = Math.max(Math.min(candidate, ceiling), absoluteFloor);
  }

  // ---- STEP 8 — CHARM ROUNDING (down to the nearest .99, floor-safe) --------
  // Round DOWN to the nearest charm price so the ask stays at/below the computed
  // undercut. If the largest charm rung ≤ candidate would breach the floor, there
  // is no charm price in [floor, candidate]; rather than charm UP to the next .99
  // — which would overshoot the anchor (breaking the undercut) or jump the ask UP
  // as the unit ages (breaking monotonicity) — we list at the exact
  // floor-respecting `candidate` (always ≥ floor). Floor-bound listings therefore
  // show the precise break-even+margin price instead of a charm .99.
  const base = Math.floor(candidate);
  let charmDown = base + p.charmCents;
  if (charmDown > candidate) charmDown = (base - 1) + p.charmCents;
  let preFinal = charmDown >= absoluteFloor ? charmDown : candidate;
  if (preFinal > ceiling && ceiling >= absoluteFloor) preFinal = ceiling;
  let finalPrice = round2(preFinal);

  // ---- STEP 9 — FINAL SAFETY + ASSEMBLE ------------------------------------
  if (!Number.isFinite(finalPrice) || finalPrice < absoluteFloor) {
    finalPrice = round2(Math.max(absoluteFloor, p.minListPrice));
  }
  const netAtPrice = round2(
    finalPrice * (1 - p.feePct) - p.fixedFee - p.shipping - costBasis,
  );

  return {
    price: finalPrice,
    floor: absoluteFloor,
    ceiling,
    anchor: marketAnchor !== undefined ? round2(marketAnchor) : null,
    anchorSource,
    ageFactor,
    floorHit,
    unprofitableBelowRetail,
    lowConfidence,
    netAtPrice,
    stage: stageLabel(daysListed, p.markdownSchedule),
    condition,
    daysListed,
    compsUsed: n,
    // Gap to the market anchor we referenced. Positive = we're below it
    // (undercutting); negative = the floor forced us above the market (won't
    // sell at a loss); null = no anchor (floor-driven, no comps and no retail).
    undercutFromAnchor: marketAnchor === undefined
      ? null
      : round2(marketAnchor - finalPrice),
    explanation: explain({
      anchorSource,
      baseAnchor: marketAnchor,
      finalPrice,
      floorHit,
      unprofitableBelowRetail,
      lowConfidence,
      ageFactor,
      condition,
      daysListed,
    }),
  };
}

function explain(o: {
  anchorSource: "comp" | "retail" | "floor";
  baseAnchor: number | undefined; // the market anchor (pre-haircut)
  finalPrice: number;
  floorHit: boolean;
  unprofitableBelowRetail: boolean;
  lowConfidence: boolean;
  ageFactor: number;
  condition: EbayCondition;
  daysListed: number;
}): string {
  const parts: string[] = [];
  const anchor = o.baseAnchor;
  // Did we actually land below the market anchor (true undercut), or did the
  // floor force us at/above it (market is below our break-even)?
  const undercutting = anchor !== undefined && o.finalPrice < anchor;
  if (o.anchorSource === "comp") {
    const which = o.lowConfidence
      ? "a single comp"
      : "the cheapest credible comp";
    const at = anchor !== undefined ? ` (~$${round2(anchor).toFixed(2)})` : "";
    parts.push(
      undercutting
        ? `undercut ${which}${at}`
        : `${which}${at} is below our break-even`,
    );
  } else if (o.anchorSource === "retail") {
    parts.push("no comps — anchored off the retail resale band");
  } else {
    parts.push("no comps or retail — driven by the fee-aware floor");
  }
  // The used haircut only bites when there is an anchor to haircut.
  if (o.condition === "used" && o.anchorSource !== "floor") {
    parts.push("used haircut applied");
  }
  if (o.daysListed > 0 && o.ageFactor < 1) {
    parts.push(
      `aged ${o.daysListed}d → ${
        Math.round((1 - o.ageFactor) * 100)
      }% velocity markdown`,
    );
  }
  if (o.floorHit) {
    parts.push("held at the break-even floor (won't list at a loss)");
  }
  if (o.unprofitableBelowRetail) {
    parts.push("⚠ floor exceeds retail ceiling — bad cost basis");
  }
  return `$${o.finalPrice.toFixed(2)}: ${parts.join(", ")}.`;
}

// Preview the full velocity walk-down for a unit: the recommended price at each
// schedule rung (holding market inputs fixed). Powers the Demos/E2E markdown
// ladder — you can watch the ask step down toward the floor as days pass.
export type MarkdownLadderRow = {
  day: number;
  factor: number;
  price: number;
  floorHit: boolean;
  stage: string;
};

export function markdownLadder(
  input: EbayPriceInput = {},
): MarkdownLadderRow[] {
  const schedule = normalizeSchedule(input.markdownSchedule);
  return schedule.map(([day]) => {
    const r = computeEbayPrice({ ...input, daysListed: day });
    return {
      day,
      factor: r.ageFactor,
      price: r.price,
      floorHit: r.floorHit,
      stage: r.stage,
    };
  });
}
