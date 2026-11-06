<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { builtinBank } from '#lib/banks.ts';
	import Bars from '#lib/charts/Bars.svelte';
	import Coverage from '#lib/charts/Coverage.svelte';
	import Page from '#lib/components/Page.svelte';
	import {
		DURATIONS,
		ESTIMATE_MIN_EVIDENCE,
		MAX_DAILY_NEW,
		TARGETS,
		addDays,
		bandCoverage,
		defaultPlan,
		estimateRange,
		estimateReady,
		forecast,
		frontierBand,
		loadLearner,
		planSummary,
		roundEstimate,
		saveLearner,
		setPlan,
		studyMinutes,
		todayTally,
		vocabularyBreakdown,
		type LearnerState,
		type Plan
	} from '#lib/learner.ts';
	import { dayKey, loadSettings, saveSettings, type GlossLanguage, type Settings } from '#lib/progress.ts';
	import Seo from '#lib/seo/Seo.svelte';
	import type { Lexicon } from '#lib/types.ts';

	/**
	 * A pace is intensive above this many genuinely new words a day or this many minutes a day;
	 * one that needs the course's MAX_DAILY_NEW introductions a day is not realistic at all.
	 */
	const INTENSIVE_GAIN = 60;
	const INTENSIVE_MINUTES = 60;
	/** Genuinely new words a day most learners can keep up (research.md, realistic pace). */
	const SUSTAINABLE = { low: 20, high: 40 };
	const FORECAST_DAYS = 14;
	/** Rough stages on the frequency scale; our bands count content-word lemmas, so these are approximate. */
	const STAGES = [
		{ from: 3000, label: 'Everyday conversation' },
		{ from: 5000, label: 'General reading with some help' },
		{ from: 9000, to: 10000, label: 'Novels and news' }
	];
	const GLOSSES: { id: GlossLanguage; label: string }[] = [
		{ id: 'en', label: 'English' },
		{ id: 'zh', label: '中文' },
		{ id: 'both', label: 'Both' }
	];

	let learner = $state.raw<LearnerState | null>(null);
	let lexicon = $state.raw<Lexicon | null>(null);
	let failed = $state(false);
	let settings = $state<Settings | null>(null);
	let now = $state(Date.now());
	/** Goal choices not saved yet; null follows the saved (or default) plan. */
	let pickTarget = $state<number | null>(null);
	let pickDays = $state<number | null>(null);

	onMount(() => {
		learner = loadLearner();
		settings = loadSettings();
		builtinBank().then(
			(bank) => (lexicon = bank.lexicon),
			() => (failed = true)
		);
		// Coming back to the tab after a session: pick up its answers.
		const refresh = () => {
			if (document.visibilityState !== 'visible') return;
			learner = loadLearner();
			now = Date.now();
		};
		document.addEventListener('visibilitychange', refresh);
		return () => document.removeEventListener('visibilitychange', refresh);
	});

	const n = (v: number) => v.toLocaleString('en-US');
	const startHref = (mode: 'learn' | 'placement') => `${resolve('/')}?start=${mode}`;

	/** "Dec 6" for a YYYY-MM-DD date, with the year when it is not this year's. */
	function day(key: string): string {
		const [y, m, d] = key.split('-').map(Number);
		const date = new Date(y, m - 1, d);
		const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year });
	}

	const started = $derived(!!learner && (learner.placement !== null || Object.keys(learner.cards).length > 0));
	/**
	 * Before the level test or enough first answers the estimate is only the prior, so it stays
	 * hidden, and so does the band new words come from, which rests on the same prior.
	 */
	const ready = $derived(!!learner && estimateReady(learner));
	/** First answers still needed before an estimate shows, for a learner who skipped the level test. */
	const toGo = $derived.by(() => {
		if (!learner) return ESTIMATE_MIN_EVIDENCE;
		let seen = 0;
		for (const [count] of Object.values(learner.firsts)) seen += count;
		return Math.max(1, ESTIMATE_MIN_EVIDENCE - seen);
	});

	/** The likely range to the nearest hundred (ten for small vocabularies), widened to hold the shown estimate. */
	function likely(range: { low: number; high: number }, estimate: number): string {
		const unit = range.high - range.low >= 500 ? 100 : 10;
		const shown = roundEstimate(estimate);
		const low = Math.min(shown, Math.floor(range.low / unit) * unit);
		const high = Math.max(shown, Math.ceil(range.high / unit) * unit);
		return `${n(low)}–${n(high)}`;
	}

	const view = $derived.by(() => {
		if (!learner || !lexicon) return null;
		const coverage = bandCoverage(learner, lexicon, now);
		const frontier = frontierBand(learner, lexicon);
		const ahead = forecast(learner, FORECAST_DAYS, now);
		const summary = planSummary(learner, lexicon, now);
		return {
			// Without an estimate the "estimated known" layer is only the prior: show it as not known yet.
			coverage: ready ? coverage : coverage.map((b) => ({ ...b, estimated: 0, unknown: b.unknown + b.estimated })),
			mastered: coverage.reduce((s, b) => s + b.mastered, 0),
			learning: coverage.reduce((s, b) => s + b.learning, 0),
			summary,
			likely: likely(estimateRange(learner, lexicon, now), summary.estimate),
			breakdown: vocabularyBreakdown(learner, now),
			frontier,
			range: `${n((frontier - 1) * lexicon.bandSize + 1)}–\u2060${n(Math.min(frontier * lexicon.bandSize, lexicon.byRank.length))}`,
			ahead,
			today: todayTally(learner, now),
			bandSize: lexicon.bandSize,
			words: lexicon.byRank.length
		};
	});

	const today = $derived(dayKey(new Date(now)));

	/** The goal as currently picked: the saved plan (or the default one) with unsaved choices applied. */
	const goal = $derived.by(() => {
		if (!learner || !lexicon || !view) return null;
		const saved = learner.plan;
		const base = saved ?? defaultPlan(view.summary.estimate, today);
		const target = pickTarget ?? base.target;
		const days = pickDays ?? base.days;
		let unchanged = !!saved && saved.target === target && saved.days === days;
		// A saved plan past its deadline is shown as it would run if saved again from today.
		const current = unchanged ? planSummary(learner, lexicon, now) : null;
		const ended = current?.expired ? current.deadline : null;
		if (ended) unchanged = false;
		const plan: Plan = { target, days, start: unchanged && saved ? saved.start : today };
		const summary = planSummary({ ...learner, plan }, lexicon, now);
		const targets = [...new Set([...TARGETS, base.target])].sort((a, b) => a - b);
		const late = summary.finish !== null && summary.deadline !== null && summary.finish > summary.deadline;
		const pace =
			summary.dailyNew >= MAX_DAILY_NEW
				? 'unrealistic'
				: summary.dailyGain > INTENSIVE_GAIN || summary.minutes > INTENSIVE_MINUTES
					? 'intensive'
					: 'steady';
		// Introductions include words the learner probably knows; only call them out when they make a real difference.
		const known = summary.dailyNew - summary.dailyGain;
		const split = known >= Math.max(3, 0.1 * summary.dailyNew);
		// The part of introductions new to the learner, as the pace assumes, turns a sustainable daily gain into
		// this learner's own minutes. It depends on their level, not on the target (beyond rounding).
		const share = summary.dailyNew > 0 ? summary.dailyGain / summary.dailyNew : 0;
		const sustainable = share
			? { percent: Math.round(share * 20) * 5, minutes: studyMinutes(Math.ceil(SUSTAINABLE.low / share)) }
			: null;
		return { plan, summary, saved: unchanged, ended, targets, late, pace, split, known, sustainable, reached: summary.reached };
	});

	function saveGoal() {
		if (!learner || !goal) return;
		setPlan(learner, goal.plan);
		saveLearner(learner);
		learner = { ...learner };
		pickTarget = pickDays = null;
	}

	function removeGoal() {
		if (!learner) return;
		setPlan(learner, null);
		saveLearner(learner);
		learner = { ...learner };
		pickTarget = pickDays = null;
	}

	function updateSettings(change: Partial<Settings>) {
		if (!settings) return;
		settings = { ...settings, ...change };
		// Merge into what is stored, so settings changed in another tab are kept.
		saveSettings({ ...loadSettings(), ...change });
	}
