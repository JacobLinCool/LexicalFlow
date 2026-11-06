<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import Backdrop from '#lib/components/Backdrop.svelte';
	import CardLine from '#lib/components/CardLine.svelte';
	import Seo from '#lib/seo/Seo.svelte';
	import Choices from '#lib/components/Choices.svelte';
	import Gloss from '#lib/components/Gloss.svelte';
	import Sentence from '#lib/components/Sentence.svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { asset, resolve } from '$app/paths';
	import {
		CUSTOM_PREFIX,
		builtinBank,
		level,
		listCustomBanks,
		resolvePlayable,
		type LevelId,
		type Playable
	} from '#lib/banks.ts';
	import { importUrl } from '#lib/importer.ts';
	import { loadSettings, saveSettings } from '#lib/progress.ts';
	import { Game, TIMING, glossMeanings } from '#lib/game.svelte.ts';
	import { MAX_HP } from '#lib/modes.ts';
	import { RESPONSE_WINDOW_MS } from '#lib/scoring.ts';
	import type { BankManifest, Direction, Question } from '#lib/types.ts';

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
	/** Pages one key away on the mode menu. */
	const MENU_KEYS: Record<string, '/banks' | '/profile' | '/plan'> = {
		KeyB: '/banks',
		KeyP: '/profile',
		KeyL: '/plan'
	};
	/** Gap between sentences, and between the current sentence and its choices (px). */
	const LINE_GAP = 28;
	const CHOICE_GAP = 24;

	const game = new Game({ openPlan: () => goto(resolve('/plan')), onPlaced: () => void followPlacement() });

	let viewport = $state(800);
	let heights = $state<Record<number, number>>({});
	let choicesHeight = $state(170);
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

	/** Idle time on the mode menu before the demo starts by itself. */
	const DEMO_AFTER_MS = 30_000;
	let activity = $state(0);
	const poke = () => activity++;

	$effect(() => {
		void activity;
		if (game.phase !== 'card' || game.mode) return;
		const timer = setTimeout(() => {
			if (document.visibilityState === 'visible') game.startDemo();
		}, DEMO_AFTER_MS);
		return () => clearTimeout(timer);
	});

	function onkeydown(e: KeyboardEvent) {
		poke();
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		// During the demo any key hands control back, and does nothing else.
		if (game.demo) {
			e.preventDefault();
			if (!e.repeat) game.stopDemo();
			return;
		}
		// Any key ends a study pause and does nothing else; Esc still leaves.
		if (game.phase === 'study' && e.code !== 'Escape' && e.code !== 'KeyM') {
			e.preventDefault();
			if (!e.repeat) game.skipStudy();
			return;
		}
		if (e.code === 'Space') {
			e.preventDefault();
			if (e.repeat) return;
			// The demo starts from the menu only (the game refuses it mid-run); parked, Space continues.
			if (game.phase === 'idle') game.press('up', e.timeStamp);
			else game.startDemo();
			return;
		}
		if (e.code === 'KeyM') {
			if (!e.repeat) game.toggleSound();
			return;
		}
		const page = MENU_KEYS[e.code];
		if (page && game.phase === 'card' && !game.mode && !e.repeat) {
			goto(resolve(page));
			return;
		}
		if (e.code === 'Escape') {
			if (!e.repeat) game.quit();
			return;
		}
		const direction = KEYS[e.code] ?? KEYS[e.key];
		if (!direction) return;
		e.preventDefault();
		// A held key auto-repeats; only a fresh press may answer.
		if (e.repeat) return;
		game.press(direction, e.timeStamp);
	}

	let shareError = $state('');

	/**
	 * Load the selected bank; a `?bank=<url>` link imports and selects that bank first, and
	 * `?start=learn` or `?start=placement` (from the plan page) starts that mode once loaded.
	 */
	async function start() {
		const settings = loadSettings();
		const query = new URL(location.href).searchParams;
		const shared = query.get('bank');
		const begin = query.get('start');
		if (shared) {
			try {
				const { bank } = await importUrl(shared, await listCustomBanks());
				settings.bank = CUSTOM_PREFIX + bank.id;
				saveSettings(settings);
			} catch (error) {
				shareError = `The shared bank could not be loaded: ${(error as Error).message}`;
			}
		}
		if (shared || begin) history.replaceState(history.state, '', resolve('/'));
		const [playable, builtin] = await Promise.all([resolvePlayable(settings.bank, settings.level), builtinBank()]);
		game.load(playable.questions, { id: settings.bank, label: bankLabel(playable, settings.level) }, builtin);
		if (begin === 'learn' || begin === 'placement') game.begin(begin);
	}

	/** "Travel · Medium": the level actually applied, which is not the chosen one when 'My level' has no test to go on. */
	function bankLabel(playable: Playable, chosen: LevelId): string {
		return playable.levelled ? `${playable.name} · ${level(playable.level ?? chosen).label}` : playable.name;
	}

	/** A level test moves the bands 'My level' plays: resolve the bank again so the next run uses them. */
	async function followPlacement() {
		const settings = loadSettings();
		if (settings.level !== 'mine') return;
		const playable = await resolvePlayable(settings.bank, settings.level).catch(() => null);
		if (playable) game.useQuestions(playable.questions, bankLabel(playable, settings.level));
	}

	/** A load still going after this long shows how far it has got; a quicker one would only flash it. */
	const PROGRESS_AFTER_MS = 800;
	/** Band files of the bank received so far, for the loading line; null until worth showing. */
	let received = $state<{ done: number; total: number } | null>(null);

	/**
	 * Count the bank's band files as they arrive, from resource timing, so the loader needs no
	 * hook for it. The total is the manifest's band count: the loader has fetched the manifest by
	 * then, so it is read back from the HTTP cache. Returns a function that stops counting.
	 */
	function countBands(): () => void {
		if (typeof PerformanceObserver === 'undefined') return () => {};
		const done = new Set<string>();
		let total = 0;
		const show = () => {
			if (total) received = { done: Math.min(done.size, total), total };
		};
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) if (entry.name.includes('/data/bands/')) done.add(entry.name);
			show();
		});
		const timer = setTimeout(() => {
			observer.observe({ type: 'resource', buffered: true });
			fetch(asset('data/manifest.json'), { cache: 'force-cache' })
				.then((res) => res.json() as Promise<BankManifest>)
				.then((manifest) => {
					total = manifest.bands.length;
					show();
				})
				.catch(() => {});
		}, PROGRESS_AFTER_MS);
		return () => {
			clearTimeout(timer);
			observer.disconnect();
		};
	}

	/** Hidden, the clock stops and unsaved answers are written: a hidden page may never be shown again. */
	function onvisibilitychange() {
		if (document.visibilityState === 'hidden') {
			game.pause();
			game.flush();
		} else {
			game.wake();
		}
	}

	/** Another tab saved; the game reads its stores again before writing over them. */
	function onstorage(e: StorageEvent) {
		if (e.storageArea === localStorage) game.storageChanged(e.key);
	}

	// The next page may read what this one has not written yet.
	beforeNavigate(() => game.flush());

	function percent(x: number | null) {
		return x === null ? '—' : `${Math.round(x * 100)}%`;
	}

	function seconds(ms: number | null) {
		return ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
	}

	onMount(() => {
		const stopCounting = countBands();
		start()
			.then(
				() => requestAnimationFrame(() => requestAnimationFrame(() => (settled = true))),
				(error) => {
					console.error(error);
					game.fail();
				}
			)
			.finally(stopCounting);
		const save = () => game.flush();
		addEventListener('pagehide', save);
		return () => {
			stopCounting();
			removeEventListener('pagehide', save);
			game.destroy();
		};
	});

	function choiceOptions(question: Question | undefined) {
		if (!question) return {};
		const c = question.choices;
		return { up: { label: c.up }, left: { label: c.left }, down: { label: c.down }, right: { label: c.right } };
	}

	const line = $derived(game.line);
	const outcome = $derived(line?.result?.outcome);
