<script lang="ts">
	import type { Phase } from '#lib/game.svelte.ts';
	import { DIRECTIONS, type Direction, type Question } from '#lib/types.ts';

	interface Props {
		question: Question;
		phase: Phase;
		picked: Direction | null;
		onpick: (direction: Direction, at: number) => void;
	}

	let { question, phase, picked, onpick }: Props = $props();

	const ARROWS: Record<Direction, string> = { up: '↑', left: '←', down: '↓', right: '→' };

	function tone(direction: Direction): string | undefined {
		if (phase === 'locked') return direction === picked ? 'selected' : undefined;
		if (phase !== 'feedback') return undefined;
		if (direction === question.answer) return picked === direction ? 'correct' : 'reveal';
		if (direction === picked) return 'wrong';
		return 'muted';
	}
</script>

<div class="choices" class:ready={phase === 'active'} role="group" aria-label="Choices">
	{#each DIRECTIONS as direction (direction)}
		<button
			type="button"
			class={['choice', direction, tone(direction)]}
			tabindex="-1"
			disabled={phase !== 'active'}
			onpointerdown={(e) => {
				e.preventDefault();
				onpick(direction, e.timeStamp);
			}}
		>
			<span class="arrow" aria-hidden="true">{ARROWS[direction]}</span>
			<span>{question.choices[direction]}</span>
		</button>
	{/each}
</div>

<style>
	.choices {
		display: grid;
		grid-template-columns: repeat(3, auto);
		grid-template-areas:
			'. up .'
			'left . right'
			'. down .';
		justify-content: start;
		gap: 0.5rem 0.75rem;
		font-size: var(--choice-size);
	}

	.up {
		grid-area: up;
	}
	.left {
		grid-area: left;
	}
	.down {
		grid-area: down;
	}
	.right {
		grid-area: right;
	}

	.choice {
		position: relative;
		display: inline-flex;
		align-items: baseline;
		justify-content: center;
		gap: 0.5em;
		min-width: min(7.5em, 27vw);
		padding: 0.5em 1em;
		border-radius: 1em;
		font: inherit;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--ink);
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
		cursor: pointer;
		transition:
			background-color 80ms ease,
			box-shadow 80ms ease,
			opacity 150ms ease,
			transform 80ms ease;
	}

	.choice:disabled {
		cursor: default;
	}

	.ready .choice:hover {
		background: var(--surface-hover);
	}

	.arrow {
		font-size: 0.75em;
		opacity: 0.45;
		font-weight: 500;
	}

	.selected {
		background: var(--surface-strong);
		box-shadow: inset 0 0 0 1px var(--ink);
		transform: scale(0.97);
	}

	.correct {
		animation: flash-positive 120ms ease-out;
		background: var(--positive-surface);
		box-shadow: inset 0 0 0 1px var(--positive);
	}

	.wrong {
		animation: flash-negative 150ms ease-out;
		background: var(--negative-surface);
		box-shadow: inset 0 0 0 1px var(--negative);
		opacity: 0.85;
	}

	.reveal {
		background: var(--positive-surface);
		box-shadow: inset 0 0 0 1px var(--positive);
	}

	.muted {
		opacity: 0.35;
	}

	@keyframes flash-positive {
		from {
			background: var(--positive);
			transform: scale(1.03);
		}
	}

	@keyframes flash-negative {
		0% {
			background: var(--negative);
			transform: translateX(0);
		}
		35% {
			transform: translateX(-3px);
		}
		70% {
			transform: translateX(2px);
		}
	}
</style>
