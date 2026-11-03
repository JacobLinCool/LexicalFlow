<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import Backdrop from '#lib/components/Backdrop.svelte';
	import Choices from '#lib/components/Choices.svelte';
	import Sentence from '#lib/components/Sentence.svelte';
	import { loadQuestions } from '#lib/data.ts';
	import { Game, TIMING } from '#lib/game.svelte.ts';
	import type { Direction } from '#lib/types.ts';

	const KEYS: Record<string, Direction> = {
		KeyW: 'up',
		ArrowUp: 'up',
		KeyA: 'left',
		ArrowLeft: 'left',
		KeyS: 'down',
		ArrowDown: 'down',
		KeyD: 'right',
		ArrowRight: 'right'
	};
	/** Gap between sentences, and between the current sentence and its choices (px). */
	const LINE_GAP = 28;
	const CHOICE_GAP = 24;

	const game = new Game();

	let viewport = $state(800);
	let heights = $state<Record<number, number>>({});
	let choicesHeight = $state(170);
	let started = $state(false);
	/** Lines snap into place on first layout and only animate once measured. */
	let settled = $state(false);

	const anchor = $derived(Math.round(viewport * 0.3));
	const fallbackHeight = 64;

	/** Vertical offset of each line relative to the current one, leaving room for the choices. */
	const offsets = $derived.by(() => {
		const { lines, current } = game;
		const h = (i: number) => heights[lines[i].key] ?? fallbackHeight;
		const out = new Array<number>(lines.length);
		out[current] = 0;
		for (let i = current + 1; i < lines.length; i++) {
			out[i] = out[i - 1] + h(i - 1) + LINE_GAP + (i - 1 === current ? choicesHeight + CHOICE_GAP : 0);
		}
		for (let i = current - 1; i >= 0; i--) out[i] = out[i + 1] - h(i) - LINE_GAP;
		return out;
	});

	function look(distance: number): string {
		let opacity: number;
		let blur: number;
		if (distance === 0) {
			opacity = 1;
			blur = 0;
		} else if (distance < 0) {
			opacity = Math.max(0, 0.36 - 0.07 * (-distance - 1));
			blur = Math.min(3, 0.6 * -distance);
		} else {
			opacity = Math.max(0, 0.4 - 0.065 * (distance - 1));
			blur = Math.min(6, 1.2 + 1.1 * (distance - 1));
		}
		return `opacity:${opacity};filter:${blur ? `blur(${blur.toFixed(1)}px)` : 'none'};`;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.code === 'KeyM') {
			if (!e.repeat) game.toggleSound();
			return;
		}
		const direction = KEYS[e.code] ?? KEYS[e.key];
		if (!direction) return;
		e.preventDefault();
		// A held key auto-repeats; only a fresh press may answer.
		if (e.repeat) return;
		if (game.phase === 'idle') return begin();
		game.answer(direction, e.timeStamp);
	}

	function begin() {
		started = true;
		game.begin();
	}

	function percent(x: number | null) {
		return x === null ? '—' : `${Math.round(x * 100)}%`;
	}

	function seconds(ms: number | null) {
		return ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
	}

	onMount(() => {
		loadQuestions().then(
			(questions) => {
				game.load(questions);
				requestAnimationFrame(() => requestAnimationFrame(() => (settled = true)));
			},
			(error) => {
				console.error(error);
				game.fail();
			}
		);
		const save = () => game.flush();
		addEventListener('pagehide', save);
		return () => {
			removeEventListener('pagehide', save);
			game.destroy();
		};
	});

	const line = $derived(game.line);
	const outcome = $derived(line?.result?.outcome);
</script>

<svelte:head>
	<title>Lexical Flow</title>
	<meta name="description" content="A continuous stream of sentences. Pick the missing word, instinctively." />
</svelte:head>

<svelte:window {onkeydown} bind:innerHeight={viewport} />

<Backdrop category={line?.question.category} />

<main
	class="stage"
	style:--scroll-ms="{TIMING.scroll}ms"
	onpointerdown={() => game.phase === 'idle' && begin()}
