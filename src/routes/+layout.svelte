<script lang="ts">
	import './layout.css';
	import { asset } from '$app/paths';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={asset('favicon.svg')} type="image/svg+xml" />
	<link rel="icon" href={asset('icon-192.png')} type="image/png" sizes="192x192" />
	<link rel="apple-touch-icon" href={asset('apple-touch-icon.png')} />
	<link rel="manifest" href={asset('manifest.webmanifest')} />
	<meta name="apple-mobile-web-app-title" content="Lexical Flow" />
</svelte:head>

{@render children()}
