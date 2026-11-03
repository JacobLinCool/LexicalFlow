import { PAGES, absolute } from '#lib/seo/site.ts';

export const prerender = true;

/** Sitemaps need absolute URLs, so pages are listed only when SITE_URL is set at build time. */
export function GET(): Response {
	const urls = PAGES.map((page) => absolute(page))
		.filter((url): url is string => url !== null)
		.map((url) => `\t<url><loc>${url}</loc></url>`)
		.join('\n');
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
	return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
