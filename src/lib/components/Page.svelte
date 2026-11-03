<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Backdrop from './Backdrop.svelte';

	interface Props {
		title: string;
		lead?: string;
		children: Snippet;
	}

	let { title, lead, children }: Props = $props();

	function onkeydown(e: KeyboardEvent) {
		const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
		if (e.key === 'Escape' && !typing) goto(resolve('/'));
	}
</script>

<svelte:window {onkeydown} />

<Backdrop category={undefined} />

<div class="scroller">
	<main class="page">
		<a class="back" href={resolve('/')}>← Back to the flow <kbd>Esc</kbd></a>
		<h1>{title}</h1>
		{#if lead}<p class="lead">{lead}</p>{/if}
		{@render children()}
	</main>
</div>

<style>
	.scroller {
		position: fixed;
		inset: 0;
		overflow-y: auto;
		user-select: text;
	}

	.page {
		position: relative;
		width: min(58rem, calc(100vw - 3rem));
		margin: 0 auto;
		padding: 2rem 0 5rem;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		font-size: 0.9rem;
		font-weight: 600;
		text-decoration: none;
	}

	.back:hover {
		color: var(--ink);
	}

	kbd {
		font: inherit;
		font-size: 0.8em;
		padding: 0.05em 0.4em;
		border-radius: 0.4em;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	h1 {
		margin: 2.5rem 0 0;
		font-size: var(--line-size);
		line-height: 1.1;
		font-weight: 700;
		letter-spacing: -0.022em;
	}

	.lead {
		margin: 0.6rem 0 0;
		font-size: var(--choice-size);
		color: var(--text-secondary);
	}

	:global(.page section) {
		margin-top: 3rem;
	}

	:global(.page h2) {
		margin: 0 0 1rem;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
</style>