>
	{#if game.phase === 'loading'}
		<p class="status" style:top="{anchor}px">Loading…</p>
	{:else if game.phase === 'error'}
		<p class="status" style:top="{anchor}px">The question bank could not be loaded. Reload to try again.</p>
	{:else}
		<div class="stream" class:settled>
			{#each game.lines as item, i (item.key)}
				{@const distance = i - game.current}
				{#if distance >= -8 && distance <= 6}
					<div
						class="line"
						bind:offsetHeight={heights[item.key]}
						style:transform="translate3d(0, {anchor + offsets[i]}px, 0)"
						style={look(distance)}
						aria-hidden={distance !== 0}
					>
						<Sentence
							question={item.question}
							result={item.result}
							active={distance === 0}
							phase={game.phase}
						/>
					</div>
				{/if}
			{/each}

			{#if line}
				<div
					class="panel"
					style:transform="translate3d(0, {anchor + (heights[line.key] ?? fallbackHeight) + CHOICE_GAP}px, 0)"
				>
					{#key line.key}
						<div bind:offsetHeight={choicesHeight} in:fly={{ y: 10, duration: TIMING.scroll - 40, delay: 40 }}>
							{#if game.phase === 'idle'}
								<p class="hint">
									Press <kbd>W A S D</kbd> or <kbd>← ↑ → ↓</kbd> to {started ? 'continue' : 'begin'}.
								</p>
							{:else}
								<Choices
									question={line.question}
									phase={game.phase}
									picked={game.picked}
									onpick={(direction, at) => game.answer(direction, at)}
								/>
							{/if}
						</div>
					{/key}
				</div>
			{/if}
		</div>
	{/if}

	<footer class="hud">
		<span class="stats" aria-label="Progress">
			{#if game.summary.attempted}
				<span title="Questions this session / all time">{game.session.count} · {game.summary.attempted}</span>
				<span title="Accuracy">{percent(game.summary.accuracy)}</span>
				<span title="Average response time">{seconds(game.summary.averageMs)}</span>
				<span title="Total score">{game.summary.totalScore.toLocaleString('en-US')} pts</span>
			{/if}
		</span>
		{#if game.phase === 'idle' || game.phase === 'loading'}
			<a class="credit" href="https://tatoeba.org" target="_blank" rel="noreferrer" onpointerdown={(e) => e.stopPropagation()}>
				Sentences from Tatoeba (CC BY 2.0 FR) and WordNet
			</a>
		{/if}
		<button
			type="button"
			class="sound"
			tabindex="-1"
			aria-pressed={game.sound}
			aria-label={game.sound ? 'Mute sound (M)' : 'Enable sound (M)'}
			title={game.sound ? 'Sound on (M)' : 'Sound off (M)'}
			onpointerdown={(e) => {
				e.stopPropagation();
				game.toggleSound();
			}}
		>
			<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
				<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
				{#if game.sound}
					<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" />
				{:else}
					<path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
				{/if}
			</svg>
		</button>
	</footer>

	<p class="sr-only" aria-live="polite">
		{#if outcome === 'correct'}Correct.{:else if outcome === 'incorrect'}Incorrect.{:else if outcome === 'timeout'}Time is up.{/if}
		{#if game.phase === 'active' && line}{line.question.sentence.replace('___', 'blank')}{/if}
	</p>
</main>

<style>
	.stage {
		position: fixed;
		inset: 0;
		overflow: hidden;
	}

	.stream {
		position: absolute;
		inset: 0 auto 0 max(1.5rem, calc((100vw - 58rem) / 2));
		width: min(58rem, calc(100vw - 3rem));
		/* Fade the stream out toward both edges of the screen, like a lyrics view. */
		mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 82%, transparent 100%);
	}

	.line,
	.panel {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		transition:
			transform var(--scroll-ms) cubic-bezier(0.22, 0.8, 0.24, 1),
			opacity var(--scroll-ms) ease,
			filter var(--scroll-ms) ease;
		will-change: transform, opacity, filter;
	}

	.stream:not(.settled) .line,
	.stream:not(.settled) .panel {
		transition: none;
	}

	.status {
		position: absolute;
		left: max(1.5rem, calc((100vw - 58rem) / 2));
		margin: 0;
		font-size: var(--line-size);
		font-weight: 700;
		letter-spacing: -0.022em;
		opacity: 0.5;
	}

	.hint {
		margin: 0;
		font-size: var(--choice-size);
		font-weight: 600;
		opacity: 0.75;
		line-height: 1.5;
	}

	kbd {
		font: inherit;
		padding: 0.05em 0.4em;
		border-radius: 0.4em;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.hud {
		position: absolute;
		inset: auto 0 0 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem max(1.5rem, calc((100vw - 58rem) / 2));
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
		color: rgb(255 255 255 / 0.45);
	}

	.stats {
		display: flex;
		gap: 1rem;
	}

	.credit {
		color: inherit;
		opacity: 0.6;
		text-decoration: none;
	}

	.credit:hover {
		opacity: 1;
	}

	.sound {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		color: inherit;
		background: transparent;
		cursor: pointer;
		transition: color 150ms ease, background-color 150ms ease;
	}

	.sound:hover {
		color: var(--ink);
		background: var(--surface);
	}

	@media (prefers-reduced-motion: reduce) {
		.line,
		.panel {
			transition-duration: 1ms;
		}
	}
</style>
