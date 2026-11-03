import { absolute } from '#lib/seo/site.ts';

export const prerender = true;

export function GET(): Response {
	const sitemap = absolute('/sitemap.xml');
	const body = `User-agent: *\nAllow: /\n${sitemap ? `\nSitemap: ${sitemap}\n` : ''}`;
	return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
}
