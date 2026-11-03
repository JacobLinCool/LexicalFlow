<script lang="ts">
	interface Bar {
		label: string;
		value: number;
		/** Tooltip text; defaults to the value. */
		tip?: string;
		/** Bars with too little data are drawn hatched-pale. */
		faint?: boolean;
	}

	interface Props {
		bars: Bar[];
		/** Top of the scale; defaults to the largest value. */
		max?: number;
		format?: (v: number) => string;
		height?: number;
		label: string;
	}

	let { bars, max, format = (v) => String(v), height = 180, label }: Props = $props();

	/** Drawn at the rendered pixel width so text stays the same size at any width. */
	let W = $state(600);
	const PAD = { top: 22, right: 8, bottom: 26, left: 40 };
	const top = $derived(max ?? Math.max(1, ...bars.map((b) => b.value)));
	const plotH = $derived(height - PAD.top - PAD.bottom);
	const step = $derived((W - PAD.left - PAD.right) / Math.max(1, bars.length));
	const barW = $derived(Math.max(4, Math.min(48, step - 6)));
	const ticks = $derived([0, 0.5, 1].map((f) => f * top));
	const showEvery = $derived(Math.ceil(bars.length / 12));

	let hover = $state<number | null>(null);

	const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
</script>

<figure class="chart" bind:clientWidth={() => W, (w) => (W = Math.max(240, w || 600))}>
	<svg viewBox="0 0 {W} {height}" role="img" aria-label={label} onpointerleave={() => (hover = null)}>
		{#each ticks as t (t)}
			<line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
			<text class="axis" x={PAD.left - 8} y={y(t)} dy="0.32em" text-anchor="end">{format(t)}</text>
		{/each}
		{#each bars as bar, i (bar.label)}
			{@const cx = PAD.left + step * i + step / 2}
			{@const h = Math.max(bar.value > 0 ? 2 : 0, (bar.value / top) * plotH)}
			<g
				role="presentation"
				onpointerenter={() => (hover = i)}
				class:dim={hover !== null && hover !== i}
			>
				<rect class="hit" x={cx - step / 2} y={PAD.top} width={step} height={plotH + PAD.bottom} />
				{#if h > 0}
					<path
						class={['bar', bar.faint && 'faint']}
						d="M{cx - barW / 2},{PAD.top + plotH} v{-(h - Math.min(4, h))} q0,{-Math.min(4, h)} {Math.min(4, barW / 2)},{-Math.min(4, h)} h{barW - 2 * Math.min(4, barW / 2)} q{Math.min(4, barW / 2)},0 {Math.min(4, barW / 2)},{Math.min(4, h)} v{h - Math.min(4, h)} z"
					/>
				{/if}
				{#if i % showEvery === 0}
					<text class="axis" x={cx} y={height - 8} text-anchor="middle">{bar.label}</text>
				{/if}
			</g>
		{/each}
		<line class="base" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
		{#if hover !== null}
			{@const bar = bars[hover]}
			{@const cx = PAD.left + step * hover + step / 2}
			<text class="tip" x={Math.min(W - 60, Math.max(PAD.left + 60, cx))} y={Math.max(14, y(bar.value) - 8)} text-anchor="middle"
				>{bar.tip ?? format(bar.value)}</text
			>
		{/if}
	</svg>
</figure>

<style>
	.chart {
		margin: 0;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}

	.grid {
		stroke: var(--hairline);
		stroke-width: 1;
	}

	.base {
		stroke: rgb(255 255 255 / 0.25);
		stroke-width: 1;
	}

	.axis {
		fill: var(--text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.bar {
		fill: var(--series-1);
		transition: opacity 120ms ease;
	}

	.bar.faint {
		fill-opacity: 0.4;
	}

	.dim .bar {
		opacity: 0.45;
	}

	.hit {
		fill: transparent;
	}

	.tip {
		fill: var(--ink);
		font-size: 12px;
		font-weight: 600;
		paint-order: stroke;
		stroke: var(--bg);
		stroke-width: 4px;
	}
</style>
