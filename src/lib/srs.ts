import type { Result } from './types';

/**
 * FSRS-5 memory model, one card per word. Grades come from a multiple-choice answer:
 * a miss or timeout is Again; a correct answer is Easy, Good or Hard by response time,
 * which stands in for recall fluency.
 *
 * Reviews are scheduled by local calendar day, as in Anki and ts-fsrs: a card falls due at the
 * start of its day, so every card due today is there whatever hour the learner sits down, and a
 * card answered late one evening does not slip past the next evening's session.
 */
export type Grade = 1 | 2 | 3 | 4;

/**
 * Default response-time cut-offs, in milliseconds from the choices appearing: correct within
 * EASY_MS → Easy; within HARD_MS → Good; slower → Hard. Learners with enough history get their
 * own (see gradeThresholds in learner.ts).
 */
export const EASY_MS = 1800;
export const HARD_MS = 5000;

export interface GradeThresholds {
	/** A correct answer at most this fast is Easy. */
	easy: number;
	/** A correct answer slower than this is Hard. */
	hard: number;
}

export const DEFAULT_THRESHOLDS: Readonly<GradeThresholds> = Object.freeze({ easy: EASY_MS, hard: HARD_MS });
/** A word counts as mastered once its stability reaches this many days. */
export const MASTERED_DAYS = 21;
export const DESIRED_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 365;
/** A forgotten word is due again this soon; the session engine brings it back sooner still. */
export const AGAIN_DELAY_SEC = 10 * 60;

/** FSRS-5 default weights. */
export const W = [
	0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11,
	0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621
] as const;
export const DECAY = -0.5;
/** Chosen so that R(S, S) = 0.9: stability is the interval at 90% retention. */
export const FACTOR = 19 / 81;

const DAY = 86_400;
/** Stability floor and ceiling, in days. */
export const S_MIN = 0.01;
const S_MAX = 36_500;

export function gradeOf(result: Result, thresholds: Readonly<GradeThresholds> = DEFAULT_THRESHOLDS): Grade {
	if (result.outcome !== 'correct') return 1;
	if (result.ms <= thresholds.easy) return 4;
	if (result.ms <= thresholds.hard) return 3;
	return 2;
}

/** Stability and due dates in days and epoch seconds. */
export interface Card {
	/** Stability: days until recall probability falls to 90%. */
	s: number;
	/** Difficulty, 1..10. */
	d: number;
	/** Last review, epoch seconds. */
	last: number;
	/** Next due time, epoch seconds: local midnight starting the due day, or the end of the again-delay after a miss. */
	due: number;
	reps: number;
	lapses: number;
	/** First seen, epoch seconds. */
	first: number;
	firstGrade: Grade;
}

/** Persisted card: [s, d, last, due, reps, lapses, first, firstGrade]. */
export type CardTuple = [number, number, number, number, number, number, number, number];

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function packCard(c: Card): CardTuple {
	return [round4(c.s), round4(c.d), c.last, c.due, c.reps, c.lapses, c.first, c.firstGrade];
}

export function unpackCard(t: CardTuple): Card {
	const [s, d, last, due, reps, lapses, first, firstGrade] = t;
	return { s, d, last, due, reps, lapses, first, firstGrade: firstGrade as Grade };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Recall probability after `days` days at stability `s`. */
export function forgetting(days: number, s: number): number {
	return Math.pow(1 + (FACTOR * days) / s, DECAY);
}

/** Epoch seconds of the local midnight starting the calendar day `days` days after the one holding `sec`. */
export function dayStart(sec: number, days = 0): number {
	const date = new Date(sec * 1000);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime() / 1000;
}

/** Local calendar days from the day holding `from` to the day holding `to` (epoch seconds). */
export function calendarDays(from: number, to: number): number {
	// Rounded: a day is 23 or 25 hours long when the clocks change.
	return Math.round((dayStart(to) - dayStart(from)) / DAY);
}

export function retrievability(card: Card, nowSec: number): number {
	return forgetting(Math.max(0, nowSec - card.last) / DAY, card.s);
}

export function isMastered(card: Card): boolean {
	return card.s >= MASTERED_DAYS;
}

function initialDifficulty(grade: Grade): number {
	return W[4] - Math.exp(W[5] * (grade - 1)) + 1;
}

function nextDifficulty(d: number, grade: Grade): number {
	const damped = d + (-W[6] * (grade - 3) * (10 - d)) / 9;
	// Mean reversion towards the difficulty of an Easy first answer.
	return clamp(W[7] * initialDifficulty(4) + (1 - W[7]) * damped, 1, 10);
}

/** Whole days until recall falls to DESIRED_RETENTION, within [1, MAX_INTERVAL_DAYS]. */
export function intervalDays(s: number): number {
	const days = (s * (Math.pow(DESIRED_RETENTION, 1 / DECAY) - 1)) / FACTOR;
	return clamp(Math.round(days), 1, MAX_INTERVAL_DAYS);
}

/** A miss comes back after the again-delay; anything else at the start of the day its interval ends. */
function dueAt(s: number, grade: Grade, nowSec: number): number {
	return grade === 1 ? nowSec + AGAIN_DELAY_SEC : dayStart(nowSec, intervalDays(s));
}

export function newCard(grade: Grade, nowSec: number): Card {
	const s = W[grade - 1];
	return {
		s,
		d: clamp(initialDifficulty(grade), 1, 10),
		last: nowSec,
		due: dueAt(s, grade, nowSec),
		reps: 1,
		lapses: 0,
		first: nowSec,
		firstGrade: grade
	};
}

/**
 * The card after one more review; pure. A review on the same local day as the last one takes
 * FSRS-5's short-term update. From the next day on the long-term formulas apply, with the time
 * elapsed counted in calendar days as ts-fsrs does, so a card due today is judged alike whatever
 * the hour: a 1-day card answered 22 hours later is a next-day review, not a same-day one.
 */
export function review(card: Card, grade: Grade, nowSec: number): Card {
	const days = calendarDays(card.last, nowSec);
	let s: number;
	if (days < 1) {
		s = card.s * Math.exp(W[17] * (grade - 3 + W[18]));
	} else {
		const r = forgetting(days, card.s);
		if (grade === 1) {
			const forgot =
				W[11] *
				Math.pow(card.d, -W[12]) *
				(Math.pow(card.s + 1, W[13]) - 1) *
				Math.exp(W[14] * (1 - r));
			// FSRS-5 caps a lapse at S / e^(w17·w18), below the stability the card had.
			s = Math.min(forgot, card.s / Math.exp(W[17] * W[18]));
		} else {
			const hard = grade === 2 ? W[15] : 1;
			const easy = grade === 4 ? W[16] : 1;
			s =
				card.s *
				(1 +
					Math.exp(W[8]) *
						(11 - card.d) *
						Math.pow(card.s, -W[9]) *
						(Math.exp(W[10] * (1 - r)) - 1) *
						hard *
						easy);
		}
	}
	s = clamp(s, S_MIN, S_MAX);
	return {
		...card,
		s,
		d: nextDifficulty(card.d, grade),
		last: nowSec,
		due: dueAt(s, grade, nowSec),
		reps: card.reps + 1,
		lapses: card.lapses + (grade === 1 ? 1 : 0)
	};
}
