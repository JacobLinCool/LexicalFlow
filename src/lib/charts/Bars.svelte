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

	/**
	 * Rough widths of an 11px label character: tick labels (digits, %) run wide, bar labels
	 * (mostly letters) narrower. Labels are laid out from these.
	 */
	const CHAR_W = 7;
	const LABEL_CHAR_W = 6.2;
	/** The same for the 12px semibold tooltip. */
	const TIP_CHAR_W = 7;
	/** Least space between two neighbouring bar labels. */
	const LABEL_GAP = 8;

	/** Drawn at the rendered pixel width so text stays the same size at any width. */
	let W = $state(600);
	const PAD = { top: 22, right: 8, bottom: 26 };
	/** Without a given top, the largest value rounded up to even, so the middle tick is a whole number. */
	const top = $derived(max ?? Math.max(2, Math.ceil(Math.max(...bars.map((b) => b.value)) / 2) * 2));
	const ticks = $derived([0, 0.5, 1].map((f) => f * top));
	/** Room for the widest tick label, so it never runs off the left edge. */
	const left = $derived(Math.max(24, Math.ceil(Math.max(...ticks.map((t) => format(t).length)) * CHAR_W) + 14));
	const plotH = $derived(height - PAD.top - PAD.bottom);
	const step = $derived((W - left - PAD.right) / Math.max(1, bars.length));
	const barW = $derived(Math.max(4, Math.min(48, step - 6)));
	/** Label every nth bar: the smallest n at which no two labels shown side by side overlap. */
	const showEvery = $derived.by(() => {
		const widths = bars.map((b) => b.label.length * LABEL_CHAR_W);
		const fits = (k: number) => {
			for (let i = 0; i + k < widths.length; i += k) if ((widths[i] + widths[i + k]) / 2 + LABEL_GAP > k * step) return false;
			return true;
		};
		let k = 1;
		while (k < bars.length && !fits(k)) k++;
		return k;
	});
	/** A label centred on `cx`, moved in just enough to stay inside the chart. */
	const within = (cx: number, width: number) => Math.max(width / 2, Math.min(cx, W - width / 2));

	let hover = $state<number | null>(null);

	const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
</script>

<figure class="chart" bind:clientWidth={() => W, (w) => (W = Math.max(240, w || 600))}>
	<svg viewBox="0 0 {W} {height}" role="img" aria-label={label} onpointerleave={() => (hover = null)}>
		{#each ticks as t (t)}
			<line class="grid" x1={left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
			<text class="axis" x={left - 8} y={y(t)} dy="0.32em" text-anchor="end">{format(t)}</text>
		{/each}
		{#each bars as bar, i (bar.label)}
			{@const cx = left + step * i + step / 2}
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
					<text class="axis" x={within(cx, bar.label.length * LABEL_CHAR_W)} y={height - 8} text-anchor="middle">{bar.label}</text>
				{/if}
			</g>
		{/each}
		<line class="base" x1={left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
		{#if hover !== null}
			{@const bar = bars[hover]}
			{@const cx = left + step * hover + step / 2}
			{@const tip = bar.tip ?? format(bar.value)}
			<text class="tip" x={within(cx, tip.length * TIP_CHAR_W)} y={Math.max(14, y(bar.value) - 8)} text-anchor="middle"
				>{tip}</text
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
