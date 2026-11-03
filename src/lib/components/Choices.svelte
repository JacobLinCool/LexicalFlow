<script lang="ts">
	import type { Option, Phase } from '#lib/game.svelte.ts';
	import { DIRECTIONS, type Direction } from '#lib/types.ts';

	interface Props {
		options: Partial<Record<Direction, Option>>;
		/** The correct direction, for question feedback; absent for cards. */
		answer?: Direction;
		phase: Phase;
		picked: Direction | null;
		onpick: (direction: Direction, at: number) => void;
	}

	let { options, answer, phase, picked, onpick }: Props = $props();

	const ARROWS: Record<Direction, string> = { up: '↑', left: '←', down: '↓', right: '→' };
	const ready = $derived(phase === 'active' || phase === 'card');
	/** Up/down-only cards stack in one column instead of leaving the side cells empty. */
	const vertical = $derived(!options.left && !options.right);

	function tone(direction: Direction): string | undefined {
		if (phase === 'locked') return direction === picked ? 'selected' : undefined;
		if (phase !== 'feedback') return undefined;
		if (direction === answer) return picked === direction ? 'correct' : 'reveal';
		if (direction === picked) return 'wrong';
		return 'muted';
	}
</script>

<div class="choices" class:ready class:vertical role="group" aria-label="Choices">
	{#each DIRECTIONS as direction (direction)}
		{@const option = options[direction]}
		{#if option}
			<button
				type="button"
				class={['choice', direction, tone(direction), option.detail && 'rich']}
				tabindex="-1"
				disabled={!ready}
				onpointerdown={(e) => {
					e.preventDefault();
					onpick(direction, e.timeStamp);
				}}
			>
				<span class="arrow" aria-hidden="true">{ARROWS[direction]}</span>
				<span class="label">
					{option.label}
					{#if option.detail}<small>{option.detail}</small>{/if}
				</span>
			</button>
		{/if}
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

	.vertical {
		grid-template-columns: auto;
		grid-template-areas: 'up' 'down';
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

	.rich {
		align-items: center;
		justify-content: flex-start;
		min-width: min(11em, 40vw);
		padding: 0.6em 1.1em;
		text-align: left;
	}

	.label small {
		display: block;
		margin-top: 0.15em;
		font-size: 0.68em;
		font-weight: 500;
		opacity: 0.55;
		letter-spacing: 0;
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
