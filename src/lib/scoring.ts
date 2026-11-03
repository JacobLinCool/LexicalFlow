export const RESPONSE_WINDOW_MS = 5000;
export const FULL_MARKS_MS = 1000;

/**
 * S(t) = 100 when correct and t ≤ 1, 25(5 − t) when correct and 1 < t < 5, else 0.
 * Rounded to whole points so totals stay integer.
 */
export function score(correct: boolean, ms: number): number {
	if (!correct || ms >= RESPONSE_WINDOW_MS) return 0;
	if (ms <= FULL_MARKS_MS) return 100;
	return Math.round(25 * (5 - ms / 1000));
}
