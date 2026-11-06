<script lang="ts">
	import { glossMeanings } from '#lib/game.svelte.ts';
	import type { GlossLanguage } from '#lib/progress.ts';
	import type { PartOfSpeech, WordInfo } from '#lib/types.ts';

	interface Props {
		info: WordInfo;
		language: GlossLanguage;
		/** A word to study: the meaning reads at full strength. */
		strong?: boolean;
	}

	let { info, language, strong = false }: Props = $props();

	const POS: Record<PartOfSpeech, string> = { n: 'n.', v: 'v.', adj: 'adj.', adv: 'adv.' };
	const meaning = $derived(glossMeanings(info, language));
</script>

<!-- The learner's own language comes first: L1 glosses teach best. -->
<div class={['gloss', strong && 'strong']}>
	{#if meaning.zh}<p class="zh" lang="zh-Hant">{meaning.zh}</p>{/if}
	<p class="entry">
		<span class="word" lang="en">{info.word}</span>
		{#if info.ipa}<span class="ipa">/{info.ipa}/</span>{/if}
		<span class="pos">{POS[info.pos]}</span>
		{#if meaning.en}<span class="en">{meaning.en}</span>{/if}
	</p>
</div>

<style>
	.gloss {
		margin-top: 0.7rem;
		font-size: calc(var(--choice-size) * 0.8);
		line-height: 1.4;
		color: var(--text-secondary);
		text-wrap: pretty;
		/* A beat late, so the choices have mostly made room when the text shows. */
		animation: gloss-in 220ms ease-out 60ms both;
	}

	p {
		margin: 0;
	}

	.zh {
		font-size: 1.12em;
		font-weight: 500;
		letter-spacing: 0.02em;
	}

	.strong .zh {
		color: var(--ink);
	}

	.zh + .entry {
		margin-top: 0.1rem;
	}

	.word {
		color: var(--ink);
		font-weight: 600;
	}

	.ipa {
		margin-left: 0.3em;
		color: var(--text-muted);
	}

	.pos {
		margin-left: 0.3em;
		font-style: italic;
		color: var(--text-muted);
	}

	.en::before {
		content: '·';
		margin: 0 0.45em 0 0.35em;
		color: var(--text-muted);
	}

	@keyframes gloss-in {
		from {
			opacity: 0;
			transform: translateY(-3px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.gloss {
			animation: none;
		}
	}
</style>
