// Post-build fixups for @deno/svelte-adapter 0.2.x output, run after every
// `vite build` (wired into the build scripts here and in deno.json). The
// adapter has four gaps this script closes so the app serves correctly under
// the lp-os shell at the /member base path (kit.paths.base in
// svelte.config.js):
//
// 1. deploy.json `staticFiles`/`headers` sources are NOT base-prefixed (the
//    immutable rule is hardcoded "/_app/immutable/:file*" and asset sources
//    are "/<rel>") even though the client files are written to
//    .deno-deploy/static/member/... — prefix every source with /member.
// 2. The immutable ":file*" DYNAMIC rule is broken twice over: its hardcoded
//    destination misses the base segment, and @deno/experimental-route-config
//    path.join()s destinations against the app root before substituting
//    ":file*" — on Windows that turns the separator before ":file*" into "\"
//    and its /:name pattern regex no longer matches, so the literal ":file*"
//    path 500s. Replace the dynamic rule with enumerated per-file STATIC
//    rules (the immutable set is fixed at build time), which use a plain map
//    lookup on every platform.
// 3. The Vite-built service-worker.js is never enumerated (it is client build
//    output, not a static/ asset), so the PWA service worker 404s — append
//    its route.
// 4. Asset destinations are path.join()ed by the adapter, which emits "\" on
//    Windows builds — normalize to forward slashes.
//
// The script is idempotent and FAILS LOUDLY (exit 1) if the adapter's output
// no longer looks like what it patches — an adapter upgrade must be reviewed
// against this file (see docs/CONTRACTS.md "Member app").
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = '/member';
const STATIC_ROOT = `.deno-deploy/static${BASE}`;

const failures = [];
function fail(message) {
	failures.push(message);
}

const deployJson = new URL('../.deno-deploy/deploy.json', import.meta.url);
if (!existsSync(deployJson)) {
	console.error('patch-deploy: .deno-deploy/deploy.json not found (run build first)');
	process.exit(1);
}

const config = JSON.parse(readFileSync(deployJson, 'utf8'));
config.headers ??= [];
config.redirects ??= [];
config.staticFiles ??= [];

const slashes = (value) => value.replaceAll('\\', '/');
const prefixed = (source) => (source.startsWith(BASE) ? source : BASE + source);

// (1)+(4) base-prefix sources, normalize destination separators. Prerendered
// page sources (and redirect pathnames), if ever added, already include the
// base — hence the startsWith guard in prefixed().
for (const rule of config.staticFiles) {
	rule.source = prefixed(rule.source);
	rule.destination = slashes(rule.destination);
}
for (const rule of config.redirects) {
	rule.source = prefixed(rule.source);
	rule.destination = prefixed(rule.destination); // redirect destination is a pathname
}
for (const rule of config.headers) {
	rule.source = prefixed(rule.source);
}

// (2) swap the broken dynamic immutable rule for enumerated static rules.
// On first run the adapter's hardcoded rule (now base-prefixed) must be
// there; on re-runs it is already gone — require one or the other so an
// adapter layout change cannot slip through silently.
const immutableSource = `${BASE}/_app/immutable/:file*`;
const hadDynamicRule = config.staticFiles.some((r) => r.source === immutableSource);
const hadEnumerated = config.staticFiles.some((r) =>
	r.source.startsWith(`${BASE}/_app/immutable/`) && !r.source.includes(':')
);
if (!hadDynamicRule && !hadEnumerated) {
	fail(`missing staticFiles rule(s) for ${BASE}/_app/immutable/ — adapter output changed?`);
}
config.staticFiles = config.staticFiles.filter(
	(r) => !r.source.startsWith(`${BASE}/_app/immutable/`)
);

const outRoot = new URL(`../${STATIC_ROOT}/`, import.meta.url);
const immutableDir = new URL('_app/immutable/', outRoot);
const immutableFiles = [];
function walk(dir, rel) {
	if (!existsSync(fileURLToPath(dir))) return;
	for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
		const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), entryRel);
		else if (entry.isFile()) immutableFiles.push(entryRel);
	}
}
walk(immutableDir, '');
if (immutableFiles.length === 0) {
	fail(`no files found under ${STATIC_ROOT}/_app/immutable/ — build output missing?`);
}
immutableFiles.sort();
for (const rel of immutableFiles) {
	const encoded = rel.split('/').map(encodeURIComponent).join('/');
	config.staticFiles.push({
		source: `${BASE}/_app/immutable/${encoded}`,
		destination: `${STATIC_ROOT}/_app/immutable/${rel}`
	});
}

// (3) service worker route (Vite build output, not enumerated from static/).
const swRule = {
	source: `${BASE}/service-worker.js`,
	destination: `${STATIC_ROOT}/service-worker.js`
};
if (!config.staticFiles.some((r) => r.source === swRule.source)) {
	config.staticFiles.push(swRule);
}

/* ------------------------------------------------- loud-failure checks -- */

// Immutable Cache-Control header rule must survive, base-prefixed. Its
// URLPattern SOURCE (no destination) works on every platform, so the dynamic
// form stays and covers all enumerated files.
const immutableHeader = config.headers.find(
	(r) =>
		r.source === immutableSource &&
		(r.headers ?? []).some(
			(h) => h.key?.toLowerCase() === 'cache-control' && /immutable/.test(h.value ?? '')
		)
);
if (!immutableHeader) {
	fail(`missing immutable Cache-Control headers rule for ${immutableSource}`);
}

for (const rule of config.staticFiles) {
	if (!rule.source.startsWith(BASE + '/')) {
		fail(`staticFiles source not under ${BASE}/: ${rule.source}`);
	}
	if (!rule.destination.startsWith(STATIC_ROOT + '/')) {
		fail(`staticFiles destination not under ${STATIC_ROOT}/: ${rule.destination}`);
	}
	if (rule.destination.includes('\\')) {
		fail(`staticFiles destination still has backslashes: ${rule.destination}`);
	}
	if (rule.destination.includes(':')) {
		fail(`staticFiles destination still has a pattern (breaks on Windows): ${rule.destination}`);
	}
}

// The build output the rules point at must actually exist.
for (const rel of ['_app/immutable', 'service-worker.js', 'manifest.webmanifest']) {
	if (!existsSync(fileURLToPath(new URL(rel, outRoot)))) {
		fail(`expected build output missing: ${STATIC_ROOT}/${rel}`);
	}
}

if (failures.length > 0) {
	for (const message of failures) console.error(`patch-deploy: ${message}`);
	console.error('patch-deploy: FAILED — refusing to write a broken deploy.json');
	process.exit(1);
}

writeFileSync(deployJson, JSON.stringify(config, null, 2) + '\n');
console.log(
	`patch-deploy: ${config.staticFiles.length} static routes under ${BASE} ` +
		`(${immutableFiles.length} immutable), service-worker + Cache-Control rules verified`
);
