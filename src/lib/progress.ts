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
}

export interface Settings {
	sound: boolean;
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
		recent: []
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
	return { sound: false, ...read<Settings>(SETTINGS_KEY) };
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
	return progress;
}

export function averageMs(progress: Progress): number | null {
	const answered = progress.correct + progress.incorrect;
	return answered ? progress.answerMs / answered : null;
}
