<script lang="ts">
	import type { Card } from '#lib/game.svelte.ts';

	let { card }: { card: Card } = $props();
</script>

<div class="card">
	{#if card.bank}<p class="bank">{card.bank}</p>{/if}
	<p class="title">{card.title}</p>
	{#if card.subtitle}<p class="subtitle">{card.subtitle}</p>{/if}
</div>

<style>
	.title {
		margin: 0;
		font-size: var(--line-size);
		line-height: 1.16;
		font-weight: 700;
		letter-spacing: -0.022em;
	}

	.bank {
		margin: 0 0 0.4rem;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		opacity: 0.55;
	}

	.subtitle {
		margin: 0.5rem 0 0;
		font-size: var(--choice-size);
		font-weight: 500;
		opacity: 0.6;
		font-variant-numeric: tabular-nums;
		/* A subtitle may hold a second line, e.g. a test result's plan. */
		white-space: pre-line;
	}
</style>
