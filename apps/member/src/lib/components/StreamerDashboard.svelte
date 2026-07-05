<script lang="ts">
  import {
    type StreamerPayload,
    STREAMER_PAYLOAD,
  } from "$lib/data/streamer-data";

  let {
    payload = STREAMER_PAYLOAD,
  }: { payload?: StreamerPayload } = $props();

  // Extract numeric magnitude + sign from a delta string like "+0.00",
  // "-79.25%" so the trend pill can color-code on direction and magnitude.
  function deltaSign(s: string): "up" | "down" | "flat" {
    const v = parseFloat(s.replace(/[^0-9.\-]/g, "")) || 0;
    if (v > 0.001) return "up";
    if (v < -0.001) return "down";
    return "flat";
  }

  // For per-video bars: sort metrics by name into a stable display order
  // and parse a magnitude for the bar width. Some metrics are dollars
  // (GMV), some are percents (CTR, Completion), some are counts (Views,
  // Items sold). Each kind scales independently across the video set.
  type Kind = "dollar" | "pct" | "count";
  const KIND: Record<string, Kind> = {
    GMV: "dollar",
    Views: "count",
    "Items sold": "count",
    "New followers": "count",
    CTR: "pct",
    Completion: "pct",
  };

  function parseValue(value: string, kind: Kind): number {
    const m = value.match(/-?\d+(?:[,.]\d+)*/);
    if (!m) return 0;
    const n = Number(m[0].replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  // Find the global max per kind so per-video bars stay comparable across
  // the whole video stack (rather than re-normalizing per row).
  const videoKindMax = $derived.by((): Record<Kind, number> => {
    const out: Record<Kind, number> = { dollar: 0, pct: 0, count: 0 };
    for (const v of payload.videos) {
      for (const m of v.Metrics) {
        const k = KIND[m.name];
        if (!k) continue;
        const n = parseValue(m.value, k);
        if (n > out[k]) out[k] = n;
      }
    }
    return out;
  });

  function videoMaxFor(name: string): number {
    const k = KIND[name];
    return k ? videoKindMax[k] : 0;
  }

  // Pretty bullet for the trend direction.
  function trendGlyph(s: "up" | "down" | "flat"): string {
    return s === "up" ? "▲" : s === "down" ? "▼" : "·";
  }
</script>

<section class="streamer-dash">
  <header class="streamer-dash__hero">
    <div class="streamer-dash__hero-left">
      <div class="streamer-dash__page">{payload.page}</div>
      <h1 class="streamer-dash__title">Streamer Compass</h1>
      <p class="streamer-dash__sub">
        Your own video performance — sampled by
        <code>bookmarklet-streamer.js</code> from
        <code>shop.tiktok.com/streamer/compass/video-analysis/view</code>.
      </p>
    </div>
    <aside class="streamer-dash__date">
      <span class="streamer-dash__date-label">{payload.dateLabel}</span>
      <span class="streamer-dash__date-range">
        {payload.dateRange.start} → {payload.dateRange.end}
      </span>
    </aside>
  </header>

  <div class="streamer-dash__kpis">
    {#each payload.metrics as m, i (m.name)}
      {@const dir = deltaSign(m.delta)}
      <article class="streamer-dash__kpi" data-dir={dir} style:--i={i}>
        <span class="streamer-dash__kpi-name">{m.name}</span>
        <div class="streamer-dash__kpi-value">
          {#if m.currency}
            <span class="streamer-dash__kpi-currency">{m.currency}</span>
          {/if}
          <span class="streamer-dash__kpi-number">{m.value}</span>
        </div>
        <span class="streamer-dash__kpi-delta" data-dir={dir}>
          <span aria-hidden="true">{trendGlyph(dir)}</span>
          {m.delta} <em>vs prior period</em>
        </span>
      </article>
    {/each}
  </div>

  <article class="streamer-dash__card">
    <header class="streamer-dash__card-header">
      <h2>Video stack — {payload.videos.length} clips</h2>
      <p>
        Per-video metrics from the seller's own dashboard. Bars compare each
        clip against the strongest in the set for that metric kind.
      </p>
    </header>
    <ul class="streamer-dash__videos">
      {#each payload.videos as v, i (v.Title + i)}
        <li class="streamer-dash__video">
          <div class="streamer-dash__video-thumb">
            <img src={v.Thumbnail} alt="" loading="lazy" />
            <span class="streamer-dash__video-duration">{v.Duration}</span>
          </div>
          <div class="streamer-dash__video-body">
            <div class="streamer-dash__video-head">
              <h3 class="streamer-dash__video-title">{v.Title}</h3>
              <span class="streamer-dash__video-posted">{v.Posted}</span>
            </div>
            <ul class="streamer-dash__video-metrics">
              {#each v.Metrics as m}
                {@const max = videoMaxFor(m.name)}
                {@const kind = KIND[m.name] ?? null}
                {@const cur = kind ? parseValue(m.value, kind) : 0}
                {@const ratio = max ? cur / max : 0}
                <li>
                  <span class="streamer-dash__vm-name">{m.name}</span>
                  <span class="streamer-dash__vm-value">{m.value}</span>
                  {#if kind}
                    <span class="streamer-dash__vm-bar" data-kind={kind}>
                      <span style:width="{Math.min(100, ratio * 100)}%"></span>
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        </li>
      {/each}
    </ul>
  </article>

  <footer class="streamer-dash__footer">
    Snapshot scraped {payload.scrapedAt}
  </footer>
</section>

<style>
  .streamer-dash {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    color: var(--foreground, #f2f1ed);
    font-family: inherit;
  }

  /* ── Hero ──────────────────────────────────────────────────────────── */
  .streamer-dash__hero {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1.25rem;
    align-items: end;
    padding: 1.5rem;
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: 14px;
    background:
      radial-gradient(at 100% 0%, rgba(52, 207, 204, 0.18), transparent 60%),
      radial-gradient(at 0% 100%, rgba(245, 78, 0, 0.18), transparent 50%),
      var(--card, #232220);
  }
  .streamer-dash__page {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: rgba(242, 241, 237, 0.5);
  }
  .streamer-dash__title {
    margin: 0.25rem 0 0;
    font-family: "Iowan Old Style", "Georgia", serif;
    font-size: 2rem;
    letter-spacing: -0.02em;
    line-height: 1.05;
  }
  .streamer-dash__sub {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: rgba(242, 241, 237, 0.6);
  }
  .streamer-dash__sub code {
    font-size: 0.8125rem;
    color: rgba(242, 241, 237, 0.85);
    background: rgba(242, 241, 237, 0.06);
    padding: 0.0625rem 0.375rem;
    border-radius: 4px;
  }
  .streamer-dash__date {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 0.625rem 0.875rem;
    border: 1px solid rgba(52, 207, 204, 0.4);
    border-radius: 999px;
    background: rgba(52, 207, 204, 0.06);
  }
  .streamer-dash__date-label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(52, 207, 204, 0.95);
    font-weight: 600;
  }
  .streamer-dash__date-range {
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    margin-top: 0.125rem;
    color: rgba(242, 241, 237, 0.85);
  }

  /* ── KPI strip — five tiles, animated entrance ─────────────────────── */
  .streamer-dash__kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
  }
  .streamer-dash__kpi {
    --accent: #f54e00;
    position: relative;
    padding: 1rem 1.125rem;
    background: var(--card, #232220);
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: 12px;
    overflow: hidden;
    animation: kpi-rise 600ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(var(--i) * 70ms);
  }
  .streamer-dash__kpi[data-dir="up"]   { --accent: #34cfcc; }
  .streamer-dash__kpi[data-dir="down"] { --accent: #ef4444; }
  .streamer-dash__kpi[data-dir="flat"] { --accent: #fbbf24; }
  .streamer-dash__kpi::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent);
    opacity: 0.85;
  }
  @keyframes kpi-rise {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .streamer-dash__kpi-name {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(242, 241, 237, 0.6);
  }
  .streamer-dash__kpi-value {
    margin-top: 0.5rem;
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    font-variant-numeric: tabular-nums;
  }
  .streamer-dash__kpi-currency {
    font-size: 1rem;
    color: rgba(242, 241, 237, 0.55);
  }
  .streamer-dash__kpi-number {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .streamer-dash__kpi-delta {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.5rem;
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    border-radius: 999px;
    background: color-mix(in oklch, var(--accent), transparent 88%);
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .streamer-dash__kpi-delta em {
    font-style: normal;
    color: rgba(242, 241, 237, 0.55);
    margin-left: 0.25rem;
  }

  /* ── Cards ─────────────────────────────────────────────────────────── */
  .streamer-dash__card {
    padding: 1.25rem 1.5rem;
    background: var(--card, #232220);
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: 14px;
  }
  .streamer-dash__card-header h2 {
    margin: 0;
    font-family: "Iowan Old Style", "Georgia", serif;
    font-size: 1.25rem;
    letter-spacing: -0.01em;
  }
  .streamer-dash__card-header p {
    margin: 0.25rem 0 1.25rem;
    font-size: 0.875rem;
    color: rgba(242, 241, 237, 0.55);
  }

  /* ── Video stack ───────────────────────────────────────────────────── */
  .streamer-dash__videos {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  .streamer-dash__video {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 1rem;
    padding: 0.75rem;
    border: 1px solid rgba(242, 241, 237, 0.08);
    border-radius: 10px;
    transition: border-color 200ms ease, background 200ms ease;
  }
  .streamer-dash__video:hover {
    border-color: rgba(245, 78, 0, 0.3);
    background: rgba(245, 78, 0, 0.04);
  }
  .streamer-dash__video-thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #1a1916;
    border-radius: 8px;
    overflow: hidden;
  }
  .streamer-dash__video-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .streamer-dash__video-duration {
    position: absolute;
    bottom: 0.375rem;
    right: 0.375rem;
    padding: 0.125rem 0.375rem;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    background: rgba(0, 0, 0, 0.65);
    color: white;
    border-radius: 4px;
    backdrop-filter: blur(4px);
  }
  .streamer-dash__video-body {
    min-width: 0;
  }
  .streamer-dash__video-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.625rem;
  }
  .streamer-dash__video-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.35;
    flex: 1;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .streamer-dash__video-posted {
    font-size: 0.75rem;
    color: rgba(242, 241, 237, 0.5);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .streamer-dash__video-metrics {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.5rem 1rem;
  }
  .streamer-dash__video-metrics li {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: 0 0.5rem;
    padding: 0.25rem 0;
  }
  .streamer-dash__vm-name {
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgba(242, 241, 237, 0.55);
  }
  .streamer-dash__vm-value {
    font-size: 0.875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .streamer-dash__vm-bar {
    grid-column: 1 / -1;
    display: block;
    height: 3px;
    background: rgba(242, 241, 237, 0.06);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 0.25rem;
  }
  .streamer-dash__vm-bar > span {
    display: block;
    height: 100%;
    border-radius: 999px;
    transition: width 600ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .streamer-dash__vm-bar[data-kind="dollar"] > span { background: #fbbf24; }
  .streamer-dash__vm-bar[data-kind="count"]  > span { background: #f54e00; }
  .streamer-dash__vm-bar[data-kind="pct"]    > span { background: #34cfcc; }

  .streamer-dash__footer {
    text-align: right;
    font-size: 0.75rem;
    color: rgba(242, 241, 237, 0.4);
    font-variant-numeric: tabular-nums;
  }
</style>
