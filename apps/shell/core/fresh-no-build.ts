// Must stay main.ts's FIRST import. On Deno Deploy, Fresh 2.x sees
// DENO_DEPLOYMENT_ID and refuses to serve without a vite-built _fresh/
// snapshot ("Could not find _fresh directory") — but this app is a
// programmatic, no-build Fresh server (no islands/JSX; static assets are
// served by main.ts's own middleware), for which Fresh's MockBuildCache
// fallback is the intended path. jsr:@fresh/build-id captures the variable
// once at module init, so hiding it here — before the fresh import evaluates
// — lets production mode run unbuilt. No LP-OS code reads it.
try {
  Deno.env.delete("DENO_DEPLOYMENT_ID");
} catch {
  // no --allow-env: the variable is invisible to Fresh anyway
}
