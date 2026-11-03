<script lang="ts">
	import type { Card } from '#lib/game.svelte.ts';

	let { card }: { card: Card } = $props();
</script>

<div class="card">
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

	.subtitle {
		margin: 0.5rem 0 0;
		font-size: var(--choice-size);
		font-weight: 500;
		opacity: 0.6;
		font-variant-numeric: tabular-nums;
	}
</style>
