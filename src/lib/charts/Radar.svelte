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

	const S = 320;
	const C = S / 2;
	const R = 112;
	const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
	const point = (i: number, v: number) => [C + Math.cos(angle(i)) * (R * v) / 100, C + Math.sin(angle(i)) * (R * v) / 100];
	const ring = (v: number) => axes.map((_, i) => point(i, v).join(',')).join(' ');

	let hover = $state<number | null>(null);
</script>

<figure class="radar">
	<ul class="legend">
		{#each series as s (s.name)}
			<li><span class="swatch" style:background={s.color}></span>{s.name}</li>
		{/each}
	</ul>
	<svg viewBox="0 0 {S} {S}" role="img" aria-label={label} onpointerleave={() => (hover = null)}>
		{#each [25, 50, 75, 100] as v (v)}
			<polygon class="ring" points={ring(v)} />
		{/each}
		{#each axes as axis, i (axis)}
			{@const [x, y] = point(i, 100)}
			{@const [lx, ly] = point(i, 122)}
			<line class="spoke" x1={C} y1={C} x2={x} y2={y} />
			<text
				class="axis"
				class:active={hover === i}
				x={lx}
				y={ly}
				dy="0.32em"
				text-anchor={Math.abs(lx - C) < 4 ? 'middle' : lx > C ? 'start' : 'end'}>{axis}</text
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
					<text x={C} y={C - 8 + k * 18} text-anchor="middle"
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
		width: 100%;
		max-width: 360px;
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
