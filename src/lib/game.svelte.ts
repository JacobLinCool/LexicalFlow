import { Deck } from './deck';
import { MAX_HP, MODES, hpDelta } from './modes';
import type { Mode } from './modes';
import {
	averageMs,
	loadProgress,
	loadSettings,
	record,
	recordBest,
	recordRun,
	saveProgress,
	saveSettings
} from './progress';
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
	/** A card (mode menu or run results) is current and waits for a direction. */
	| 'card'
	/** Mid-run, waiting for a key before the next question starts. */
	| 'idle'
	/** Scrolling the next line into place; input ignored, clock not running. */
	| 'entering'
	/** Clock running; the first direction pressed is final. */
	| 'active'
	/** Selection highlight before the verdict (or before a card option acts). */
	| 'locked'
	/** Verdict flash before scrolling on. */
	| 'feedback';

export interface Option {
	label: string;
	detail?: string;
}

/** A non-question line in the stream: the mode menu or a run's results. */
export interface Card {
	title: string;
	/** Current word bank, shown on the menu card. */
	bank?: string;
	subtitle?: string;
	options: Partial<Record<Direction, Option>>;
	act: (direction: Direction) => void;
}

export interface Line {
	key: number;
	question?: Question;
	card?: Card;
	result: Result | null;
}

export interface Summary {
	attempted: number;
	correct: number;
	accuracy: number | null;
	averageMs: number | null;
	totalScore: number;
}

export interface Run {
	count: number;
	correct: number;
	score: number;
	answered: number;
	answerMs: number;
	hp: number;
	/** Last HP change, keyed so the same value twice still re-animates. */
	delta: { value: number; key: number } | null;
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

function emptyRun(): Run {
	return { count: 0, correct: 0, score: 0, answered: 0, answerMs: 0, hp: MAX_HP, delta: null };
}

const points = (n: number) => n.toLocaleString('en-US');

export class Game {
	phase = $state<Phase>('loading');
	lines = $state<Line[]>([]);
	current = $state(0);
	picked = $state<Direction | null>(null);
	sound = $state(false);
	summary = $state<Summary>(summarize(loadProgress()));
	mode = $state<Mode | null>(null);
	/** What is being played, e.g. "Travel · Easy", shown on the menu. */
	bankLabel = $state('');
	#bankId = 'all';
	run = $state<Run>(emptyRun());

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

	load(questions: Question[], bank: { id: string; label: string }): void {
		this.bankLabel = bank.label;
		this.#bankId = bank.id;
		this.#deck = new Deck(questions, this.#progress.recent);
		this.lines = [{ key: this.#nextKey++, card: this.#menuCard(), result: null }];
		this.current = 0;
		this.#fill();
		this.phase = 'card';
	}

	fail(): void {
		this.phase = 'error';
	}

	/**
	 * A direction from the keyboard or a tap. `at` is the input event's timestamp, on the
	 * performance.now() clock.
	 */
	press(direction: Direction, at = performance.now()): void {
		if (this.phase === 'active') return this.#answer(direction, at);
		if (this.phase === 'idle') return this.#resume();
		if (this.phase === 'card') return this.#choose(direction);
	}

	/** Abandon the current run (not recorded as a result) and return to the mode menu. */
	quit(): void {
		if (!this.mode || this.phase === 'locked' || this.phase === 'feedback') return;
		clearTimeout(this.#timer);
		this.#showMenu();
	}

	toggleSound(): void {
		this.sound = !this.sound;
		if (this.sound) sounds.prime();
		saveSettings({ ...loadSettings(), sound: this.sound });
	}

	/** Persist now, e.g. when the page is being hidden. */
	flush(): void {
		saveProgress(this.#progress);
	}

	destroy(): void {
		clearTimeout(this.#timer);
	}

	#menuCard(): Card {
		const s = this.summary;
		const options: Card['options'] = {};
		for (const mode of MODES) {
			const best = this.#progress.bests[mode.id];
			options[mode.direction] = {
				label: mode.label,
				detail: best ? `${mode.detail} · best ${points(best.score)}` : mode.detail
			};
		}
		const count = `${points(this.#deck?.size ?? 0)} questions`;
		return {
			title: 'Choose your flow.',
			bank: `${this.bankLabel} · ${count}`,
			subtitle: s.attempted
				? `${points(s.attempted)} answered · ${Math.round((s.accuracy ?? 0) * 100)}% correct · ${((s.averageMs ?? 0) / 1000).toFixed(2)}s average`
				: 'Pick the missing word before the line runs out.',
			options,
			act: (direction) => {
				const mode = MODES.find((m) => m.direction === direction);
				if (mode) this.#start(mode);
			}
		};
	}

	#resultsCard(mode: Mode, newBest: boolean): Card {
		const run = this.run;
		const avg = run.answered ? `${(run.answerMs / run.answered / 1000).toFixed(2)}s average` : '';
		const best = this.#progress.bests[mode.id];
		const tally = mode.hp
			? `Survived ${run.count} ${run.count === 1 ? 'question' : 'questions'}, ${run.correct} correct`
			: `${run.correct} of ${run.count} correct`;
		return {
			title: `${points(run.score)} points.`,
			subtitle: [
				tally,
				avg,
				newBest ? 'New best' : best ? `best ${points(best.score)}` : ''
			]
				.filter(Boolean)
				.join(' · '),
			options: {
				up: { label: 'Play again', detail: mode.label },
				down: { label: 'Change mode' }
			},
			act: (direction) => {
				if (direction === 'up') this.#start(mode);
				else if (direction === 'down') this.#showMenu();
			}
		};
	}

	#choose(direction: Direction): void {
		const card = this.line?.card;
		if (!card?.options[direction]) return;
		if (this.sound) sounds.prime();
		this.picked = direction;
		this.phase = 'locked';
		this.#timer = setTimeout(() => card.act(direction), TIMING.select);
	}

	#start(mode: Mode): void {
		this.mode = mode;
		this.run = emptyRun();
		this.#timeoutStreak = 0;
		this.#next();
	}

	#showMenu(): void {
		this.mode = null;
		this.#insertCard(this.#menuCard());
	}

