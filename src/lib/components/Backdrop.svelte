<script lang="ts">
	import type { Category } from '#lib/types.ts';

	let { category }: { category: Category | undefined } = $props();
</script>

<!-- Slow-drifting, blurred colour fields; the palette eases toward the current category. -->
<div class="backdrop" data-category={category ?? 'none'} aria-hidden="true">
	<div class="field a"></div>
	<div class="field b"></div>
	<div class="field c"></div>
	<div class="veil"></div>
</div>

<style>
	@property --c1 {
		syntax: '<color>';
		inherits: true;
		initial-value: #2f3b55;
	}
	@property --c2 {
		syntax: '<color>';
		inherits: true;
		initial-value: #4a3b5c;
	}
	@property --c3 {
		syntax: '<color>';
		inherits: true;
		initial-value: #2e4f55;
	}

	.backdrop {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: var(--bg);
		transition:
			--c1 2.4s ease,
			--c2 2.4s ease,
			--c3 2.4s ease;
	}

	.backdrop[data-category='travel'] {
		--c1: #24566a;
		--c2: #3b4f86;
		--c3: #4f6f5d;
	}
	.backdrop[data-category='conversation'] {
		--c1: #74493f;
		--c2: #6a3f5e;
		--c3: #85663f;
	}
	.backdrop[data-category='networking'] {
		--c1: #3f4380;
		--c2: #5e3f80;
		--c3: #2f5a7c;
	}
	.backdrop[data-category='academic'] {
		--c1: #34564f;
		--c2: #4a5a34;
		--c3: #2c4560;
	}

	.field {
		position: absolute;
		width: 75vmax;
		height: 75vmax;
		border-radius: 50%;
		filter: blur(70px);
		opacity: 0.85;
		will-change: transform;
	}

	.a {
		background: radial-gradient(circle, var(--c1) 0%, transparent 68%);
		top: -25vmax;
		left: -15vmax;
		animation: drift-a 38s ease-in-out infinite alternate;
	}
	.b {
		background: radial-gradient(circle, var(--c2) 0%, transparent 68%);
		bottom: -30vmax;
		right: -20vmax;
		animation: drift-b 46s ease-in-out infinite alternate;
	}
	.c {
		background: radial-gradient(circle, var(--c3) 0%, transparent 68%);
		top: 20vh;
		left: 35vw;
		width: 55vmax;
		height: 55vmax;
		animation: drift-c 54s ease-in-out infinite alternate;
	}

	.veil {
		position: absolute;
		inset: 0;
		background: radial-gradient(ellipse at 30% 35%, transparent 0%, var(--vignette) 100%);
	}

	@keyframes drift-a {
		to {
			transform: translate(18vw, 12vh) scale(1.15);
		}
	}
	@keyframes drift-b {
		to {
			transform: translate(-22vw, -10vh) scale(0.9);
		}
	}
	@keyframes drift-c {
		to {
			transform: translate(-25vw, 15vh) scale(1.2);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.field {
			animation: none;
		}
	}
</style>
