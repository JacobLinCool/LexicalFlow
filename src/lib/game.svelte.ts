import { Deck } from './deck';
import { averageMs, loadProgress, loadSettings, record, saveProgress, saveSettings } from './progress';
import type { Progress } from './progress';
import { RESPONSE_WINDOW_MS, score } from './scoring';
import { sounds } from './sound';
import type { Direction, Question, Result } from './types';

/** Animation timings (ms); none of them count against the response window. */
export const TIMING = {
	select: 80,
	correct: 120,
	incorrect: 150,
	scroll: 320
} as const;

/** Sentences kept ready below the current one. */
const LOOKAHEAD = 5;
/** Lines kept above the current one before old history is dropped. */
const HISTORY = 12;
/** Consecutive timeouts after which the stream waits for the player. */
const AWAY_AFTER = 3;

export type Phase =
	| 'loading'
	| 'error'
	/** Waiting for a key before the first (or next) question starts. */
	| 'idle'
	/** Scrolling the next question into place; input ignored, clock not running. */
	| 'entering'
	/** Clock running; the first direction pressed is final. */
	| 'active'
	/** Selection highlight before the verdict. */
	| 'locked'
	/** Verdict flash before scrolling on. */
	| 'feedback';

export interface Line {
	key: number;
	question: Question;
	result: Result | null;
}

export interface Summary {
	attempted: number;
	correct: number;
	accuracy: number | null;
	averageMs: number | null;
	totalScore: number;
}

function summarize(p: Progress): Summary {
	return {
		attempted: p.attempted,
		correct: p.correct,
		accuracy: p.attempted ? p.correct / p.attempted : null,
		averageMs: averageMs(p),
		totalScore: p.totalScore
	};
}

export class Game {
	phase = $state<Phase>('loading');
	lines = $state<Line[]>([]);
	current = $state(0);
	picked = $state<Direction | null>(null);
	sound = $state(false);
	summary = $state<Summary>(summarize(loadProgress()));
	session = $state({ count: 0, score: 0 });

	#deck: Deck | null = null;
	#progress: Progress = loadProgress();
	#nextKey = 0;
	#activatedAt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#timeoutStreak = 0;

	constructor() {
		this.sound = loadSettings().sound;
	}

	get line(): Line | undefined {
		return this.lines[this.current];
	}

	load(questions: Question[]): void {
		this.#deck = new Deck(questions, this.#progress.recent);
		this.lines = [];
		this.current = 0;
		this.#fill();
		this.phase = 'idle';
	}

	fail(): void {
		this.phase = 'error';
	}

	/** Leave the idle state; the clock starts once the choices have settled in. */
	begin(): void {
		if (this.phase !== 'idle') return;
		if (this.sound) sounds.prime();
		this.#timeoutStreak = 0;
		this.#enter();
	}

	/** `at` is the input event's timestamp, on the performance.now() clock. */
	answer(direction: Direction, at = performance.now()): void {
		if (this.phase !== 'active') return;
		clearTimeout(this.#timer);
		const ms = Math.max(0, at - this.#activatedAt);
		if (ms >= RESPONSE_WINDOW_MS) return this.#resolve(null, RESPONSE_WINDOW_MS);
		this.picked = direction;
		this.phase = 'locked';
		this.#timer = setTimeout(() => this.#resolve(direction, ms), TIMING.select);
	}

	toggleSound(): void {
		this.sound = !this.sound;
		if (this.sound) sounds.prime();
		saveSettings({ sound: this.sound });
	}

	/** Persist now, e.g. when the page is being hidden. */
	flush(): void {
		saveProgress(this.#progress);
	}

	destroy(): void {
		clearTimeout(this.#timer);
	}

	#fill(): void {
		if (!this.#deck) return;
		while (this.lines.length <= this.current + LOOKAHEAD) {
			this.lines.push({ key: this.#nextKey++, question: this.#deck.next(), result: null });
		}
		const excess = this.current - HISTORY;
		if (excess > 0) {
			this.lines.splice(0, excess);
			this.current -= excess;
		}
	}

	#enter(): void {
		this.phase = 'entering';
		this.picked = null;
		this.#timer = setTimeout(() => this.#activate(), TIMING.scroll);
	}

	#activate(): void {
		this.phase = 'active';
		this.#activatedAt = performance.now();
		this.#timer = setTimeout(() => this.#resolve(null, RESPONSE_WINDOW_MS), RESPONSE_WINDOW_MS);
	}

	#resolve(picked: Direction | null, ms: number): void {
		const line = this.line;
		if (!line) return;
		const { question } = line;
		const correct = picked === question.answer;
		const result: Result = {
			outcome: picked === null ? 'timeout' : correct ? 'correct' : 'incorrect',
			picked,
			ms,
			score: score(correct, ms)
		};
		line.result = result;
		this.picked = picked;
		this.phase = 'feedback';

		record(this.#progress, question, result);
		this.#progress.recent = this.#deck?.recent ?? [];
		saveProgress(this.#progress);
		this.summary = summarize(this.#progress);
		this.session.count++;
		this.session.score += result.score;
		this.#timeoutStreak = result.outcome === 'timeout' ? this.#timeoutStreak + 1 : 0;

		if (this.sound) sounds[result.outcome]();
		const hold = result.outcome === 'correct' ? TIMING.correct : TIMING.incorrect;
		this.#timer = setTimeout(() => this.#advance(), hold);
	}

	#advance(): void {
		this.current++;
		this.#fill();
		const away =
			this.#timeoutStreak >= AWAY_AFTER ||
			(typeof document !== 'undefined' && document.visibilityState === 'hidden');
		if (away) {
			// Nobody is playing: park on the next sentence instead of burning through the deck.
			this.picked = null;
			this.phase = 'idle';
		} else {
			this.#enter();
		}
	}
}
