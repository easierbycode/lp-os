import adapter from '@deno/svelte-adapter';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// Served by the lp-os shell (apps/shell/main.ts mounts the built
		// .deno-deploy handler at /member). The built server strips the base
		// itself, so the shell passes requests through untouched. Dev serves at
		// http://localhost:8080/member.
		paths: {
			base: '/member'
		},
		alias: {
			'@': 'src'
		}
	}
};

export default config;
