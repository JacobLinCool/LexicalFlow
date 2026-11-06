import { describe, expect, it } from 'vitest';
import { emptyProgress, addXp, withXp, dayKey } from './progress';
import type { Result } from './types';
import { XP, answerXp, levelOf, streakDays, xpForLevel } from './xp';

const result = (outcome: Result['outcome'], score = 0, ms = 1500): Result => ({
	picked: null,
	outcome,
	ms,
	score
});

describe('answerXp', () => {
	it('pays Learn and the level test by outcome', () => {
		for (const mode of ['learn', 'placement'] as const) {
			expect(answerXp(mode, result('correct', 0))).toBe(XP.learnCorrect);
			expect(answerXp(mode, result('incorrect'))).toBe(XP.learnMiss);
			expect(answerXp(mode, result('timeout'))).toBe(0);
		}
	});
	it('pays scored modes a tenth of the points, at least one for a right answer', () => {
		expect(answerXp('quick', result('correct', 100))).toBe(10);
		expect(answerXp('survival', result('correct', 54))).toBe(5);
		expect(answerXp('standard', result('correct', 2))).toBe(1);
		expect(answerXp('quick', result('incorrect'))).toBe(0);
		expect(answerXp('quick', result('timeout'))).toBe(0);
	});
	it('pays nothing in the demo', () => {
		expect(answerXp('demo', result('correct', 100))).toBe(0);
	});
});

describe('levelOf', () => {
	it('starts at level 1 and needs 100·L XP from level L to the next', () => {
		expect(levelOf(0)).toEqual({ level: 1, into: 0, span: 100 });
		expect(levelOf(99)).toEqual({ level: 1, into: 99, span: 100 });
		expect(levelOf(100)).toEqual({ level: 2, into: 0, span: 200 });
		expect(levelOf(299)).toEqual({ level: 2, into: 199, span: 200 });
		expect(levelOf(300)).toEqual({ level: 3, into: 0, span: 300 });
	});
	it('agrees with xpForLevel at every boundary', () => {
		for (let level = 1; level <= 200; level++) {
			expect(levelOf(xpForLevel(level)).level).toBe(level);
			expect(levelOf(xpForLevel(level) - 1).level).toBe(Math.max(1, level - 1));
		}
	});
	it('paces a month of daily study to about level 30', () => {
		// About 160 Learn answers a day at 85% plus the day's bonus.
		const perDay = Math.round(160 * (0.85 * XP.learnCorrect + 0.15 * XP.learnMiss)) + XP.dayDone;
		expect(levelOf(perDay).level).toBeGreaterThanOrEqual(4);
		expect(levelOf(perDay * 30).level).toBeGreaterThanOrEqual(27);
		expect(levelOf(perDay * 30).level).toBeLessThanOrEqual(33);
	});
	it('treats negative or fractional totals sensibly', () => {
		expect(levelOf(-5).level).toBe(1);
		expect(levelOf(100.7)).toEqual({ level: 2, into: 0, span: 200 });
	});
});

describe('streakDays', () => {
	const days = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, [1, 1, 0, 0, 0]]));
	const at = (s: string) => new Date(`${s}T12:00:00`);
	it('counts back from today', () => {
		expect(streakDays(days('2026-11-04', '2026-11-05', '2026-11-06'), at('2026-11-06'), dayKey)).toBe(3);
	});
	it('stays alive from yesterday until today is played', () => {
		expect(streakDays(days('2026-11-04', '2026-11-05'), at('2026-11-06'), dayKey)).toBe(2);
	});
	it('breaks on a missed day', () => {
		expect(streakDays(days('2026-11-03', '2026-11-05', '2026-11-06'), at('2026-11-06'), dayKey)).toBe(2);
		expect(streakDays(days('2026-11-03'), at('2026-11-06'), dayKey)).toBe(0);
	});
	it('crosses month ends', () => {
		expect(streakDays(days('2026-10-31', '2026-11-01'), at('2026-11-01'), dayKey)).toBe(2);
	});
});

describe('progress experience', () => {
	it('adds to the total and to the day', () => {
		const p = emptyProgress();
		const now = new Date('2026-11-06T09:00:00');
		addXp(p, 10, now);
		addXp(p, 5, now);
		addXp(p, 0, now);
		expect(p.xp).toBe(15);
		expect(p.xpDays[dayKey(now)]).toBe(15);
	});
	it('starts an older save from a tenth of its points', () => {
		const stored = { totalScore: 12_345 };
		expect(withXp({ ...emptyProgress(), ...stored }, stored).xp).toBe(1235);
		const current = { totalScore: 12_345, xp: 40 };
		expect(withXp({ ...emptyProgress(), ...current }, current).xp).toBe(40);
		expect(withXp(emptyProgress(), null).xp).toBe(0);
	});
});
