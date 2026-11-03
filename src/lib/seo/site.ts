declare const __SITE_URL__: string;

export const SITE_NAME = 'Lexical Flow';
export const SITE_DESCRIPTION =
	'A lyrics-style vocabulary game: sentences stream past, each missing a word, and you pick it from four directions before the line runs out.';
export const THEME_COLOR = '#1a1c24';

/** Absolute site URL including the base path, without a trailing slash; empty when unset. */
export const SITE_URL: string = __SITE_URL__;

/** Absolute URL for a path relative to the base (e.g. `/profile`), or null without SITE_URL. */
export function absolute(path: string): string | null {
	if (!SITE_URL) return null;
	return SITE_URL + (path.startsWith('/') ? path : `/${path}`);
}

/** Pages listed in the sitemap, relative to the base path. */
export const PAGES = ['/', '/profile', '/banks'];
