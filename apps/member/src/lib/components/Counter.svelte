<script lang="ts">
  let { initial = 0, label = "Svelte counter" }: {
    initial?: number;
    label?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  // We intentionally seed the counter from the initial prop once on mount;
  // later prop changes are not meant to reset the user's count.
  let count = $state(initial);
</script>

<div class="svelte-counter">
  <div class="svelte-counter__label">{label}</div>
  <div class="svelte-counter__row">
    <button type="button" onclick={() => (count -= 1)} aria-label="decrement">
      −
    </button>
    <span class="svelte-counter__value">{count}</span>
    <button type="button" onclick={() => (count += 1)} aria-label="increment">
      +
    </button>
  </div>
  <p class="svelte-counter__hint">
    Rendered by Svelte 5 (runes). Mounted by a Preact island wrapper.
  </p>
</div>

<style>
  .svelte-counter {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    background: var(--card, #232220);
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: var(--radius, 14px);
    color: var(--foreground, #f2f1ed);
    font-family: inherit;
    width: max-content;
  }
  .svelte-counter__label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted-foreground, rgba(242, 241, 237, 0.6));
  }
  .svelte-counter__row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .svelte-counter__row button {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid var(--border-2, rgba(242, 241, 237, 0.16));
    background: transparent;
    color: inherit;
    font-size: 18px;
    line-height: 1;
    transition: background 0.15s ease;
  }
  .svelte-counter__row button:hover {
    background: rgba(245, 78, 0, 0.18);
  }
  .svelte-counter__value {
    font-variant-numeric: tabular-nums;
    font-size: 1.5rem;
    font-weight: 600;
    min-width: 2ch;
    text-align: center;
  }
  .svelte-counter__hint {
    font-size: 11px;
    color: var(--muted-foreground, rgba(242, 241, 237, 0.6));
  }
</style>
