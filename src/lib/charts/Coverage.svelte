<script lang="ts">
	interface BandCoverage {
		band: number;
		mastered: number;
		learning: number;
		estimated: number;
		unknown: number;
	}

	/** A rough stage on the frequency scale, in words (ranks); a range when `to` is set. */
	interface Milestone {
		from: number;
		to?: number;
		label: string;
	}

	interface Props {
		bands: BandCoverage[];
		/** Words per band, to place milestones and name word ranges. */
		bandSize: number;
		milestones?: Milestone[];
		height?: number;
		label: string;
	}

	let { bands, bandSize, milestones = [], height = 200, label }: Props = $props();

	/**
	 * An ordinal single-hue ramp validated on the dark surface (#1a1c24): the firmer the
	 * knowledge, the lighter the segment. Local to this chart; text never uses these.
	 */
	const SERIES = [
		{ key: 'mastered', name: 'Mastered', color: '#9ec5f4' },
		{ key: 'learning', name: 'Learning', color: '#3987e5' },
		{ key: 'estimated', name: 'Estimated known', color: '#1c5cab' }
	] as const;
	const GAP = 2;
	const RADIUS = 4;
	/** Rough width of an 11px label character, for laying out milestone labels. */
	const CHAR_W = 6.2;
	const ROW_H = 15;

	const n = (v: number) => v.toLocaleString('en-US');
	const total = (b: BandCoverage) => b.mastered + b.learning + b.estimated + b.unknown;

	/** Drawn at the rendered pixel width so text stays the same size at any width. */
	let W = $state(600);
	const right = 8;
	const bottom = 26;
	const max = $derived(Math.max(1, ...bands.map(total)));
	/** Room for the widest tick label (the top one), so it never runs off the left edge. */
	const left = $derived(Math.max(24, Math.ceil(n(max).length * CHAR_W) + 14));
	const step = $derived((W - left - right) / Math.max(1, bands.length));
	const barW = $derived(Math.max(4, Math.min(40, step - 4)));
	const xOf = (words: number) => left + (words / bandSize) * step;
	const labelEvery = $derived(Math.max(1, Math.ceil(26 / step)));

	/** Milestone labels go in as few rows as fit without overlapping. */
	const marks = $derived.by(() => {
		const ends: number[] = [];
		return milestones.map((m) => {
			const width = m.label.length * CHAR_W;
			const x = Math.max(left, Math.min(xOf(m.from) + 4, W - right - width));
			let row = ends.findIndex((end) => end + 10 <= x);
			if (row < 0) row = ends.push(0) - 1;
			ends[row] = x + width;
			return { ...m, x, row };
		});
	});
	const rows = $derived(marks.reduce((r, m) => Math.max(r, m.row + 1), 0));
	const top = $derived(rows ? rows * ROW_H + 10 : 10);
	const H = $derived(height + top);
	const plotH = $derived(height - bottom);

	const base = $derived(top + plotH);

	/** A bar with a rounded top, from `y` (top) down `h` pixels. */
	function column(x: number, y: number, w: number, h: number, round: boolean): string {
		const r = round ? Math.min(RADIUS, w / 2, h) : 0;
		return `M${x},${y + h} V${y + r} q0,${-r} ${r},${-r} H${x + w - r} q${r},0 ${r},${r} V${y + h} Z`;
	}

	/** Segments of one band from the bottom up, each separated by a gap; the remainder is the empty track. */
	function stack(b: BandCoverage) {
		const scale = plotH / max;
		const parts = [
			...SERIES.map((s) => ({ color: s.color as string | null, value: b[s.key] })),
			{ color: null, value: b.unknown }
		].filter((p) => p.value > 0);
		let y = base;
		return parts.map((p, i) => {
			const h = Math.max(1.5, p.value * scale - (i ? GAP : 0));
			y -= (i ? GAP : 0) + h;
			return { color: p.color, y, h, round: i === parts.length - 1 };
		});
	}

	let hover = $state<number | null>(null);
	let tipW = $state(180);
	const tip = $derived.by(() => {
		if (hover === null) return null;
		const b = bands[hover];
		const size = total(b);
		const pct = (v: number) => (size ? `${Math.round((v / size) * 100)}%` : '—');
		const cx = left + step * hover + step / 2;
		const after = cx + step / 2 + 6;
		const x = after + tipW <= W ? after : Math.max(0, cx - step / 2 - 6 - tipW);
		return {
			x,
			title: `Words ${n((b.band - 1) * bandSize + 1)}–${n((b.band - 1) * bandSize + size)}`,
			rows: [
				...SERIES.map((s) => ({ name: s.name, color: s.color as string | null, value: b[s.key], pct: pct(b[s.key]) })),
				{ name: 'Not known yet', color: null, value: b.unknown, pct: pct(b.unknown) }
			]
		};
	});

	function leave(e: PointerEvent) {
		// A tap leaves on lift; keep its tooltip until the next tap.
		if (e.pointerType === 'mouse') hover = null;
	}
</script>

