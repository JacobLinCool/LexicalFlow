<script lang="ts">
	import type { Phase } from '#lib/game.svelte.ts';
	import type { Question, Result } from '#lib/types.ts';

	interface Props {
		question: Question;
		result: Result | null;
		active: boolean;
		phase: Phase;
	}

	let { question, result, active, phase }: Props = $props();

	const parts = $derived(question.sentence.split('___'));
	const word = $derived(question.choices[question.answer]);
	const running = $derived(active && phase === 'active');
	const showTimer = $derived(active && (phase === 'active' || phase === 'locked'));
</script>

<p class="sentence">
	{parts[0]}<span
		class={['blank', result && `filled ${result.outcome}`]}
		>{#if result}{word}{:else}<span class="gap" aria-label="blank"
				>{#if showTimer}<span class={['timer', !running && 'stopped']} aria-hidden="true"></span>{/if}</span
			>{/if}</span
	>{parts.slice(1).join('___')}
</p>

<style>
	.sentence {
		margin: 0;
		font-size: var(--line-size);
		line-height: 1.16;
		font-weight: 700;
		letter-spacing: -0.022em;
		text-wrap: pretty;
	}

	.blank {
		position: relative;
		display: inline-block;
		vertical-align: baseline;
		transition: color 150ms ease;
	}

	.gap {
		position: relative;
		display: inline-block;
		width: 3.4em;
		height: 0.1em;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.3);
		vertical-align: 0.02em;
	}

	.filled.correct {
		color: var(--positive);
	}

	.filled.incorrect,
	.filled.timeout {
		color: var(--negative);
	}

	/* The underline drains over the five-second window; its last second warms up. */
	.timer {
		position: absolute;
		inset: 0;
		border-radius: 999px;
		background: var(--ink);
		transform-origin: left center;
		animation:
			drain 5s linear forwards,
			urgency 5s linear forwards;
	}

	.timer.stopped {
		animation-play-state: paused;
	}

	@keyframes drain {
		from {
			transform: scaleX(1);
		}
		to {
			transform: scaleX(0);
		}
	}

	@keyframes urgency {
		0%,
		80% {
			background: var(--ink);
			opacity: 0.9;
			box-shadow: none;
		}
		85% {
			background: var(--urgent);
			opacity: 1;
			box-shadow: 0 0 0.5em var(--urgent);
		}
		90% {
			opacity: 0.55;
		}
		95% {
			opacity: 1;
		}
		100% {
			background: var(--urgent);
			opacity: 0.6;
			box-shadow: 0 0 0.6em var(--urgent);
		}
	}
</style>
