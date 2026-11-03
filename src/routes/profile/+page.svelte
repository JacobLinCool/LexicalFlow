<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '#lib/charts/Bars.svelte';
	import Radar from '#lib/charts/Radar.svelte';
	import Trend from '#lib/charts/Trend.svelte';
	import Page from '#lib/components/Page.svelte';
	import { MODES } from '#lib/modes.ts';
	import { TIME_BINS, averageMs, dayKey, loadProgress, resetProgress, type Progress, type Tally } from '#lib/progress.ts';
	import Seo from '#lib/seo/Seo.svelte';
	import { CATEGORIES } from '#lib/types.ts';

	let progress = $state<Progress | null>(null);
	let confirming = $state(false);

	onMount(() => {
		progress = loadProgress();
	});

	const n = (v: number) => v.toLocaleString('en-US');
	const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
	const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`);
	const title = (s: string) => s[0].toUpperCase() + s.slice(1);

	/** Accuracy and mean points per question for a tally; null when there is no data. */
	function rates(t: Tally | undefined) {
		if (!t || !t[0]) return { accuracy: null, points: null, attempts: 0 };
		return { accuracy: t[1] / t[0], points: t[4] / t[0], attempts: t[0] };
	}

	/** A word counts as mastered after two or more attempts at 80% accuracy or better. */
	const MASTERED = { attempts: 2, accuracy: 0.8 };

	const view = $derived.by(() => {
		const p = progress;
		if (!p) return null;
		const words = Object.entries(p.words).map(([word, w]) => ({
			word,
			attempts: w[0],
			accuracy: w[1] / w[0],
			avgMs: w[0] - w[3] > 0 ? w[4] / (w[0] - w[3]) : null
		}));
		const rated = words.filter((w) => w.attempts >= MASTERED.attempts);
		const mastered = rated.filter((w) => w.accuracy >= MASTERED.accuracy);
		const weakest = [...rated]
			.filter((w) => w.accuracy < 1)
			.sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
			.slice(0, 12);
		const strongest = [...mastered]
			.sort((a, b) => b.accuracy - a.accuracy || (a.avgMs ?? 5000) - (b.avgMs ?? 5000))
			.slice(0, 12);

		const categories = CATEGORIES.map((c) => ({ name: title(c), ...rates(p.categories[c]) }));

		const levels = [1, 2, 3, 4, 5].map((l) => ({ level: l, ...rates(p.levels[String(l)]) }));

		const today = new Date();
		const days = Array.from({ length: 30 }, (_, i) => {
			const d = new Date(today);
			d.setDate(today.getDate() - 29 + i);
			const t = p.days[dayKey(d)];
			return { date: d, attempts: t?.[0] ?? 0, correct: t?.[1] ?? 0 };
		});

		const runs = p.runs.slice(-40);
		const runsByMode = Object.fromEntries(MODES.map((m) => [m.id, p.runs.filter((r) => r.mode === m.id).length]));

		return { p, words, mastered, weakest, strongest, categories, levels, days, runs, runsByMode };
	});

	function reset() {
		if (!confirming) {
			confirming = true;
			return;
		}
		progress = resetProgress();
		confirming = false;
	}
</script>

<Seo title="Profile" path="/profile" description="Your accuracy, speed and word-level progress, stored in this browser." />

<Page
	title="Your flow."
	lead={view?.p.since
		? `Playing since ${new Date(view.p.since).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}. Everything here is stored only in this browser.`
		: 'Everything here is stored only in this browser.'}
>
	{#if !view}
		<p class="empty">Loading…</p>
	{:else if !view.p.attempted}
		<p class="empty">Nothing yet. Play a few sentences and your profile fills in here.</p>
	{:else}
		{@const p = view.p}
		<section>
			<h2>Overall</h2>
			<dl class="tiles">
				<div><dt>Answered</dt><dd>{n(p.attempted)}</dd></div>
				<div><dt>Accuracy</dt><dd>{pct(p.correct / p.attempted)}</dd></div>
				<div><dt>Average response</dt><dd>{secs(averageMs(p))}</dd></div>
				<div><dt>Total score</dt><dd>{n(p.totalScore)}</dd></div>
				<div><dt>Runs finished</dt><dd>{n(p.runs.length)}</dd></div>
				<div><dt>Words mastered</dt><dd>{n(view.mastered.length)}<small> / {n(view.words.length)} seen</small></dd></div>
			</dl>
			<p class="note">
				{n(p.correct)} correct, {n(p.incorrect)} wrong, {n(p.timedOut)} timed out. A word counts as mastered after
				{MASTERED.attempts}+ attempts at {MASTERED.accuracy * 100}% accuracy or better.
			</p>
		</section>

		<section>
			<h2>Best runs</h2>
			<dl class="tiles">
				{#each MODES.filter((m) => m.limit !== null || m.hp) as mode (mode.id)}
					{@const best = p.bests[mode.id]}
					<div>
						<dt>{mode.label}</dt>
						<dd>{best ? n(best.score) : '—'}</dd>
						<small>
							{view.runsByMode[mode.id]} {view.runsByMode[mode.id] === 1 ? 'run' : 'runs'}{best
								? ` · ${best.correct}/${best.count} correct`
								: ''}
						</small>
					</div>
				{/each}
			</dl>
		</section>

		<div class="grid">
			<section>
				<h2>Ability by topic</h2>
				<Radar
					label="Accuracy and average points per question by topic"
					axes={view.categories.map((c) => c.name)}
					series={[
						{ name: 'Accuracy %', color: 'var(--series-1)', values: view.categories.map((c) => (c.accuracy === null ? null : c.accuracy * 100)) },
						{ name: 'Points / question', color: 'var(--series-2)', values: view.categories.map((c) => c.points) }
					]}
				/>
				<table class="table">
					<thead><tr><th>Topic</th><th>Answered</th><th>Accuracy</th><th>Points</th></tr></thead>
					<tbody>
						{#each view.categories as c (c.name)}
							<tr>
								<td>{c.name}</td>
								<td>{n(c.attempts)}</td>
								<td>{pct(c.accuracy)}</td>
								<td>{c.points === null ? '—' : Math.round(c.points)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>

			<section>
				<h2>Accuracy by word level</h2>
				<Bars
					label="Accuracy by word difficulty level"
					max={100}
					format={(v) => `${Math.round(v)}%`}
					bars={view.levels.map((l) => ({
						label: ['', 'Common', 'Familiar', 'Mid', 'Rare', 'Very rare'][l.level],
						value: l.accuracy === null ? 0 : l.accuracy * 100,
						faint: l.attempts < 10,
						tip: l.attempts ? `${pct(l.accuracy)} of ${n(l.attempts)}` : 'No answers yet'
					}))}
				/>
				<p class="note">Pale bars rest on fewer than ten answers.</p>

				<h2 class="spaced">Response time</h2>
				<Bars
					label="Number of answers by response time"
					bars={p.times.slice(0, TIME_BINS).map((count, i) => ({
						label: `${(i * 0.5).toFixed(1)}s`,
						value: count,
						tip: `${n(count)} answered in ${(i * 0.5).toFixed(1)}–${((i + 1) * 0.5).toFixed(1)}s`
					}))}
				/>
			</section>
		</div>

		<section>
			<h2>Last 30 days</h2>
			<Bars
				label="Questions answered per day over the last 30 days"
				height={150}
				bars={view.days.map((d) => ({
					label: d.date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
					value: d.attempts,
					tip: `${d.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${n(d.attempts)} answered, ${d.correct} correct`
				}))}
			/>
		</section>

		{#if view.runs.length >= 2}
			<section>
				<h2>Points per question, recent runs</h2>
				<Trend
					label="Average points per question in recent finished runs"
					max={100}
					points={view.runs.map((r) => ({
						value: r.count ? r.score / r.count : 0,
						tip: `${MODES.find((m) => m.id === r.mode)?.label} · ${n(r.score)} pts · ${new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
					}))}
				/>
			</section>
		{/if}

		<div class="grid">
			<section>
				<h2>Needs practice</h2>
				{#if view.weakest.length}
					<ul class="words">
						{#each view.weakest as w (w.word)}
							<li><span>{w.word}</span><span class="meta">{pct(w.accuracy)} of {w.attempts}</span></li>
						{/each}
					</ul>
				{:else}
					<p class="note">Words you miss after a couple of tries show up here.</p>
				{/if}
			</section>
			<section>
				<h2>Strongest words</h2>
				{#if view.strongest.length}
					<ul class="words">
						{#each view.strongest as w (w.word)}
							<li><span>{w.word}</span><span class="meta">{pct(w.accuracy)} · {secs(w.avgMs)}</span></li>
						{/each}
					</ul>
				{:else}
					<p class="note">Words you get right repeatedly show up here.</p>
				{/if}
			</section>
		</div>

		<section class="danger">
			<button type="button" class:confirming onclick={reset} onblur={() => (confirming = false)}>
				{confirming ? 'Click again to erase all progress' : 'Reset progress'}
			</button>
		</section>
	{/if}
</Page>

<style>
	.empty {
		margin-top: 3rem;
		font-size: var(--choice-size);
		color: var(--text-secondary);
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
		gap: 0.75rem;
		margin: 0;
	}

	.tiles > div {
		padding: 1rem 1.1rem;
		border-radius: 1rem;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	dt {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	dd {
		margin: 0.3rem 0 0;
		font-size: 1.8rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
	}

	dd small,
	.tiles small {
		font-size: 0.8rem;
		font-weight: 500;
		letter-spacing: 0;
		color: var(--text-muted);
	}

	.note {
		margin: 0.75rem 0 0;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
		gap: 0 3rem;
	}

	.spaced {
		margin-top: 2rem !important;
	}

	.table {
		width: 100%;
		margin-top: 1rem;
		border-collapse: collapse;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	.table th {
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
	}

	.table th,
	.table td {
		padding: 0.35rem 0;
		border-bottom: 1px solid var(--hairline);
	}

	.table td:not(:first-child),
	.table th:not(:first-child) {
		text-align: right;
	}

	.words {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.words li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--hairline);
		font-size: 1.05rem;
		font-weight: 600;
	}

	.meta {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.danger button {
		padding: 0.6rem 1rem;
		border-radius: 0.8rem;
		font: inherit;
		font-size: 0.85rem;
		color: var(--text-secondary);
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--hairline);
		cursor: pointer;
	}

	.danger button.confirming {
		color: var(--negative);
		box-shadow: inset 0 0 0 1px var(--negative);
	}
</style>
