<script lang="ts">
	import { asset } from '$app/paths';
	import { SITE_DESCRIPTION, SITE_NAME, THEME_COLOR, absolute } from './site.ts';

	interface Props {
		/** Page title; the site name is appended unless this is the site name itself. */
		title?: string;
		description?: string;
		/** Path relative to the base, e.g. `/` or `/profile`. */
		path: string;
		/** Emit WebApplication structured data (the home page). */
		app?: boolean;
	}

	let { title, description = SITE_DESCRIPTION, path, app = false }: Props = $props();

	const fullTitle = $derived(title && title !== SITE_NAME ? `${title} · ${SITE_NAME}` : SITE_NAME);
	const url = $derived(absolute(path));
	const image = $derived(absolute('/og.png') ?? asset('og.png'));
	const imageAlt = 'Lexical Flow: a sentence with a missing word, four directional choices below.';

	const jsonLd = $derived(
		app
			? JSON.stringify({
					'@context': 'https://schema.org',
					'@type': 'WebApplication',
					name: SITE_NAME,
					description,
					...(url && { url }),
					image,
					applicationCategory: 'EducationalApplication',
					operatingSystem: 'Any',
					browserRequirements: 'Requires JavaScript',
					inLanguage: 'en',
					isAccessibleForFree: true,
					offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
				}).replace(/</g, '\\u003c')
			: null
	);
</script>

<svelte:head>
	<title>{fullTitle}</title>
	<meta name="description" content={description} />
	<meta name="theme-color" content={THEME_COLOR} />
	{#if url}<link rel="canonical" href={url} />{/if}

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:title" content={fullTitle} />
	<meta property="og:description" content={description} />
	{#if url}<meta property="og:url" content={url} />{/if}
	<meta property="og:image" content={image} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={imageAlt} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={fullTitle} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />
	<meta name="twitter:image:alt" content={imageAlt} />

	{#if jsonLd}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html `<script type="application/ld+json">${jsonLd}</script>`}
	{/if}
</svelte:head>
