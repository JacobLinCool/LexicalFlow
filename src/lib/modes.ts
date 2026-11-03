import type { Direction, Result } from './types';

export type ModeId = 'quick' | 'standard' | 'survival' | 'practice';

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

export const MODES: Mode[] = [
	{ id: 'quick', label: 'Quick', detail: '30 questions', direction: 'up', limit: 30, hp: false },
	{ id: 'standard', label: 'Standard', detail: '100 questions', direction: 'left', limit: 100, hp: false },
	{ id: 'survival', label: 'Survival', detail: 'Endless, with HP', direction: 'right', limit: null, hp: true },
	{ id: 'practice', label: 'Practice', detail: 'Endless, no stakes', direction: 'down', limit: null, hp: false }
];

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
