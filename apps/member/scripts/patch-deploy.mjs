// @deno/svelte-adapter 0.2.x enumerates static/ files into .deno-deploy/
// deploy.json but misses the Vite-built service-worker.js, so the PWA's
// service worker 404s and never installs. Append its route after every build
// (wired into the build scripts here and in deno.json).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const deployJson = new URL('../.deno-deploy/deploy.json', import.meta.url);
if (!existsSync(deployJson)) {
	console.error('patch-deploy: .deno-deploy/deploy.json not found (run build first)');
	process.exit(1);
}

const config = JSON.parse(readFileSync(deployJson, 'utf8'));
config.staticFiles ??= [];
const rule = {
	source: '/service-worker.js',
	destination: '.deno-deploy/static/service-worker.js'
};
if (!config.staticFiles.some((r) => r.source === rule.source)) {
	config.staticFiles.push(rule);
	writeFileSync(deployJson, JSON.stringify(config, null, 2) + '\n');
	console.log('patch-deploy: added /service-worker.js static route');
} else {
	console.log('patch-deploy: /service-worker.js route already present');
}