	/** Put a card right after the current line and scroll to it. */
	#insertCard(card: Card): void {
		this.lines.splice(this.current + 1, 0, { key: this.#nextKey++, card, result: null });
		this.current++;
		this.#fill();
		this.#enter('card');
	}

	#resume(): void {
		if (this.sound) sounds.prime();
		this.#timeoutStreak = 0;
		this.#enter('active');
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

	/** Scroll the current line into place, then hand over to `then`. */
	#enter(then: 'active' | 'card'): void {
		this.phase = 'entering';
		this.picked = null;
		this.#timer = setTimeout(() => {
			if (then === 'card') {
				this.phase = 'card';
				return;
			}
			this.phase = 'active';
			this.#activatedAt = performance.now();
			this.#timer = setTimeout(() => this.#resolve(null, RESPONSE_WINDOW_MS), RESPONSE_WINDOW_MS);
		}, TIMING.scroll);
	}

	#answer(direction: Direction, at: number): void {
		clearTimeout(this.#timer);
		const ms = Math.max(0, at - this.#activatedAt);
		if (ms >= RESPONSE_WINDOW_MS) return this.#resolve(null, RESPONSE_WINDOW_MS);
		this.picked = direction;
		this.phase = 'locked';
		this.#timer = setTimeout(() => this.#resolve(direction, ms), TIMING.select);
	}

	#resolve(picked: Direction | null, ms: number): void {
		const line = this.line;
		const question = line?.question;
		if (!line || !question) return;
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
		this.summary = summarize(this.#progress);

		const run = this.run;
		if (this.mode?.hp) {
			const value = hpDelta(result, run.count);
			run.hp = Math.max(0, Math.min(MAX_HP, run.hp + value));
			run.delta = { value, key: run.count };
		}
		run.count++;
		run.score += result.score;
		if (result.outcome === 'correct') run.correct++;
		if (result.outcome !== 'timeout') {
			run.answered++;
			run.answerMs += ms;
		}
		this.#timeoutStreak = result.outcome === 'timeout' ? this.#timeoutStreak + 1 : 0;

		const mode = this.mode;
		const over = !!mode && ((mode.limit !== null && run.count >= mode.limit) || (mode.hp && run.hp <= 0));
		let newBest = false;
		if (over && mode) {
			recordRun(this.#progress, {
				mode: mode.id,
				bank: this.#bankId,
				score: run.score,
				count: run.count,
				correct: run.correct,
				answered: run.answered,
				answerMs: Math.round(run.answerMs),
				at: Date.now()
			});
			newBest = recordBest(this.#progress, mode.id, {
				score: run.score,
				correct: run.correct,
				count: run.count,
				at: Date.now()
			});
		}
		saveProgress(this.#progress);

		if (this.sound) sounds[result.outcome]();
		const hold = result.outcome === 'correct' ? TIMING.correct : TIMING.incorrect;
		this.#timer = setTimeout(() => {
			if (over && mode) this.#insertCard(this.#resultsCard(mode, newBest));
			else this.#next();
		}, hold);
	}

	/** Move on to the next question, or park on it if nobody seems to be playing. */
	#next(): void {
		this.current++;
		this.#fill();
		const away =
			this.#timeoutStreak >= AWAY_AFTER ||
			(typeof document !== 'undefined' && document.visibilityState === 'hidden');
		if (away) {
			this.picked = null;
			this.phase = 'idle';
		} else {
			this.#enter('active');
		}
	}
}
