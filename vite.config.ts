import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// GitHub Pages serves project sites from /<repo>; CI sets BASE_PATH accordingly.
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;
// Absolute site URL including the base path (e.g. https://user.github.io/repo), used for
// canonical links, Open Graph and the sitemap. Unset locally: those fall back or are omitted.
const site = (process.env.SITE_URL ?? '').replace(/\/+$/, '');

export default defineConfig({
	define: {
		__SITE_URL__: JSON.stringify(site)
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ strict: true }),
			paths: { base },
			// Endpoints nothing links to still need prerendering.
			prerender: { entries: ['*', '/sitemap.xml', '/robots.txt'] }
		})
	]
});
