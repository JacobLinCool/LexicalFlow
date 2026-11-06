import { describe, expect, it } from 'vitest';
import {
	AGAIN_DELAY_SEC,
	DEFAULT_THRESHOLDS,
	EASY_MS,
	HARD_MS,
	MAX_INTERVAL_DAYS,
	S_MIN,
	W,
	calendarDays,
	dayStart,
	forgetting,
	gradeOf,
	intervalDays,
	isMastered,
	newCard,
	packCard,
	retrievability,
	review,
	unpackCard,
	type Grade
} from './srs';
import type { Result } from './types';

const DAY = 86_400;
/** 10:00 local time, so reviews a few hours either way stay on the same calendar day. */
const T0 = new Date(2026, 4, 29, 10).getTime() / 1000;

const correct = (ms: number): Result => ({ outcome: 'correct', picked: 'up', ms, score: 0 });

describe('gradeOf', () => {
	it('grades a correct answer by response time', () => {
		expect(gradeOf(correct(0))).toBe(4);
		expect(gradeOf(correct(EASY_MS))).toBe(4);
		expect(gradeOf(correct(EASY_MS + 1))).toBe(3);
		expect(gradeOf(correct(HARD_MS))).toBe(3);
		expect(gradeOf(correct(HARD_MS + 1))).toBe(2);
		expect(gradeOf(correct(9999))).toBe(2);
	});
	it('treats a miss or a timeout as Again, however fast', () => {
		expect(gradeOf({ outcome: 'incorrect', picked: 'left', ms: 300, score: 0 })).toBe(1);
		expect(gradeOf({ outcome: 'timeout', picked: null, ms: 10_000, score: 0 })).toBe(1);
	});
	it("uses a learner's own thresholds when given", () => {
		const own = { easy: 1300, hard: 3600 };
		expect(gradeOf(correct(1300), own)).toBe(4);
		expect(gradeOf(correct(1500), own)).toBe(3);
		expect(gradeOf(correct(1500))).toBe(4);
		expect(gradeOf(correct(4000), own)).toBe(2);
		expect(gradeOf(correct(4000))).toBe(3);
		expect(DEFAULT_THRESHOLDS).toEqual({ easy: EASY_MS, hard: HARD_MS });
		expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
	});
});