<figure class="coverage" bind:clientWidth={() => W, (w) => (W = Math.max(240, w || 600))}>
	<ul class="legend">
		{#each SERIES as s (s.key)}
			<li><span class="swatch" style:background={s.color}></span>{s.name}</li>
		{/each}
		<li><span class="swatch track"></span>Not known yet</li>
	</ul>

	<div class="plot">
		<svg viewBox="0 0 {W} {H}" role="img" aria-label={label} onpointerleave={leave}>
			{#each marks as m (m.label)}
				{@const x0 = xOf(m.from)}
				{@const ty = 10 + m.row * ROW_H}
				<line class="mark" x1={x0} x2={x0} y1={ty + 4} y2={base} />
				{#if m.to !== undefined}
					{@const x1 = xOf(m.to)}
					<line class="mark" x1={x1} x2={x1} y1={ty + 4} y2={base} />
					<line class="bracket" x1={x0} x2={x1} y1={ty + 4} y2={ty + 4} />
				{/if}
				<text class="stage" x={m.x} y={ty}>{m.label}</text>
			{/each}

			{#each [0, 0.5, 1] as f (f)}
				<text class="axis" x={left - 8} y={base - f * plotH} dy="0.32em" text-anchor="end">{n(Math.round(f * max))}</text>
			{/each}

			{#each bands as b, i (b.band)}
				{@const x = left + step * i + (step - barW) / 2}
				<g role="presentation" onpointerenter={() => (hover = i)} class:dim={hover !== null && hover !== i}>
					<rect class="hit" x={left + step * i} y={top} width={step} height={plotH + bottom} />
					{#each stack(b) as s, k (k)}
						<path class={['seg', !s.color && 'track']} style:fill={s.color} d={column(x, s.y, barW, s.h, s.round)} />
					{/each}
					{#if i % labelEvery === 0}
						<text class="axis" x={x + barW / 2} y={H - 8} text-anchor="middle">{b.band}k</text>
					{/if}
				</g>
			{/each}
			<line class="base" x1={left} x2={W - right} y1={base} y2={base} />
		</svg>

		{#if tip}
			<div class="tip" style:left="{tip.x}px" style:top="{top}px" bind:offsetWidth={tipW}>
				<strong>{tip.title}</strong>
				{#each tip.rows as r (r.name)}
					<span class="row">
						<span class={['swatch', !r.color && 'track']} style:background={r.color}></span>
						<span class="name">{r.name}</span>
						<span class="value">{n(r.value)}</span>
						<span class="pct">{r.pct}</span>
					</span>
				{/each}
			</div>
		{/if}
	</div>

	<details>
		<summary>Show as a table</summary>
		<div class="scroll">
			<table>
				<thead>
					<tr><th>Words</th>{#each SERIES as s (s.key)}<th>{s.name}</th>{/each}<th>Not yet</th></tr>
				</thead>
				<tbody>
					{#each bands as b (b.band)}
						<tr>
							<td>{n((b.band - 1) * bandSize + 1)}–{n((b.band - 1) * bandSize + total(b))}</td>
							<td>{n(b.mastered)}</td>
							<td>{n(b.learning)}</td>
							<td>{n(b.estimated)}</td>
							<td>{n(b.unknown)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
</figure>

<style>
	.coverage {
		margin: 0;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.2rem;
		margin: 0 0 0.75rem;
		padding: 0;
		list-style: none;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	.swatch {
		width: 0.7rem;
		height: 0.7rem;
		flex: none;
		border-radius: 0.2rem;
	}

	.swatch.track {
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.plot {
		position: relative;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
		touch-action: pan-y;
	}

	.axis {
		fill: var(--text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.stage {
		fill: var(--text-secondary);
		font-size: 11px;
	}

	.mark {
		stroke: rgb(255 255 255 / 0.3);
		stroke-dasharray: 3 3;
	}

	.bracket {
		stroke: rgb(255 255 255 / 0.3);
	}

	.base {
		stroke: rgb(255 255 255 / 0.25);
	}

	.seg {
		transition: opacity 120ms ease;
	}

	.seg.track {
		fill: var(--surface);
	}

	.dim .seg {
		opacity: 0.45;
	}

	.hit {
		fill: transparent;
	}

	.tip {
		position: absolute;
		display: grid;
		gap: 0.25rem;
		min-width: 11rem;
		padding: 0.6rem 0.75rem;
		border-radius: 0.7rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
		background: rgb(26 28 36 / 0.94);
		box-shadow:
			inset 0 0 0 1px var(--hairline),
			0 8px 24px rgb(0 0 0 / 0.35);
		pointer-events: none;
		font-variant-numeric: tabular-nums;
	}

	.tip strong {
		color: var(--ink);
		font-weight: 600;
	}

	.tip .row {
		display: grid;
		grid-template-columns: auto 1fr auto 2.6rem;
		align-items: center;
		gap: 0.5rem;
	}

	.tip .value {
		color: var(--ink);
		text-align: right;
	}

	.tip .pct {
		text-align: right;
		color: var(--text-muted);
	}

	details {
		margin-top: 0.75rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	summary {
		cursor: pointer;
		width: fit-content;
	}

	summary:hover {
		color: var(--text-secondary);
	}

	.scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		margin-top: 0.6rem;
		border-collapse: collapse;
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary);
	}

	th {
		font-weight: 500;
		color: var(--text-muted);
	}

	th,
	td {
		padding: 0.35rem 0 0.35rem 0.75rem;
		text-align: right;
		vertical-align: bottom;
		border-bottom: 1px solid var(--hairline);
	}

	td {
		white-space: nowrap;
	}

	th:first-child,
	td:first-child {
		padding-left: 0;
		text-align: left;
	}
</style>
