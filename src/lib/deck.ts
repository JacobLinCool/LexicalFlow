import type { Question } from './types';

/** How many recent questions (by id) and words (by lemma) must not reappear. */
const RECENT_IDS = 200;
const RECENT_LEMMAS = 30;

function shuffle<T>(items: T[], random: () => number): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}

/**
 * An endless shuffled stream. Each pass is a fresh permutation; a draw is skipped
 * forward when its id or word was seen too recently, so neither repeats back-to-back,
 * including across reshuffles and page reloads (via `recent`).
 */
export class Deck {
	#questions: Question[];
	#order: number[] = [];
	#cursor = 0;
	#random: () => number;
	recent: string[];

	constructor(questions: Question[], recent: string[] = [], random = Math.random) {
		if (questions.length === 0) throw new Error('Deck needs at least one question');
		this.#questions = questions;
		this.#random = random;
		this.recent = recent.slice(-RECENT_IDS);
	}

	next(): Question {
		const n = this.#questions.length;
		const idWindow = Math.min(RECENT_IDS, Math.floor(n / 2));
		const lemmaWindow = Math.min(RECENT_LEMMAS, Math.floor(n / 4));
		const recentIds = new Set(this.recent.slice(-idWindow));
		const recentLemmas = new Set(
			this.recent
				.slice(-lemmaWindow)
				.map((id) => this.#byId(id)?.lemma)
				.filter(Boolean)
		);

		for (let attempt = 0; ; attempt++) {
			if (this.#cursor >= this.#order.length) {
				this.#order = shuffle([...Array(n).keys()], this.#random);
				this.#cursor = 0;
			}
			// Look ahead for an acceptable question and swap it into place. If nothing
			// nearby qualifies (tiny banks), the second attempt accepts the next one.
			const limit = Math.min(this.#order.length, this.#cursor + 64);
			for (let i = this.#cursor; i < limit; i++) {
				const q = this.#questions[this.#order[i]];
				const fresh = !recentIds.has(q.id) && !recentLemmas.has(q.lemma);
				if (fresh || attempt > 0) {
					[this.#order[this.#cursor], this.#order[i]] = [this.#order[i], this.#order[this.#cursor]];
					return this.#take();
				}
			}
		}
	}

	#take(): Question {
		const q = this.#questions[this.#order[this.#cursor++]];
		this.recent.push(q.id);
		if (this.recent.length > RECENT_IDS) this.recent.splice(0, this.recent.length - RECENT_IDS);
		return q;
	}

	#index: Map<string, Question> | undefined;
	#byId(id: string): Question | undefined {
		this.#index ??= new Map(this.#questions.map((q) => [q.id, q]));
		return this.#index.get(id);
	}
}