describe('FSRS-5', () => {
	it('starts a new card at S0 = w[G−1] and D0 = w4 − e^(w5(G−1)) + 1', () => {
		const expected: [Grade, number, number][] = [
			[1, 0.40255, 7.1949],
			[2, 1.18385, 6.488305],
			[3, 3.173, 5.282434],
			[4, 15.69105, 3.224502]
		];
		for (const [grade, s, d] of expected) {
			const card = newCard(grade, T0);
			expect(card.s).toBe(s);
			expect(card.s).toBe(W[grade - 1]);
			expect(card.d).toBeCloseTo(d, 5);
			expect(card).toMatchObject({ last: T0, first: T0, firstGrade: grade, reps: 1, lapses: 0 });
		}
	});

	it('defines stability as the 90% point: R(S, S) = 0.9', () => {
		for (const s of [0.4, 1, 3.173, 15.7, 100]) expect(forgetting(s, s)).toBeCloseTo(0.9, 10);
		expect(forgetting(0, 5)).toBe(1);
		expect(forgetting(3, 3.173)).toBeCloseTo(0.904698, 6);
	});

	it('schedules the next review S days out, within [1, 365], from the start of that day', () => {
		expect(intervalDays(3.173)).toBe(3);
		expect(intervalDays(15.69105)).toBe(16);
		expect(intervalDays(0.4)).toBe(1);
		expect(intervalDays(5000)).toBe(MAX_INTERVAL_DAYS);
		expect(newCard(3, T0).due).toBe(new Date(2026, 5, 1).getTime() / 1000);
		expect(newCard(4, T0).due).toBe(dayStart(T0, 16));
		// A miss comes back after the again-delay, whatever the day.
		expect(newCard(1, T0).due).toBe(T0 + AGAIN_DELAY_SEC);
	});

	it('serves a card all day long on its due day, whatever the hour it was answered', () => {
		// Answered late one evening or early the next morning: due the same day either way, so a
		// card answered late in a long session does not slip past the next evening's session.
		const late = new Date(2026, 4, 29, 23, 30).getTime() / 1000;
		const early = new Date(2026, 4, 30, 0, 30).getTime() / 1000;
		expect(newCard(3, late).due).toBe(new Date(2026, 5, 1).getTime() / 1000);
		expect(newCard(3, early).due).toBe(new Date(2026, 5, 2).getTime() / 1000);
		expect(calendarDays(late, early)).toBe(1);
		expect(calendarDays(early, late)).toBe(-1);
		expect(calendarDays(T0, T0 + 13 * 3600)).toBe(0);
	});

	it('counts calendar days across a clock change', () => {
		// Whatever the time zone, a calendar date range spans as many days as it says.
		const start = new Date(2026, 0, 1, 12).getTime() / 1000;
		for (let d = 0; d <= 366; d += 61) {
			const day = dayStart(start, d);
			expect(new Date(day * 1000).getHours()).toBe(0);
			expect(calendarDays(start, day + 3600)).toBe(d);
		}
	});

	it('raises stability on a recall: Good after 3 days', () => {
		const card = review(newCard(3, T0), 3, T0 + 3 * DAY);
		expect(card.s).toBeCloseTo(10.738926, 5);
		expect(card.d).toBeCloseTo(5.272968, 5);
		expect(card).toMatchObject({ reps: 2, lapses: 0, last: T0 + 3 * DAY, due: dayStart(T0, 14) });
	});

	it('weights Hard and Easy recalls by w15 and w16', () => {
		expect(review(newCard(3, T0), 2, T0 + 3 * DAY).s).toBeCloseTo(4.924512, 5);
		expect(review(newCard(3, T0), 2, T0 + 3 * DAY).d).toBeCloseTo(6.03495, 5);
		expect(review(newCard(4, T0), 4, T0 + 16 * DAY).s).toBeCloseTo(150.283561, 4);
	});

	it('lowers stability on a lapse and counts it', () => {
		const card = review(newCard(3, T0), 1, T0 + 3 * DAY);
		expect(card.s).toBeCloseTo(1.055561, 5);
		expect(card.s).toBeLessThan(3.173);
		expect(card.d).toBeCloseTo(6.796933, 5);
		expect(card).toMatchObject({ lapses: 1, reps: 2, due: T0 + 3 * DAY + AGAIN_DELAY_SEC });
	});

	it('caps a lapse at S / e^(w17·w18), as FSRS-5 does', () => {
		// Long overdue (R ≈ 0.25): the post-lapse formula gives about 12.2 days, above the cap.
		const easy = newCard(4, T0);
		const elapsed = 1000;
		const r = forgetting(elapsed, easy.s);
		const postLapse =
			W[11] * Math.pow(easy.d, -W[12]) * (Math.pow(easy.s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
		const cap = easy.s / Math.exp(W[17] * W[18]);
		expect(postLapse).toBeGreaterThan(cap);
		expect(postLapse).toBeLessThan(easy.s);
		const lapsed = review(easy, 1, T0 + elapsed * DAY);
		expect(lapsed.s).toBeCloseTo(cap, 8);
		expect(lapsed.s).toBeCloseTo(11.146023, 5);
	});

	it('never lets stability fall below its floor', () => {
		let card = newCard(1, T0);
		for (let i = 1; i <= 12; i++) card = review(card, 1, T0 + i * 60);
		expect(card.s).toBe(S_MIN);
		expect(card.lapses).toBe(12);
	});

	it('uses the short-term formula on the same day: S·e^(w17(G − 3 + w18))', () => {
		const start = newCard(3, T0);
		expect(review(start, 3, T0 + 600).s).toBeCloseTo(4.466858, 5);
		expect(review(start, 1, T0 + 600).s).toBeCloseTo(1.589764, 5);
		// 23:59 the same evening is still the same day.
		expect(review(start, 4, dayStart(T0, 1) - 60).s).toBeCloseTo(3.173 * Math.exp(W[17] * (1 + W[18])), 8);
	});

	it('takes a review on the next day as a long-term one, however few hours have passed', () => {
		// A 1-day card answered 22 hours later is a next-day review: R at one day, not the
		// short-term update, which would barely grow its stability.
		const evening = new Date(2026, 4, 29, 21).getTime() / 1000;
		const card = { ...newCard(2, evening), s: 1 };
		const next = review(card, 3, evening + 22 * 3600);
		const sameDay = review(card, 3, evening + 2 * 3600);
		expect(next.s).toBeCloseTo(review(card, 3, evening + DAY).s, 10);
		expect(next.s).toBeGreaterThan(sameDay.s);
		expect(sameDay.s).toBeCloseTo(Math.exp(W[17] * W[18]), 8);
	});

	it('follows ts-fsrs v4 through a mixed run of reviews', () => {
		// Reference values from ts-fsrs 4.7.1 (enable_short_term), starting from a Good first answer.
		const run: [elapsedSec: number, grade: Grade, s: number, d: number, interval: number][] = [
			[600, 1, 1.58976351, 6.79693258, 2],
			[2 * DAY, 2, 2.49333931, 7.29785961, 2],
			[10 * DAY, 4, 41.18861449, 6.8426718, 41],
			[40 * DAY, 1, 3.97183959, 7.84597304, 4],
			[3 * DAY, 3, 8.11541623, 7.82471427, 8]
		];
		let card = newCard(3, T0);
		let t = T0;
		for (const [elapsed, grade, s, d, interval] of run) {
			t += elapsed;
			card = review(card, grade, t);
			expect(card.s).toBeCloseTo(s, 5);
			expect(card.d).toBeCloseTo(d, 6);
			expect(intervalDays(card.s)).toBe(interval);
			expect(card.due).toBe(grade === 1 ? t + AGAIN_DELAY_SEC : dayStart(t, interval));
		}
		expect(card).toMatchObject({ reps: 6, lapses: 2, last: t, first: T0, firstGrade: 3 });
	});

	it('keeps difficulty within [1, 10]', () => {
		let card = newCard(1, T0);
		for (let i = 1; i <= 30; i++) card = review(card, 1, T0 + i * DAY);
		expect(card.d).toBeLessThanOrEqual(10);
		card = newCard(4, T0);
		for (let i = 1; i <= 30; i++) card = review(card, 4, T0 + i * 400 * DAY);
		expect(card.d).toBeGreaterThanOrEqual(1);
	});

	it('reads retrievability from the last review', () => {
		const card = newCard(3, T0);
		expect(retrievability(card, T0)).toBe(1);
		expect(retrievability(card, T0 + 3.173 * DAY)).toBeCloseTo(0.9, 10);
		expect(retrievability(card, T0 - DAY)).toBe(1);
	});

	it('calls a card mastered from 21 days of stability', () => {
		expect(isMastered({ ...newCard(3, T0), s: 20.99 })).toBe(false);
		expect(isMastered({ ...newCard(3, T0), s: 21 })).toBe(true);
	});
});

describe('packCard', () => {
	it('round-trips through the stored tuple', () => {
		const card = review(review(newCard(2, T0), 1, T0 + 2 * DAY), 3, T0 + 2 * DAY + 900);
		const tuple = packCard(card);
		expect(tuple).toHaveLength(8);
		expect(JSON.parse(JSON.stringify(tuple))).toEqual(tuple);
		const back = unpackCard(tuple);
		expect(back).toMatchObject({
			last: card.last,
			due: card.due,
			reps: 3,
			lapses: 1,
			first: T0,
			firstGrade: 2
		});
		expect(back.s).toBeCloseTo(card.s, 4);
		expect(back.d).toBeCloseTo(card.d, 4);
		expect(packCard(back)).toEqual(tuple);
	});
});
