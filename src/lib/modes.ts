import type { Direction, Result } from './types';

export type ModeId = 'learn' | 'quick' | 'standard' | 'survival' | 'practice' | 'placement' | 'demo';

export interface Mode {
	id: ModeId;
	label: string;
	detail: string;
	/** The direction that picks this mode on the menu. */
	direction: Direction;
	/** Questions per run; null runs until HP is gone (or forever without HP). */
	limit: number | null;
	hp: boolean;
}

/** The daily course: draws from the learner's plan, not a deck, and keeps no score. */
export const LEARN: Mode = {
	id: 'learn',
	label: 'Learn',
	detail: 'Your daily words',
	direction: 'up',
	limit: null,
	hp: false
};

/** The mode menu, one mode per direction. Practice left the menu; old run records may still name it. */
export const MODES: Mode[] = [
	LEARN,
	{ id: 'quick', label: 'Quick', detail: '30 questions', direction: 'left', limit: 30, hp: false },
	{ id: 'survival', label: 'Survival', detail: 'Endless, with HP', direction: 'right', limit: null, hp: true },
	{ id: 'standard', label: 'Standard', detail: '100 questions', direction: 'down', limit: 100, hp: false }
];

/** The level test, reached through Learn or the plan page; a test, so not scored either. */
export const PLACEMENT: Mode = {
	id: 'placement',
	label: 'Level test',
	detail: 'About 3 minutes',
	direction: 'up',
	limit: null,
	hp: false
};

/** Autoplay attract mode: not on the menu, never recorded. */
export const DEMO: Mode = { id: 'demo', label: 'Demo', detail: 'Autoplay', direction: 'down', limit: null, hp: false };

/** How the demo player behaves: answer delay range (ms) and hit rate. */
export const DEMO_PLAYER = { minMs: 700, maxMs: 3000, accuracy: 0.85 };

export const MAX_HP = 100;

/** A miss costs 20 HP, growing by 5 every 25 questions so that every run ends eventually. */
export function damage(answered: number): number {
	return 20 + 5 * Math.floor(answered / 25);
}

/** A correct answer heals by speed: a tenth of its score, so up to 10 HP. */
export function heal(score: number): number {
	return Math.round(score / 10);
}

/** HP change for one result; `answered` counts the questions before this one. */
export function hpDelta(result: Result, answered: number): number {
	return result.outcome === 'correct' ? heal(result.score) : -damage(answered);
}
