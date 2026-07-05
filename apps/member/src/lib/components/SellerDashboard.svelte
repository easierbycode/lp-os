<script lang="ts">
  import GmvImplosion from "./GmvImplosion.svelte";
  import {
    type SellerLivePayload,
    SELLER_LIVE_PAYLOAD,
  } from "$lib/data/seller-data";

  let {
    payload = SELLER_LIVE_PAYLOAD,
  }: { payload?: SellerLivePayload } = $props();

  // Heuristic mapping for the products' `Metrics[]` array. The bookmarklet
  // captures cells in raw column order (the column set on TikTok's side
  // can drift) — these names are best-effort labels for the demo. If the
  // upstream schema shifts, only this map needs updating.
  const PRODUCT_METRIC_LABELS = [
    "Pad",
    "Impressions",
    "CTR",
    "GMV",
    "Add-to-cart",
    "Items sold",
    "Category",
  ];

  // Color the trend dots / progress bars off the channel's GMV share. We
  // parse the percent once here so the template stays declarative.
  function pct(value: string): number {
    const m = value.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }

  // Pre-compute a quick max for each performance value. Used to scale the
  // mini-bar after each value. Some metrics are dollar amounts, some are
  // percentages, some plain counts — we sort each into a "kind" so the
  // bars stay visually meaningful within their group rather than across.
  const PERF_KIND: Record<string, "pct" | "dollar" | "count" | "ratio"> = {
    "Comment rate": "pct",
    "Follow rate": "pct",
    "Tap-through rate": "pct",
    "Tap-through rate (via LIVE preview)": "pct",
    "LIVE CTR": "pct",
    "Order rate (SKU orders)": "pct",
    "Share rate": "pct",
    "Like rate": "pct",
    "GMV per hour": "dollar",
    "Show GPM": "dollar",
    "GMV Max ROI": "ratio",
    "Avg. viewing duration per view": "count",
    "Impressions": "count",
    "Views": "count",
    "Impressions per hour": "count",
    "> 1 min. views": "count",
  };

  function parsePerf(value: string, kind: "pct" | "dollar" | "count" | "ratio"): number {
    if (kind === "count") {
      // Handle "1.74K" / "21.87K" / "44".
      const m = value.match(/(\d+(?:\.\d+)?)([KM]?)/);
      if (!m) return 0;
      const n = Number(m[1]);
      return n * (m[2] === "K" ? 1_000 : m[2] === "M" ? 1_000_000 : 1);
    }
    return pct(value);
  }

  // Re-derive when `payload` changes so the bars stay in sync if a parent
  // ever swaps the prop (e.g. live polling). For the demo it computes once.
  const perfMax = $derived.by((): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const m of payload.performance) {
      const kind = PERF_KIND[m.name] ?? "count";
      out[kind] = Math.max(out[kind] ?? 0, parsePerf(m.value, kind));
    }
    return out;
  });
</script>

