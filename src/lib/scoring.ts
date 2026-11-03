export const RESPONSE_WINDOW_MS = 10_000;
export const FULL_MARKS_MS = 1000;

/**
 * S(t) = 100 when correct and t ≤ 1, decaying linearly to 0 at the end of the window
 * (100(10 − t)/9 for a 10 s window), else 0.
 * Rounded to whole points so totals stay integer.
 */
export function score(correct: boolean, ms: number): number {
	if (!correct || ms >= RESPONSE_WINDOW_MS) return 0;
	if (ms <= FULL_MARKS_MS) return 100;
	return Math.round((100 * (RESPONSE_WINDOW_MS - ms)) / (RESPONSE_WINDOW_MS - FULL_MARKS_MS));
}
