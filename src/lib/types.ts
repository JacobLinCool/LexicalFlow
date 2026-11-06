export const DIRECTIONS = ['up', 'left', 'down', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const CATEGORIES = ['travel', 'conversation', 'networking', 'academic'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Question {
	id: string;
	sentence: string;
	choices: Record<Direction, string>;
	answer: Direction;
	category: Category;
	difficulty: number;
	lemma: string;
	/** The blank's part of speech when it differs from the word's main one (built-in bank only). */
	pos?: PartOfSpeech;
	/** The sentence's sense of the word, as an index into its `WordInfo.senses`; absent for the main sense. */
	sense?: number;
}

export type Outcome = 'correct' | 'incorrect' | 'timeout';

export interface Result {
	outcome: Outcome;
	/** Direction the player picked; null on timeout. */
	picked: Direction | null;
	/** Response time in milliseconds; the full window on timeout. */
	ms: number;
	score: number;
}

export type PartOfSpeech = 'n' | 'v' | 'adj' | 'adv';

/** One vocabulary word (lemma) of the built-in bank, with its frequency rank and gloss. */
export interface WordInfo {
	word: string;
	pos: PartOfSpeech;
	zipf: number;
	/** 1 = most frequent word in the bank. */
	rank: number;
	/** 1-based frequency band of `bandSize` words. */
	band: number;
	/** Pronunciation in IPA, without slashes; '' when unknown. */
	ipa: string;
	/** Short English definition; '' when unknown. */
	en: string;
	/** Short Traditional Chinese translation; '' when unknown. */
	zh: string;
	/**
	 * Other senses some of its sentences use: another part of speech ("to steal" beside "a steal")
	 * or another meaning ("a major" in the army, not at university).
	 */
	senses?: Sense[];
}

/** One sense of a word: its part of speech and gloss. */
export interface Sense {
	pos: PartOfSpeech;
	en: string;
	zh: string;
}

export interface Lexicon {
	words: Map<string, WordInfo>;
	/** Words in rank order: byRank[0] has rank 1. */
	byRank: WordInfo[];
	bandSize: number;
	/** Number of bands. */
	bands: number;
}

/** Built-in bank manifest (format 2): questions and words split into frequency bands. */
export interface BankManifest {
	format: 2;
	version: string;
	questionCount: number;
	vocabularyCount: number;
	bandSize: number;
	bands: { band: number; file: string; words: number; questions: number }[];
	categories: Record<Category, number>;
}

/** A band file: [word, pos, zipf, ipa, en, zh] rows and compact question rows. */
export interface BandFile {
	band: number;
	/** Optionally followed by [[pos, en, zh], ...]: the other senses the word's sentences use. */
	words: [string, PartOfSpeech, number, string, string, string, [PartOfSpeech, string, string][]?][];
	/**
	 * [id, sentence, up, left, down, right, answerIndex, categoryIndex, difficulty, wordIndex], then the
	 * index of the word's other sense the sentence uses, if it uses one.
	 */
	questions: [string, string, string, string, string, string, number, number, number, number, number?][];
}
