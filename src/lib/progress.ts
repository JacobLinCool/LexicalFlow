import type { LevelId } from './banks';
import type { ModeId } from './modes';
import type { Outcome, Question, Result } from './types';

const PROGRESS_KEY = 'lexical-flow:progress:v1';
const SETTINGS_KEY = 'lexical-flow:settings:v1';

/** Per-word tally: [attempts, correct, incorrect, timedOut, totalAnswerMs, lastSeenEpochSeconds]. */
export type WordStats = [number, number, number, number, number, number];

export interface Progress {
	attempted: number;
	correct: number;
	incorrect: number;
	timedOut: number;
	/** Sum of response times for answered (non-timeout) questions. */
	answerMs: number;
	totalScore: number;
	words: Record<string, WordStats>;
	/** Recent question ids, so a reload does not replay what was just seen. */
	recent: string[];
	/** Highest-scoring completed run per mode. */
	bests: Partial<Record<ModeId, Best>>;
	/** Epoch ms of the first recorded answer. */
	since: number | null;
	/** Tallies by question category (custom banks may add their own keys). */
	categories: Record<string, Tally>;
	/** Tallies by difficulty level, keyed "1".."5". */
	levels: Record<string, Tally>;
	/** Tallies by local calendar day, keyed YYYY-MM-DD. */
	days: Record<string, Tally>;
	/** Response-time histogram of answered questions, in half-second bins over 0–5 s. */
	times: number[];
	/** Completed runs, newest last, capped at RUN_HISTORY. */
	runs: RunRecord[];
}

/** [attempts, correct, timedOut, answerMs (answered only), score]. */
export type Tally = [number, number, number, number, number];

export interface RunRecord {
	mode: ModeId;
	bank: string;
	score: number;
	count: number;
	correct: number;
	answered: number;
	answerMs: number;
	at: number;
}

const RUN_HISTORY = 200;
export const TIME_BINS = 10;

export interface Best {
	score: number;
	correct: number;
	count: number;
	/** Epoch milliseconds. */
	at: number;
}

export interface Settings {
	sound: boolean;
	/** Selected bank id: a built-in id ('all' or a category) or 'custom:<id>'. */
	bank: string;
	level: LevelId;
}

export function emptyProgress(): Progress {
	return {
		attempted: 0,
		correct: 0,
		incorrect: 0,
		timedOut: 0,
		answerMs: 0,
		totalScore: 0,
		words: {},
		recent: [],
		bests: {},
		since: null,
		categories: {},
		levels: {},
		days: {},
		times: new Array(TIME_BINS).fill(0),
		runs: []
	};
}

function read<T>(key: string): Partial<T> | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as Partial<T>) : null;
	} catch {
		return null;
	}
}

function write(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage can be full or blocked (private mode); play continues without saving.
	}
}

export function loadProgress(): Progress {
	return { ...emptyProgress(), ...read<Progress>(PROGRESS_KEY) };
}

export function saveProgress(progress: Progress): void {
	write(PROGRESS_KEY, progress);
}

export function loadSettings(): Settings {
	return { sound: false, bank: 'all', level: 'medium', ...read<Settings>(SETTINGS_KEY) };
}

export function saveSettings(settings: Settings): void {
	write(SETTINGS_KEY, settings);
}

const OUTCOME_FIELD: Record<Outcome, 'correct' | 'incorrect' | 'timedOut'> = {
	correct: 'correct',
	incorrect: 'incorrect',
	timeout: 'timedOut'
};

/** Fold one result into the running totals (mutates and returns `progress`). */
export function record(progress: Progress, question: Question, result: Result): Progress {
	progress.attempted++;
	progress[OUTCOME_FIELD[result.outcome]]++;
	if (result.outcome !== 'timeout') progress.answerMs += result.ms;
	progress.totalScore += result.score;

	const w: WordStats = progress.words[question.lemma] ?? [0, 0, 0, 0, 0, 0];
	w[0]++;
	if (result.outcome === 'correct') w[1]++;
	else if (result.outcome === 'incorrect') w[2]++;
	else w[3]++;
	if (result.outcome !== 'timeout') w[4] += Math.round(result.ms);
	w[5] = Math.floor(Date.now() / 1000);
	progress.words[question.lemma] = w;

	const now = new Date();
	progress.since ??= now.getTime();
	tally(progress.categories, question.category, result);
	tally(progress.levels, String(question.difficulty), result);
	tally(progress.days, dayKey(now), result);
	if (result.outcome !== 'timeout') {
		const bin = Math.min(TIME_BINS - 1, Math.floor(result.ms / (5000 / TIME_BINS)));
		progress.times[bin]++;
	}
	return progress;
}

function tally(map: Record<string, Tally>, key: string, result: Result): void {
	const t: Tally = map[key] ?? [0, 0, 0, 0, 0];
	t[0]++;
	if (result.outcome === 'correct') t[1]++;
	if (result.outcome === 'timeout') t[2]++;
	else t[3] += Math.round(result.ms);
	t[4] += result.score;
	map[key] = t;
}

export function dayKey(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function recordRun(progress: Progress, run: RunRecord): void {
	progress.runs.push(run);
	if (progress.runs.length > RUN_HISTORY) progress.runs.splice(0, progress.runs.length - RUN_HISTORY);
}

export function resetProgress(): Progress {
	const fresh = emptyProgress();
	saveProgress(fresh);
	return fresh;
}

export function averageMs(progress: Progress): number | null {
	const answered = progress.correct + progress.incorrect;
	return answered ? progress.answerMs / answered : null;
}

/** Keep `run` if it beats the stored best for `mode`; returns whether it did. */
export function recordBest(progress: Progress, mode: ModeId, run: Best): boolean {
	const best = progress.bests[mode];
	if (run.score <= 0 || (best && best.score >= run.score)) return false;
	progress.bests[mode] = run;
	return true;
}
