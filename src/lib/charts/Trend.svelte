<script lang="ts">
	interface TrendPoint {
		value: number;
		tip: string;
	}

	interface Props {
		points: TrendPoint[];
		max: number;
		label: string;
		height?: number;
	}

	let { points, max, label, height = 160 }: Props = $props();

	/** Rough widths of an 11px axis character and a 12px semibold tooltip character. */
	const CHAR_W = 7;
	const TIP_CHAR_W = 7;

	/** Drawn at the rendered pixel width so text stays the same size at any width. */
	let W = $state(600);
	/** The left pad fits the widest tick label. */
	const PAD = $derived({ top: 16, right: 12, bottom: 12, left: Math.max(24, Math.ceil(String(Math.round(max)).length * CHAR_W) + 14) });
	const plotH = $derived(height - PAD.top - PAD.bottom);
	const x = (i: number) =>
		PAD.left + (points.length < 2 ? (W - PAD.left - PAD.right) / 2 : (i * (W - PAD.left - PAD.right)) / (points.length - 1));
	const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
	const path = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' '));

	let hover = $state<number | null>(null);

	function onmove(e: PointerEvent) {
		const svg = e.currentTarget as SVGSVGElement;
		const box = svg.getBoundingClientRect();
		const px = ((e.clientX - box.left) / box.width) * W;
		let best = 0;
		for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
		hover = points.length ? best : null;
	}
</script>

<figure class="chart" bind:clientWidth={() => W, (w) => (W = Math.max(240, w || 600))}>
	<svg viewBox="0 0 {W} {height}" role="img" aria-label={label} onpointermove={onmove} onpointerleave={() => (hover = null)}>
		{#each [0, 0.5, 1] as f (f)}
			<line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(f * max)} y2={y(f * max)} />
			<text class="axis" x={PAD.left - 8} y={y(f * max)} dy="0.32em" text-anchor="end">{Math.round(f * max)}</text>
		{/each}
		{#if hover !== null}
			<line class="cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
		{/if}
		<path class="line" d={path} />
		{#each points as p, i (i)}
			<circle class="dot" cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3} />
		{/each}
		{#if hover !== null}
			{@const half = (points[hover].tip.length * TIP_CHAR_W) / 2}
			<text class="tip" x={Math.max(half, Math.min(x(hover), W - half))} y={PAD.top - 2} text-anchor="middle"
				>{points[hover].tip}</text
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
		touch-action: pan-y;
	}

	.grid {
		stroke: var(--hairline);
	}

	.axis {
		fill: var(--text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.cross {
		stroke: rgb(255 255 255 / 0.3);
	}

	.line {
		fill: none;
		stroke: var(--series-1);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}

	.dot {
		fill: var(--series-1);
		stroke: var(--bg);
		stroke-width: 2;
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
