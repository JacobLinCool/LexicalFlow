export const DIRECTIONS = ['up', 'left', 'down', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const CATEGORIES = ['travel', 'conversation', 'networking', 'academic'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Question {
	id: string;
	sentence: string;
	choices: Record<Direction, string>;
	answer: Direction;
	category: Category;
	difficulty: number;
	lemma: string;
}

export interface Manifest {
	version: string;
	questionCount: number;
	vocabularyCount: number;
	categories: Record<Category, { file: string; count: number }>;
}

export type Outcome = 'correct' | 'incorrect' | 'timeout';

export interface Result {
	outcome: Outcome;
	/** Direction the player picked; null on timeout. */
	picked: Direction | null;
	/** Response time in milliseconds; the full window on timeout. */
	ms: number;
	score: number;
}
