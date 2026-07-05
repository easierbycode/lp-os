import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	esbuild: {
		// Avoid loading tsconfig.json during esbuild transforms — it extends
		// .svelte-kit/tsconfig.json which doesn't exist on a fresh checkout.
		tsconfigRaw: '{}'
	},
	server: {
		host: true,
		port: 8080
	}
});