</script>

<Seo
	title="Plan"
	path="/plan"
	description="Your estimated vocabulary, a daily goal with an honest workload, and reviews timed by spaced repetition, stored in this browser."
/>

<Page title="Your plan." lead="A daily path to a bigger vocabulary. Everything here is stored only in this browser.">
	{#if !learner}
		<p class="empty">Loading…</p>
	{:else if !started}
		<section class="hero">
			<p class="ask">How many English words do you know?</p>
			<p class="intro">
				A short level test, about three minutes, estimates your vocabulary and finds where new words should start. After that,
				each day brings a mix of new words and reviews timed to stick.
			</p>
			<div class="actions">
				<a class="button primary" href={startHref('placement')}>Find your level</a>
				<a class="button" href={startHref('learn')}>Skip: start with the most common words</a>
			</div>
		</section>
	{:else if failed}
		<p class="empty">The word list could not be loaded. Check your connection and reload the page.</p>
	{:else if !view || !goal}
		<p class="empty">Loading…</p>
	{:else}
		{@const s = view.summary}
		{@const b = view.breakdown}
		<section class="hero">
			{#if ready}
				<p class="estimate">≈ {n(roundEstimate(s.estimate))} <span>words</span></p>
				<p class="likely">likely {view.likely}</p>
			{:else}
				<p class="ask">Your estimate is on its way.</p>
				<p class="intro">
					It shows after the three-minute level test, or once you have answered about {n(toGo)} more words for the first time.
					Until then it would only be a guess.
				</p>
			{/if}
			<p class="counts">
				{n(view.mastered)} mastered · {n(view.learning)} learning · {n(view.ahead[0] ?? 0)} due today
			</p>
			{#if b.confirmed + b.learned > 0}
				<p class="sub">Verified so far: {n(b.confirmed)} confirmed · {n(b.learned)} newly learned</p>
			{/if}
			{#if ready}
				<p class="sub">Most new words now come from words {view.range}</p>
				<p class="note">
					{#if learner.placement}
						An estimate from your level test{learner.placement.at
							? ` on ${new Date(learner.placement.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
							: ''}, about {n(roundEstimate(learner.placement.estimate))} words then. Every answer since keeps refining it.
					{:else}
						An estimate from your answers so far. The level test makes it sharper.
					{/if}
					Confirmed words were right at first sight and again since; newly learned ones were missed at first and have stuck for a week or more.
				</p>
			{/if}
			<div class="actions">
				{#if ready}
					<a class="button primary" href={startHref('learn')}>Start learning</a>
					<a class="button" href={startHref('placement')}>{learner.placement ? 'Retake level test' : 'Find your level'}</a>
				{:else}
					<a class="button primary" href={startHref('placement')}>Find your level</a>
					<a class="button" href={startHref('learn')}>Keep learning</a>
				{/if}
			</div>
		</section>

		<section>
			<h2>Goal</h2>
			{#if !ready}
				<p class="note">
					A goal needs to know where you start. Once your estimate shows, pick a target and see what it takes each day.
				</p>
			{:else}
				<p class="lede">Grow your estimated vocabulary to</p>
				<div class="chips" role="radiogroup" aria-label="Target vocabulary">
					{#each goal.targets as t (t)}
						<button
							type="button"
							role="radio"
							aria-checked={goal.plan.target === t}
							class:on={goal.plan.target === t}
							onclick={() => (pickTarget = t)}>{n(t)}</button
						>
					{/each}
				</div>
				<p class="lede">in</p>
				<div class="chips" role="radiogroup" aria-label="Plan length">
					{#each DURATIONS as d (d)}
						<button
							type="button"
							role="radio"
							aria-checked={goal.plan.days === d}
							class:on={goal.plan.days === d}
							onclick={() => (pickDays = d)}>{d} days</button
						>
					{/each}
				</div>

				{@const g = goal.summary}
				<div class={['readout', goal.pace]} aria-live="polite">
					{#if goal.reached}
						<p class="pace">You are already at about {n(roundEstimate(g.estimate))}. Pick a bigger goal to keep growing.</p>
					{:else}
						<p class="pace">
							{#if goal.split}
								≈ {n(g.dailyNew)} words a day, about {n(g.dailyGain)} new to you
							{:else}
								≈ {n(g.dailyNew)} new words a day
							{/if}
							· ~{n(g.minutes)} min a day{g.finish ? ` · reach ${n(goal.plan.target)} by ${day(g.finish)}` : ''}
						</p>
						{#if goal.split && goal.pace !== 'unrealistic'}
							<p class="detail">
								The other {n(goal.known)} or so are words you probably know already: a right answer or two confirms each, and
								they come back now and then for a quick review.
							</p>
						{/if}
						{#if goal.pace === 'unrealistic'}
							<p class="detail warn">
								{#if goal.late && g.deadline}
									Out of reach by the {day(g.deadline)} deadline, even at {n(MAX_DAILY_NEW)} words a day, the most the course allows.
								{:else}
									This takes {n(MAX_DAILY_NEW)} words a day, the most the course allows: not a realistic pace to keep up.
								{/if}
								Choose a smaller goal or more days.
							</p>
						{:else if goal.pace === 'intensive'}
							<p class="detail warn">
								This is an intensive pace: about {n(g.dailyGain)} genuinely new words and {n(g.minutes)} minutes of study every day.
							</p>
						{/if}
					{/if}
					{#if goal.saved}
						<p class="detail">
							{#if goal.reached}
								Goal reached.
							{:else}
								<span class={['status', g.onTrack ? 'ok' : 'behind']}>{g.onTrack ? 'On track' : 'Behind'}</span>
								Today {n(view.today.newIntroduced)} of {n(g.dailyNew)} words introduced · {n(view.today.reviews)}
								{view.today.reviews === 1 ? 'review' : 'reviews'} · {g.daysLeft}
								{g.daysLeft === 1 ? 'day' : 'days'} left
							{/if}
						</p>
					{/if}
				</div>

				{#if goal.ended}
					<p class="detail">Your last plan ended on {day(goal.ended)}. Save a goal to start a new one from today.</p>
				{/if}
				<div class="actions">
					<button type="button" class="button primary" disabled={goal.saved} onclick={saveGoal}
						>{goal.saved ? 'Goal saved' : learner.plan ? 'Save new goal' : 'Save goal'}</button
					>
					{#if learner.plan}
						<button type="button" class="link" onclick={removeGoal}>Remove goal</button>
					{/if}
				</div>
				<p class="note">
					Your goal follows your estimated vocabulary. Words you probably know were counted from the start, so it grows with words
					that are new to you; confirming words you already knew moves it only a little. Verified words are the part your answers
					have checked directly.
				</p>
				<p class="note">
					Most learners can keep up about {SUSTAINABLE.low}–{SUSTAINABLE.high} genuinely new words a day.
					{#if goal.sustainable}
						{@const { percent, minutes } = goal.sustainable}
						{percent >= 95 ? 'Nearly all' : `About ${percent}%`} of the words you meet at your level are new to you, so
						{SUSTAINABLE.low} of them a day take about {n(minutes)} minutes of study.
					{/if}
				</p>
				{#if goal.plan.target > view.words}
					<p class="note">The course has {n(view.words)} words, so this goal counts as all of them.</p>
				{/if}
			{/if}
		</section>

		<section>
			<h2>Coverage by frequency band</h2>
			<Coverage
				label="Words mastered, learning and estimated known in each band of a thousand words, most frequent first"
				bands={view.coverage}
				bandSize={view.bandSize}
				milestones={STAGES}
			/>
			<p class="note">
				Each bar is a thousand words, most frequent first. Mastered words are remembered for three weeks or more; estimated
				known words are ones you have not met here but probably know{ready ? '' : '; they appear once your estimate does'}. The stages are rough: the course counts content words one
				dictionary form at a time, so word-family figures from research do not map onto it exactly.
			</p>
		</section>

		<section>
			<h2>Reviews ahead</h2>
			<Bars
				label="Reviews falling due on each of the next 14 days"
				height={150}
				max={Math.max(2, Math.ceil(Math.max(...view.ahead) / 2) * 2)}
				bars={view.ahead.map((count, i) => {
					const date = new Date(addDays(today, i) + 'T00:00');
					const label = i === 0 ? 'Today' : date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
					return {
						label,
						value: count,
						tip: `${i === 0 ? 'Today' : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}: ${n(count)} ${count === 1 ? 'review' : 'reviews'}`
					};
				})}
			/>
			<p class="note">Words you have already met, by the day they fall due. Today includes overdue ones; new words add their own.</p>
		</section>
	{/if}

	{#if settings}
		<section>
			<h2>Settings</h2>
			<div class="setting">
				<span class="label" id="gloss-label">Meanings after an answer</span>
				<div class="chips" role="radiogroup" aria-labelledby="gloss-label">
					{#each GLOSSES as g (g.id)}
						<button
							type="button"
							role="radio"
							aria-checked={settings.gloss === g.id}
							class:on={settings.gloss === g.id}
							onclick={() => updateSettings({ gloss: g.id })}>{g.label}</button
						>
					{/each}
				</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={settings.speak}
				class="toggle"
				onclick={() => updateSettings(settings?.speak ? { speak: false } : { speak: true, sound: true })}
			>
				<span><strong>Say words aloud</strong><small>Speak the answer word while you learn. Muting sound (M) silences it too.</small></span>
				<span class="knob" aria-hidden="true"></span>
			</button>
			<button
				type="button"
				role="switch"
				aria-checked={settings.studyPause}
				class="toggle"
				onclick={() => updateSettings({ studyPause: !settings?.studyPause })}
			>
				<span><strong>Pause to study mistakes</strong><small>Hold a missed or unfamiliar word long enough to read its meaning.</small></span>
				<span class="knob" aria-hidden="true"></span>
			</button>
		</section>
	{/if}

	<section>
		<h2>How it works</h2>
		<ul class="how">
			<li>Words come in order of how often they appear in English, so the most useful ones come first.</li>
			<li>
				A short level test estimates your vocabulary and finds where to start. It is a rough guide, and your daily answers keep
				refining it.
			</li>
			<li>
				Each question asks you to pick the word that fits a sentence. A quick correct answer means you know the word well; a slow
				or wrong one means it needs more practice.
			</li>
			<li>After every answer you see the word's meaning. Words you miss come back a few items later, in a new sentence when there is one.</li>
			<li>Words you know return at growing intervals, timed for when you are likely to start forgetting them.</li>
			<li>New words slow down when your accuracy drops, so reviews stay manageable.</li>
		</ul>
	</section>
</Page>

<style>
	.empty {
		margin-top: 3rem;
		font-size: var(--choice-size);
		color: var(--text-secondary);
	}

	.hero {
		margin-top: 2.5rem;
	}

	.ask {
		margin: 0;
		font-size: clamp(1.5rem, 1.1rem + 1.6vw, 2.3rem);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.15;
	}

	.intro {
		max-width: 38rem;
		margin: 0.8rem 0 0;
		font-size: 1rem;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.estimate {
		margin: 0;
		font-size: clamp(2.6rem, 1.6rem + 4vw, 4.6rem);
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
	}

	.estimate span {
		font-size: 0.4em;
		font-weight: 600;
		letter-spacing: 0;
		color: var(--text-secondary);
	}

	.counts {
		margin: 0.9rem 0 0;
		font-size: 1.05rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.likely {
		margin: 0.5rem 0 0;
		font-size: 1rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.sub {
		margin: 0.3rem 0 0;
		font-size: 0.95rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.note {
		max-width: 44rem;
		margin: 0.75rem 0 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem 1rem;
		margin-top: 1.4rem;
	}

	.button {
		display: inline-flex;
		align-items: center;
		padding: 0.7rem 1.1rem;
		border: 0;
		border-radius: 0.8rem;
		font: inherit;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.button:hover {
		background: var(--surface-hover);
	}

	.button.primary {
		color: var(--bg);
		background: var(--ink);
		box-shadow: none;
	}

	.button:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.link {
		padding: 0;
		border: 0;
		font: inherit;
		font-size: 0.85rem;
		color: var(--text-secondary);
		background: none;
		cursor: pointer;
	}

	.link:hover {
		color: var(--ink);
	}

	.lede {
		margin: 1rem 0 0.6rem;
		font-size: 0.95rem;
		color: var(--text-secondary);
	}

	.lede:first-of-type {
		margin-top: 0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.chips button {
		padding: 0.5rem 0.95rem;
		border: 0;
		border-radius: 999px;
		font: inherit;
		font-size: 0.95rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
		cursor: pointer;
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
	}

	.chips button:hover {
		background: var(--surface-hover);
	}

	.chips button.on {
		background: var(--surface-strong);
		box-shadow: inset 0 0 0 1.5px var(--ink);
	}

	.readout {
		display: grid;
		gap: 0.45rem;
		margin-top: 1.4rem;
		padding: 1rem 1.1rem;
		border-radius: 1rem;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.readout p {
		margin: 0;
	}

	.pace {
		font-size: 1.1rem;
		font-weight: 650;
		line-height: 1.4;
		font-variant-numeric: tabular-nums;
	}

	.detail {
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.warn {
		color: var(--urgent);
	}

	.readout.unrealistic {
		box-shadow: inset 0 0 0 1px rgb(255 179 122 / 0.45);
	}

	.status {
		display: inline-block;
		margin-right: 0.4rem;
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 600;
	}

	.status.ok {
		color: var(--positive);
		background: var(--positive-surface);
	}

	.status.behind {
		color: var(--urgent);
		background: rgb(255 179 122 / 0.16);
	}

	.setting {
		display: grid;
		gap: 0.6rem;
		margin-bottom: 1.2rem;
	}

	.label {
		font-size: 0.95rem;
		font-weight: 600;
	}

	.toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		width: 100%;
		padding: 0.85rem 0;
		border: 0;
		border-top: 1px solid var(--hairline);
		font: inherit;
		text-align: left;
		color: var(--ink);
		background: none;
		cursor: pointer;
	}

	.toggle strong {
		display: block;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.toggle small {
		display: block;
		margin-top: 0.2rem;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.knob {
		position: relative;
		flex: none;
		width: 2.6rem;
		height: 1.5rem;
		border-radius: 999px;
		background: var(--surface-strong);
		transition: background-color 150ms ease;
	}

	.knob::after {
		content: '';
		position: absolute;
		top: 0.2rem;
		left: 0.2rem;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		background: var(--ink);
		transition: transform 150ms ease;
	}

	.toggle[aria-checked='true'] .knob {
		background: var(--series-1);
	}

	.toggle[aria-checked='true'] .knob::after {
		transform: translateX(1.1rem);
	}

	.button:focus-visible,
	.chips button:focus-visible,
	.toggle:focus-visible,
	.link:focus-visible {
		outline: 2px solid var(--series-1);
		outline-offset: 2px;
	}

	.how {
		display: grid;
		gap: 0.6rem;
		max-width: 44rem;
		margin: 0;
		padding-left: 1.1rem;
		font-size: 0.95rem;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.how li::marker {
		color: var(--text-muted);
	}
</style>
