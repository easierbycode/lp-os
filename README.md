# LP-OS

One Deno app consolidating data-pimp ("Thirsty OS"), tok-scrape's member
dashboard, and tiktok-sample-tracker.

- **Plan:** [MIGRATION_PLAN.md](MIGRATION_PLAN.md) — architecture and decisions.
- **Contracts:** [docs/CONTRACTS.md](docs/CONTRACTS.md) — concrete module
  boundaries and names.

## Quick start

```bash
cp .env.example .env         # fill in DATABASE_URL (Neon Postgres)
deno task migrate            # apply schema
deno task dev                # Fresh shell app → http://localhost:8000
deno task dev:member         # SvelteKit member dashboard
```

Mock login: open the shell with `?user=dj` (admin), `?user=ka` (warehouse), or
`?user=@boosteddealsdaily` (creator).
