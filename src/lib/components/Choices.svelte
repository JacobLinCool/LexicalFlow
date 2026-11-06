<script lang="ts">
	import type { Option, Phase } from '#lib/game.svelte.ts';
	import { DIRECTIONS, type Direction } from '#lib/types.ts';

	interface Props {
		options: Partial<Record<Direction, Option>>;
		/** The correct direction, for question feedback; absent for cards. */
		answer?: Direction;
		phase: Phase;
		picked: Direction | null;
		/** Length of a study pause (ms), counted down under the choices. */
		studyMs?: number;
		onpick: (direction: Direction, at: number) => void;
	}

	let { options, answer, phase, picked, studyMs = 0, onpick }: Props = $props();

	const ARROWS: Record<Direction, string> = { up: '↑', left: '←', down: '↓', right: '→' };
	const ready = $derived(phase === 'active' || phase === 'card');
	/** A question's choices stay hidden until its sentence has been read. */
	const concealed = $derived(answer !== undefined && (phase === 'entering' || phase === 'reading'));
	/** Up/down-only cards stack in one column instead of leaving the side cells empty. */
	const vertical = $derived(!options.left && !options.right);
	/** The verdict stays on, dimmed, while a missed or new word's meaning is studied. */
	const studying = $derived(phase === 'study');

	function tone(direction: Direction): string | undefined {
		if (phase === 'locked') return direction === picked ? 'selected' : undefined;
		if (phase !== 'feedback' && phase !== 'study') return undefined;
		if (direction === answer) return picked === direction ? 'correct' : 'reveal';
		if (direction === picked) return 'wrong';
		return 'muted';
	}
</script>

<div
	class="choices"
	class:ready
	class:vertical
	class:concealed
	class:studying
	aria-hidden={concealed}
	role="group"
	aria-label="Choices"
>
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
{#if studying}
	<p class="continue" style:--study="{studyMs}ms">
		<span class="keys">Any key to continue</span><span class="taps">Tap to continue</span>
	</p>
{/if}

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

	.choices {
		transition:
			opacity 160ms ease,
			transform 160ms ease;
	}

	.concealed {
		opacity: 0;
		transform: translateY(6px);
		pointer-events: none;
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
		max-width: 100%;
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

	/* Long words hyphenate instead of overflowing the button or the screen. */
	.label {
		min-width: 0;
		overflow-wrap: anywhere;
		hyphens: auto;
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

	.studying {
		opacity: 0.45;
	}

	/* Taps fall through to the stage, which ends the pause. */
	.studying .choice {
		pointer-events: none;
	}

	.continue {
		position: relative;
		width: max-content;
		margin: 0.85rem 0 0;
		padding-bottom: 0.4rem;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-muted);
		animation: continue-in 200ms ease-out;
	}

	/* The pause drains like the response timer, so its end is no surprise. */
	.continue::after {
		content: '';
		position: absolute;
		inset: auto 0 0;
		height: 2px;
		border-radius: 999px;
		background: var(--text-muted);
		transform-origin: left center;
		animation: drain var(--study) linear forwards;
	}

	.taps {
		display: none;
	}

	@media (hover: none) and (pointer: coarse) {
		.keys {
			display: none;
		}

		.taps {
			display: inline;
		}
	}

	@keyframes continue-in {
		from {
			opacity: 0;
		}
	}

	@keyframes drain {
		to {
			transform: scaleX(0);
		}
	}

	@media (max-width: 640px) {
		.choices {
			gap: 0.4rem;
		}

		/*
		 * Three columns cannot fit two long words beside an empty centre on a phone, so the
		 * cross becomes a diamond: up and down span the width, left and right share it.
		 */
		.choices:not(.vertical) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-template-areas:
				'up up'
				'left right'
				'down down';
			justify-content: stretch;
		}

		.up,
		.down {
			justify-self: center;
		}

		.choice {
			min-width: min(7.5em, 40vw);
			padding: 0.5em 0.8em;
		}

		.left,
		.right {
			min-width: 0;
		}

		.arrow {
			display: none;
		}

		.rich {
			min-width: 0;
			padding: 0.55em 0.8em;
		}

		.label small {
			font-size: 0.62em;
		}

		.continue {
			margin-inline: auto;
		}
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