</script>

<Seo path="/" app />

<svelte:window
	{onkeydown}
	onpointermove={poke}
	onpointerdown={poke}
	onwheel={poke}
	onblur={() => game.pause()}
	onfocus={() => game.wake()}
	{onstorage}
	bind:innerHeight={viewport}
/>
<svelte:document {onvisibilitychange} />

<Backdrop category={line?.question?.category} />

<main
	class="stage"
	style:--scroll-ms="{TIMING.scroll}ms"
	style:--window="{RESPONSE_WINDOW_MS}ms"
	onpointerdown={(e) => {
		if (game.demo) return game.stopDemo();
		if (game.phase === 'study') return game.skipStudy();
		if (game.phase === 'idle') game.press('up', e.timeStamp);
	}}
>
	{#if game.phase === 'loading'}
		<p class="status" style:top="{anchor}px">
			{received ? `Loading words… ${received.done}/${received.total}` : 'Loading…'}
		</p>
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
						{#if item.question}
							<Sentence
								question={item.question}
								result={item.result}
								active={distance === 0}
								phase={game.phase}
							/>
							{#if item.gloss}<Gloss info={item.gloss} language={game.glossLanguage} strong={item.study} />{/if}
						{:else if item.card}
							<CardLine card={item.card} />
						{/if}
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
									<span class="keys">Press <kbd>W A S D</kbd> or <kbd>← ↑ → ↓</kbd> to continue.</span>
									<span class="taps">Tap to continue.</span>
								</p>
							{:else}
								<Choices
									options={line.card?.options ?? choiceOptions(line.question)}
									answer={line.question?.answer}
									phase={game.phase}
									picked={game.picked}
									studyMs={game.studyMs}
									onpick={(direction, at) => !game.demo && game.press(direction, at)}
								/>
							{/if}
						</div>
					{/key}
				</div>
			{/if}
		</div>
	{/if}

	{#if shareError}<p class="share-error" role="alert">{shareError}</p>{/if}

	<footer class="hud">
		{#key game.level.up?.key}
			{#if game.level.up}
				<p class="level-up" role="status">Level {game.level.up.level}</p>
			{/if}
		{/key}
		<span class={['stats', game.mode && 'running', game.mode?.hp && 'hp-run']} aria-label="Progress">
			{#if !game.demo && game.phase !== 'loading'}
				{@const lv = game.level}
				<span
					class="level"
					title="Level {lv.level} · {lv.into.toLocaleString('en-US')} / {lv.span.toLocaleString('en-US')} XP to level {lv.level + 1}"
				>
					<span class="level-label">Lv {lv.level}</span>
					<span class="xp-track" aria-hidden="true"
						><span class="xp-fill" style:transform="scaleX({lv.into / lv.span})"></span></span
					>
					{#key lv.gain?.key}
						{#if lv.gain}<span class="xp-gain" aria-hidden="true">+{lv.gain.value} XP</span>{/if}
					{/key}
				</span>
			{/if}
			{#if game.mode}
				{@const run = game.run}
				<span class="mode">{game.mode.label}</span>
				{#if game.mode.id === 'learn'}
					{#if game.learnStatus}
						{@const s = game.learnStatus}
						<span title="New words today">New {s.newToday}{s.quota ? `/${s.quota}` : ''}</span>
						<span title="Reviews due">Due {s.due}</span>
						{#if s.estimate !== null}
							<span class="wide" title="Estimated vocabulary">≈ {s.estimate.toLocaleString('en-US')} words</span>
						{/if}
					{/if}
				{:else if game.mode.id === 'placement'}
					{#if game.testStatus}
						<span title="Questions answered">{game.testStatus.asked} / ~{game.testStatus.expected}</span>
					{/if}
				{:else}
					{#if game.mode.hp}
						<span class="hp" title="HP" class:low={run.hp <= 30}>
							<span class="hp-track"><span class="hp-fill" style:transform="scaleX({run.hp / MAX_HP})"></span></span>
							<span class="hp-value">{run.hp}</span>
							{#key run.delta?.key}
								{#if run.delta}
									<span class={['hp-delta', run.delta.value < 0 ? 'down' : 'up']}
										>{run.delta.value > 0 ? '+' : ''}{run.delta.value}</span
									>
								{/if}
							{/key}
						</span>
					{/if}
					<span title="Questions">{run.count}{game.mode.limit ? ` / ${game.mode.limit}` : ''}</span>
					<span title="Run score">{run.score.toLocaleString('en-US')} pts</span>
				{/if}
				{#if game.demo}
					<span class="demo-hint">Press any key to play</span>
				{:else if line?.question}
					<!-- Touch has no Esc: during a run this is the only way back to the menu. -->
					<button
						type="button"
						class="quit"
						tabindex="-1"
						title="Back to the menu (Esc)"
						onpointerdown={(e) => {
							e.stopPropagation();
							game.quit();
						}}>Quit <kbd>Esc</kbd></button
					>
				{/if}
			{:else if game.phase !== 'loading'}
				<nav class="links">
					<a href={resolve('/plan')}>Plan <kbd>L</kbd></a>
					<a href={resolve('/banks')}>Word bank <kbd>B</kbd></a>
					<a href={resolve('/profile')}>Profile <kbd>P</kbd></a>
					<button type="button" onpointerdown={(e) => (e.stopPropagation(), game.startDemo())}>Demo <kbd>Space</kbd></button>
				</nav>
			{/if}
			{#if !game.mode && game.summary.attempted}
				<span class="summary" title="All-time questions">{game.summary.attempted.toLocaleString('en-US')} answered</span>
				<span class="summary" title="Accuracy">{percent(game.summary.accuracy)}</span>
				<span class="summary" title="Average response time">{seconds(game.summary.averageMs)}</span>
				<span class="summary" title="All-time score">{game.summary.totalScore.toLocaleString('en-US')} pts</span>
			{/if}
		</span>
		{#if !game.mode}
			<a
				class="credit"
				href="https://tatoeba.org"
				target="_blank"
				rel="noreferrer"
				title="Sentences from Tatoeba (CC BY 2.0 FR) and WordNet"
				onpointerdown={(e) => e.stopPropagation()}
			>
				Tatoeba (CC BY 2.0 FR)<span class="wide">{' '}and WordNet</span>
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
		{#if outcome && line?.gloss}{@const m = glossMeanings(line.gloss, game.glossLanguage)}{line.gloss.word}: {[m.zh, m.en]
				.filter(Boolean)
				.join('; ')}.{/if}
		{#if game.phase === 'reading' && line?.question}{line.question.sentence.replace('___', 'blank')}{/if}
		{#if game.phase === 'card' && line?.card}{line.card.title} {line.card.subtitle}{/if}
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
		font-variant-numeric: tabular-nums;
	}

	.hint {
		margin: 0;
		font-size: var(--choice-size);
		font-weight: 600;
		opacity: 0.75;
		line-height: 1.5;
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

	.mode {
		color: var(--ink);
		opacity: 0.75;
		font-weight: 600;
	}

	/* A control like the menu links, taller than its text so a thumb finds it; the negative margin keeps the HUD's height. */
	.quit {
		margin: -0.6rem 0;
		padding: 0.6rem 0.25rem;
		font: inherit;
		font-weight: 600;
		color: var(--ink);
		opacity: 0.6;
		background: none;
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 150ms ease;
	}

	.quit:hover {
		opacity: 1;
	}

	.quit kbd {
		font-size: 0.85em;
		margin-left: 0.2em;
		opacity: 0.7;
	}

	.level {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	.level-label {
		color: var(--ink);
		opacity: 0.75;
		font-weight: 600;
		white-space: nowrap;
	}

	.xp-track {
		width: 3.5rem;
		height: 0.25rem;
		border-radius: 999px;
		background: var(--surface-strong);
		overflow: hidden;
	}

	.xp-fill {
		display: block;
		height: 100%;
		background: var(--ink);
		opacity: 0.8;
		transform-origin: left center;
		transition: transform 400ms cubic-bezier(0.22, 0.8, 0.24, 1);
	}

	.xp-gain {
		position: absolute;
		left: 0;
		bottom: 100%;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
		animation: delta 1000ms ease-out forwards;
	}

	/* A new level rises over the HUD and fades; the stream keeps flowing under it. */
	.level-up {
		position: absolute;
		left: max(1.5rem, calc((100vw - 58rem) / 2));
		bottom: 100%;
		margin: 0;
		padding: 0.45rem 0.9rem;
		border-radius: 999px;
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--bg);
		background: var(--ink);
		box-shadow: 0 0 1.5rem rgb(255 255 255 / 0.35);
		pointer-events: none;
		animation: level-up 2600ms cubic-bezier(0.22, 0.8, 0.24, 1) forwards;
	}

	@keyframes level-up {
		0% {
			opacity: 0;
			transform: translateY(0.6rem) scale(0.9);
		}
		12%,
		75% {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
		100% {
			opacity: 0;
			transform: translateY(-0.4rem) scale(1);
		}
	}

	.hp {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.hp-track {
		width: 7rem;
		height: 0.3rem;
		border-radius: 999px;
		background: var(--surface-strong);
		overflow: hidden;
	}

	.hp-fill {
		display: block;
		height: 100%;
		background: var(--positive);
		transform-origin: left center;
		transition:
			transform 300ms cubic-bezier(0.22, 0.8, 0.24, 1),
			background-color 300ms ease;
	}

	.hp.low .hp-fill {
		background: var(--negative);
	}

	.hp-value {
		min-width: 2ch;
		color: var(--ink);
		opacity: 0.75;
	}

	.hp-delta {
		position: absolute;
		right: 0;
		bottom: 100%;
		font-weight: 600;
		animation: delta 900ms ease-out forwards;
	}

	.hp-delta.up {
		color: var(--positive);
	}

	.hp-delta.down {
		color: var(--negative);
	}

	@keyframes delta {
		from {
			opacity: 1;
			transform: translateY(0);
		}
		to {
			opacity: 0;
			transform: translateY(-0.6rem);
		}
	}

	.links {
		display: flex;
		gap: 1rem;
	}

	.links a,
	.links button {
		padding: 0;
		font: inherit;
		background: none;
		cursor: pointer;
		color: var(--ink);
		opacity: 0.7;
		text-decoration: none;
		font-weight: 600;
		transition: opacity 150ms ease;
	}

	.demo-hint {
		color: var(--ink);
		opacity: 0.75;
		animation: breathe 2.4s ease-in-out infinite;
	}

	@keyframes breathe {
		50% {
			opacity: 0.35;
		}
	}

	.links button:hover,
	.links a:hover {
		opacity: 1;
	}

	.links kbd {
		font-size: 0.85em;
		opacity: 0.7;
		margin-left: 0.2em;
	}

	.links a,
	.links button {
		white-space: nowrap;
	}

	.summary,
	.credit {
		white-space: nowrap;
	}

	/* All-time figures are on the profile; below desktop width the menu links need the room. */
	@media (max-width: 1023px) {
		.summary {
			display: none;
		}
	}

	@media (max-width: 640px) {
		/* The credit takes a row of its own under the menu links and the sound toggle. */
		.hud {
			flex-wrap: wrap;
			gap: 0.35rem 0.75rem;
			font-size: 0.75rem;
		}

		.credit {
			order: 1;
			flex-basis: 100%;
		}

		.links kbd,
		.quit kbd,
		.wide {
			display: none;
		}

		/* A run's figures and Quit share one row with the sound toggle. */
		.stats {
			gap: 0.75rem;
			white-space: nowrap;
		}

		.hp-track {
			width: 4rem;
		}

		/* The level stays, its bar gives way to the links and the run's figures (the profile shows it);
		   in Survival the HP bar names the mode, so its label does too. */
		.xp-track,
		.hp-run .mode {
			display: none;
		}

		.level-up {
			left: 1.5rem;
		}
	}

	.share-error {
		position: absolute;
		top: 1rem;
		left: max(1.5rem, calc((100vw - 58rem) / 2));
		right: 1.5rem;
		margin: 0;
		font-size: 0.85rem;
		color: var(--negative);
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
