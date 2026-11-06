<script lang="ts">
	interface RadarSeries {
		name: string;
		/** CSS color token, e.g. var(--series-1). */
		color: string;
		/** One value per axis on a 0–100 scale; null where there is no data yet. */
		values: (number | null)[];
	}

	interface Props {
		axes: string[];
		series: RadarSeries[];
		label: string;
	}

	let { axes, series, label }: Props = $props();

	/** Rough width of a 12px semibold axis-label character; the layout makes room for each label. */
	const CHAR_W = 7.2;
	/** Labels sit this far beyond the outer ring. */
	const OFFSET = 10;
	/** Least space kept between a label and the edge of the chart. */
	const MARGIN = 4;
	const MAX_SIZE = 380;
	/** Below this radius, side labels stop sitting beside the chart. */
	const MIN_BESIDE = 90;

	/** Drawn at the rendered pixel width so labels stay the same size and fit at any width. */
	let W = $state(MAX_SIZE);
	const size = $derived(Math.min(MAX_SIZE, W));
	const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
	/** Labels within this horizontal distance of the centre are centred on their spoke. */
	const centred = (i: number) => Math.abs(Math.cos(angle(i))) < 0.05;
	/**
	 * The largest radius at which every side label fits beside the chart: a label anchored at
	 * cos·(R + OFFSET) from the centre runs its full width outward.
	 */
	const beside = $derived.by(() => {
		let r = 112;
		axes.forEach((axis, i) => {
			if (centred(i)) return;
			const room = size / 2 - axis.length * CHAR_W - MARGIN;
			r = Math.min(r, room / Math.abs(Math.cos(angle(i))) - OFFSET);
		});
		return r;
	});
	/**
	 * Where that would shrink the chart too far (long labels on a phone), side labels move off
	 * the spoke ends to sit just above or below them, flush with the chart's edge.
	 */
	const stacked = $derived(beside < MIN_BESIDE);
	const R = $derived(stacked ? Math.min(112, size / 2 - MARGIN - 6) : beside);
	/** Height leaves a text line above and below the rings for the top and bottom labels. */
	const H = $derived(2 * (R + OFFSET + 14));
	const point = (i: number, v: number) => [
		size / 2 + (Math.cos(angle(i)) * (R * v)) / 100,
		H / 2 + (Math.sin(angle(i)) * (R * v)) / 100
	];
	/** A label's position and anchor. */
	function labelAt(i: number): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
		if (centred(i)) {
			const [x, y] = point(i, ((R + OFFSET + 4) / R) * 100);
			return { x, y, anchor: 'middle' };
		}
		const right = Math.cos(angle(i)) > 0;
		const anchor = right ? 'start' : 'end';
		if (!stacked) {
			const [x, y] = point(i, ((R + OFFSET) / R) * 100);
			return { x, y, anchor };
		}
		const [, tipY] = point(i, 100);
		return {
			x: right ? size - MARGIN : MARGIN,
			y: tipY + (Math.sin(angle(i)) > 0.05 ? 18 : -18),
			anchor: right ? 'end' : 'start'
		};
	}
	const ring = (v: number) => axes.map((_, i) => point(i, v).join(',')).join(' ');

	let hover = $state<number | null>(null);
</script>

<figure class="radar" bind:clientWidth={() => W, (w) => (W = Math.max(200, w || MAX_SIZE))}>
	<ul class="legend">
		{#each series as s (s.name)}
			<li><span class="swatch" style:background={s.color}></span>{s.name}</li>
		{/each}
	</ul>
	<svg viewBox="0 0 {size} {H}" style:width="{size}px" role="img" aria-label={label} onpointerleave={() => (hover = null)}>
		{#each [25, 50, 75, 100] as v (v)}
			<polygon class="ring" points={ring(v)} />
		{/each}
		{#each axes as axis, i (axis)}
			{@const [x, y] = point(i, 100)}
			{@const at = labelAt(i)}
			<line class="spoke" x1={size / 2} y1={H / 2} x2={x} y2={y} />
			<text
				class="axis"
				class:active={hover === i}
				x={at.x}
				y={at.y}
				dy="0.32em"
				text-anchor={at.anchor}>{axis}</text
			>
			<circle class="hit" cx={x} cy={y} r="36" role="presentation" onpointerenter={() => (hover = i)} />
		{/each}
		{#each series as s (s.name)}
			<polygon
				class="area"
				style:fill={s.color}
				style:stroke={s.color}
				points={axes.map((_, i) => point(i, s.values[i] ?? 0).join(',')).join(' ')}
			/>
			{#each s.values as v, i (i)}
				{#if v !== null}
					{@const [x, y] = point(i, v)}
					<circle class="dot" cx={x} cy={y} r={hover === i ? 5 : 4} style:fill={s.color} />
				{/if}
			{/each}
		{/each}
		{#if hover !== null}
			<g class="tip">
				{#each series as s, k (s.name)}
					<text x={size / 2} y={H / 2 - 8 + k * 18} text-anchor="middle"
						>{s.name}: {s.values[hover] === null ? '—' : Math.round(s.values[hover] ?? 0)}</text
					>
				{/each}
			</g>
		{/if}
	</svg>
</figure>

<style>
	.radar {
		margin: 0;
	}

	svg {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 0 auto;
		overflow: visible;
	}

	.legend {
		display: flex;
		gap: 1rem;
		margin: 0 0 0.5rem;
		padding: 0;
		list-style: none;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.swatch {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 3px;
	}

	.ring {
		fill: none;
		stroke: var(--hairline);
	}

	.spoke {
		stroke: var(--hairline);
	}

	.axis {
		fill: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
	}

	.axis.active {
		fill: var(--ink);
	}

	.area {
		fill-opacity: 0.16;
		stroke-width: 2;
		stroke-linejoin: round;
	}

	.dot {
		stroke: var(--bg);
		stroke-width: 2;
	}

	.hit {
		fill: transparent;
	}

	.tip text {
		fill: var(--ink);
		font-size: 12px;
		font-weight: 600;
		paint-order: stroke;
		stroke: var(--bg);
		stroke-width: 4px;
	}
</style>
