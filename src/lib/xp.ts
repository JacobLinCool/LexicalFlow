import type { ModeId } from './modes';
import type { Result } from './types';

/**
 * Experience and levels. XP rewards the work that builds vocabulary: Learn and the level test pay
 * the most per answer and a little even for a miss (meeting a word is part of learning it), the
 * scored modes pay by speed as their points do, and a word whose memory reaches three weeks
 * (srs.MASTERED_DAYS) or a finished day's plan pays a bonus.
 */
export const XP = {
	/** A correct answer in Learn or the level test. */
	learnCorrect: 10,
	/** A missed answer in Learn or the level test; a timeout earns nothing. */
	learnMiss: 2,
	/** A word reaching "mastered". */
	mastered: 20,
	/** Today's Learn plan finished, once a day. */
	dayDone: 50
} as const;

/** XP for one answer: Learn and the level test by outcome, scored modes a tenth of the points (at least 1 when correct). */
export function answerXp(mode: ModeId, result: Result): number {
	if (mode === 'demo') return 0;
	if (mode === 'learn' || mode === 'placement') {
		if (result.outcome === 'correct') return XP.learnCorrect;
		return result.outcome === 'incorrect' ? XP.learnMiss : 0;
	}
	return result.outcome === 'correct' ? Math.max(1, Math.round(result.score / 10)) : 0;
}

/** XP needed to reach `level` from zero: 50·L·(L − 1), so level L takes 100·L more than L − 1 did. */
export function xpForLevel(level: number): number {
	return 50 * level * (level - 1);
}

export interface LevelInfo {
	level: number;
	/** XP earned since this level began. */
	into: number;
	/** XP between this level and the next. */
	span: number;
}

/**
 * The level for a total. A day of Learn at about 15 minutes earns some 1,400 XP: level 5 after the
 * first day, about 30 after a month of daily study, about 40 after two.
 */
export function levelOf(xp: number): LevelInfo {
	const total = Math.max(0, Math.floor(xp));
	let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + total / 12.5)) / 2));
	// Guard the square root against rounding at the boundaries.
	while (xpForLevel(level + 1) <= total) level++;
	while (level > 1 && xpForLevel(level) > total) level--;
	return { level, into: total - xpForLevel(level), span: xpForLevel(level + 1) - xpForLevel(level) };
}

/**
 * Consecutive days with at least one answer, counting back from today, or from yesterday when
 * today has none yet (the streak is still alive until today ends). `days` holds local YYYY-MM-DD keys.
 */
export function streakDays(days: Record<string, unknown>, today: Date, key: (d: Date) => string): number {
	const d = new Date(today);
	if (!days[key(d)]) d.setDate(d.getDate() - 1);
	let streak = 0;
	while (days[key(d)]) {
		streak++;
		d.setDate(d.getDate() - 1);
	}
	return streak;
}