<section class="seller-dash">
  <header class="seller-dash__hero">
    <div class="seller-dash__shop">
      <div class="seller-dash__shop-avatar" aria-hidden="true">
        {payload.shop.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <div class="seller-dash__shop-name">@{payload.shop}</div>
        <div class="seller-dash__shop-meta">
          {payload.page} · room {payload.roomId} · {payload.duration}
        </div>
        <div class="seller-dash__shop-range">{payload.sessionRange}</div>
      </div>
    </div>

    <div class="seller-dash__kpis">
      <div class="seller-dash__kpi seller-dash__kpi--items">
        <span class="seller-dash__kpi-label">Items sold</span>
        <span class="seller-dash__kpi-value">{payload.sideKpis["Items sold"]}</span>
      </div>
      <div class="seller-dash__kpi seller-dash__kpi--viewers">
        <span class="seller-dash__kpi-label">Viewers</span>
        <span class="seller-dash__kpi-value">{payload.sideKpis["Viewers"]}</span>
      </div>
    </div>
  </header>

  <div class="seller-dash__gmv">
    <GmvImplosion gmv={payload.gmv} label="Live session GMV" />
  </div>

  <div class="seller-dash__grid">
    <article class="seller-dash__card seller-dash__card--traffic">
      <header class="seller-dash__card-header">
        <h2>Traffic source mix</h2>
        <p>Where the impressions come from — sorted by GMV share.</p>
      </header>
      <ul class="seller-dash__channels">
        {#each payload.trafficSources as ch (ch.Channel)}
          <li>
            <div class="seller-dash__channel-head">
              <span class="seller-dash__channel-name">{ch.Channel}</span>
              <span class="seller-dash__channel-gmv">{ch.GMV}</span>
            </div>
            <div class="seller-dash__channel-bar" aria-hidden="true">
              <span style:width="{pct(ch.GMV)}%"></span>
            </div>
            <div class="seller-dash__channel-foot">
              <span title="Impressions share">imp {ch.Impressions}</span>
              <span title="Views share">views {ch.Views}</span>
            </div>
          </li>
        {/each}
      </ul>
    </article>

    <article class="seller-dash__card seller-dash__card--perf">
      <header class="seller-dash__card-header">
        <h2>Performance trends</h2>
        <p>Carousel metrics, all 16 captured in one pass.</p>
      </header>
      <ul class="seller-dash__perf">
        {#each payload.performance as m (m.name)}
          {@const kind = PERF_KIND[m.name] ?? "count"}
          {@const v = parsePerf(m.value, kind)}
          {@const ratio = perfMax[kind] ? v / perfMax[kind] : 0}
          <li class="seller-dash__perf-row" data-kind={kind}>
            <span class="seller-dash__perf-name">{m.name}</span>
            <span class="seller-dash__perf-bar" aria-hidden="true">
              <span style:width="{Math.min(100, ratio * 100)}%"></span>
            </span>
            <span class="seller-dash__perf-value">{m.value}</span>
          </li>
        {/each}
      </ul>
    </article>
  </div>

  <article class="seller-dash__card seller-dash__card--products">
    <header class="seller-dash__card-header">
      <h2>Product list — {payload.products.length} items in session</h2>
      <p>
        Per-product impressions, CTR, GMV, ATC and items sold. Click a row
        to open the product on TikTok Shop.
      </p>
    </header>
    <ul class="seller-dash__products">
      {#each payload.products as p, i (p["Product ID"])}
        <li>
          <a
            class="seller-dash__product"
            href={p["Product link"]}
            target="_blank"
            rel="noreferrer"
          >
            <div class="seller-dash__product-rank" aria-hidden="true">{i + 1}</div>
            <div class="seller-dash__product-body">
              <div class="seller-dash__product-name">{p["Product name"]}</div>
              <div class="seller-dash__product-id">ID {p["Product ID"]}</div>
              <dl class="seller-dash__product-metrics">
                {#each p.Metrics as cell, j}
                  {#if cell && PRODUCT_METRIC_LABELS[j]}
                    <div>
                      <dt>{PRODUCT_METRIC_LABELS[j]}</dt>
                      <dd>{cell}</dd>
                    </div>
                  {/if}
                {/each}
              </dl>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  </article>

  <footer class="seller-dash__footer">
    Snapshot scraped {payload.scrapedAt}
  </footer>
</section>

<style>
  .seller-dash {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    color: var(--foreground, #f2f1ed);
    font-family: inherit;
  }

  /* ── Hero ──────────────────────────────────────────────────────────── */
  .seller-dash__hero {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1.5rem;
    align-items: start;
    padding: 1.25rem 1.5rem;
    background:
      linear-gradient(135deg, rgba(245, 78, 0, 0.18), transparent 70%),
      var(--card, #232220);
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: 14px;
  }
  .seller-dash__shop {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .seller-dash__shop-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: linear-gradient(140deg, #f54e00, #fbbf24);
    color: #1a1916;
    font-weight: 800;
    font-size: 14px;
    letter-spacing: 0.05em;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
  .seller-dash__shop-name {
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .seller-dash__shop-meta {
    margin-top: 0.125rem;
    font-size: 0.875rem;
    color: rgba(242, 241, 237, 0.6);
  }
  .seller-dash__shop-range {
    margin-top: 0.125rem;
    font-size: 0.75rem;
    color: rgba(242, 241, 237, 0.45);
    font-variant-numeric: tabular-nums;
  }

  .seller-dash__kpis {
    display: flex;
    gap: 0.75rem;
  }
  .seller-dash__kpi {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.125rem;
    padding: 0.625rem 1rem;
    border-radius: 999px;
    background: rgba(242, 241, 237, 0.05);
    border: 1px solid rgba(242, 241, 237, 0.08);
    min-width: 110px;
  }
  .seller-dash__kpi-label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(242, 241, 237, 0.6);
  }
  .seller-dash__kpi-value {
    font-size: 1.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .seller-dash__kpi--items {
    box-shadow: inset 0 0 0 1px rgba(255, 194, 64, 0.4);
  }
  .seller-dash__kpi--viewers {
    box-shadow: inset 0 0 0 1px rgba(52, 207, 204, 0.4);
  }

  /* ── GMV slot ──────────────────────────────────────────────────────── */
  .seller-dash__gmv {
    display: block;
  }

  /* ── Two-column grid: traffic + perf ───────────────────────────────── */
  .seller-dash__grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
  }
  @media (min-width: 900px) {
    .seller-dash__grid {
      grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    }
  }

  .seller-dash__card {
    padding: 1.25rem 1.5rem;
    background: var(--card, #232220);
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: 14px;
  }
  .seller-dash__card-header h2 {
    margin: 0;
    font-family: "Iowan Old Style", "Georgia", serif;
    font-size: 1.25rem;
    letter-spacing: -0.01em;
  }
  .seller-dash__card-header p {
    margin: 0.25rem 0 1rem;
    font-size: 0.875rem;
    color: rgba(242, 241, 237, 0.55);
  }

  /* ── Channels ──────────────────────────────────────────────────────── */
  .seller-dash__channels {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .seller-dash__channels li {
    padding: 0.5rem 0;
  }
  .seller-dash__channel-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.375rem;
    font-size: 0.875rem;
  }
  .seller-dash__channel-name {
    font-weight: 600;
  }
  .seller-dash__channel-gmv {
    font-variant-numeric: tabular-nums;
    color: #f54e00;
  }
  .seller-dash__channel-bar {
    display: block;
    height: 6px;
    background: rgba(242, 241, 237, 0.06);
    border-radius: 999px;
    overflow: hidden;
  }
  .seller-dash__channel-bar > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #f54e00, #fbbf24);
    border-radius: 999px;
    transition: width 600ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .seller-dash__channel-foot {
    display: flex;
    gap: 1rem;
    margin-top: 0.375rem;
    font-size: 0.75rem;
    color: rgba(242, 241, 237, 0.45);
    font-variant-numeric: tabular-nums;
  }

  /* ── Perf rows ─────────────────────────────────────────────────────── */
  .seller-dash__perf {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem;
  }
  @media (min-width: 700px) {
    .seller-dash__perf {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem 1.25rem;
    }
  }
  .seller-dash__perf-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 80px auto;
    gap: 0.5rem;
    align-items: center;
    padding: 0.25rem 0;
    font-size: 0.8125rem;
    border-bottom: 1px dashed rgba(242, 241, 237, 0.05);
  }
  .seller-dash__perf-name {
    color: rgba(242, 241, 237, 0.75);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .seller-dash__perf-bar {
    display: block;
    height: 4px;
    background: rgba(242, 241, 237, 0.06);
    border-radius: 999px;
    overflow: hidden;
  }
  .seller-dash__perf-bar > span {
    display: block;
    height: 100%;
    border-radius: 999px;
  }
  .seller-dash__perf-row[data-kind="pct"] .seller-dash__perf-bar > span {
    background: #34cfcc;
  }
  .seller-dash__perf-row[data-kind="dollar"] .seller-dash__perf-bar > span {
    background: #fbbf24;
  }
  .seller-dash__perf-row[data-kind="count"] .seller-dash__perf-bar > span {
    background: #f54e00;
  }
  .seller-dash__perf-row[data-kind="ratio"] .seller-dash__perf-bar > span {
    background: #e8650a;
  }
  .seller-dash__perf-value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-align: right;
  }

  /* ── Products grid ─────────────────────────────────────────────────── */
  .seller-dash__products {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }
  .seller-dash__products > li {
    margin: 0;
  }
  .seller-dash__product {
    position: relative;
    display: flex;
    gap: 0.75rem;
    padding: 1rem 1rem 1rem 1.5rem;
    background: linear-gradient(
      150deg,
      rgba(245, 78, 0, 0.08),
      rgba(242, 241, 237, 0.02)
    );
    border: 1px solid rgba(242, 241, 237, 0.08);
    border-radius: 12px;
    color: inherit;
    text-decoration: none;
    transition: transform 200ms ease, border-color 200ms ease,
      background 200ms ease;
    overflow: hidden;
  }
  .seller-dash__product::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    background: linear-gradient(180deg, #f54e00, #fbbf24);
    opacity: 0.65;
  }
  .seller-dash__product:hover {
    transform: translateY(-2px);
    border-color: rgba(245, 78, 0, 0.4);
    background: linear-gradient(
      150deg,
      rgba(245, 78, 0, 0.16),
      rgba(242, 241, 237, 0.03)
    );
  }
  .seller-dash__product-rank {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1;
    color: rgba(245, 78, 0, 0.8);
    flex-shrink: 0;
  }
  .seller-dash__product-body {
    flex: 1;
    min-width: 0;
  }
  .seller-dash__product-name {
    font-weight: 600;
    font-size: 0.875rem;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .seller-dash__product-id {
    margin-top: 0.25rem;
    font-size: 0.6875rem;
    color: rgba(242, 241, 237, 0.4);
    font-variant-numeric: tabular-nums;
  }
  .seller-dash__product-metrics {
    margin: 0.625rem 0 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.375rem 0.625rem;
  }
  .seller-dash__product-metrics > div {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }
  .seller-dash__product-metrics dt {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(242, 241, 237, 0.45);
    margin: 0;
  }
  .seller-dash__product-metrics dd {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* ── Footer ────────────────────────────────────────────────────────── */
  .seller-dash__footer {
    font-size: 0.75rem;
    color: rgba(242, 241, 237, 0.4);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
