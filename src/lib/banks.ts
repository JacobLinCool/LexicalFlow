import { loadBank, type Bank } from './data';
import { frontierBand, loadLearner } from './learner';
import { CATEGORIES, type Category, type Question } from './types';

export type LevelId = 'easy' | 'medium' | 'hard' | 'all' | 'mine';

export interface Level {
	id: LevelId;
	label: string;
	detail: string;
	/** Inclusive difficulty range; a question's difficulty is its rarest choice's band. */
	min: number;
	max: number;
	/** Select by the answer word's frequency band around the learner's frontier instead (see myBands). */
	frontier?: boolean;
}

export const LEVELS: Level[] = [
	{ id: 'easy', label: 'Easy', detail: 'Everyday words only', min: 1, max: 2 },
	{ id: 'medium', label: 'Medium', detail: 'Common to intermediate', min: 1, max: 3 },
	{ id: 'hard', label: 'Hard', detail: 'Less common words', min: 3, max: 5 },
	{ id: 'all', label: 'All', detail: 'Every level', min: 1, max: 5 },
	{ id: 'mine', label: 'My level', detail: 'Around where your new words come from', min: 1, max: 5, frontier: true }
];

export function level(id: string): Level {
	return LEVELS.find((l) => l.id === id) ?? LEVELS[1];
}

/** 'My level' plays these frequency bands relative to the learner's frontier band. */
const MINE_BELOW = 2;
const MINE_ABOVE = 1;

/** Inclusive range of frequency bands. */
export interface BandRange {
	from: number;
	to: number;
}

/**
 * The bands 'My level' plays: two below the learner's frontier to one above, within the bank.
 * Null before the level test, when 'My level' falls back to Medium.
 */
export async function myBands(): Promise<BandRange | null> {
	const state = loadLearner();
	if (!state.placement) return null;
	const { lexicon } = await builtinBank();
	const frontier = frontierBand(state, lexicon);
	return { from: Math.max(1, frontier - MINE_BELOW), to: Math.min(lexicon.bands, frontier + MINE_ABOVE) };
}

/** Built-in questions whose answer word lies in `range` (by the bank's frequency bands). */
export async function inBands(questions: Question[], range: BandRange): Promise<Question[]> {
	const { lexicon } = await builtinBank();
	return questions.filter((q) => {
		const band = lexicon.words.get(q.lemma)?.band;
		return band !== undefined && band >= range.from && band <= range.to;
	});
}

export interface BuiltinBank {
	id: 'all' | Category;
	label: string;
}

export const BUILTIN_BANKS: BuiltinBank[] = [
	{ id: 'all', label: 'All topics' },
	{ id: 'conversation', label: 'Conversation' },
	{ id: 'travel', label: 'Travel' },
	{ id: 'networking', label: 'Networking' },
	{ id: 'academic', label: 'Academic' }
];

/**
 * A bank the player imported. A `questions` bank carries its own sentences; a `words`
 * bank is a word list that selects matching questions from the built-in bank.
 */
export interface CustomBank {
	id: string;
	name: string;
	kind: 'questions' | 'words';
	/** Where it came from; URL banks can be refreshed and shared. */
	source: { type: 'url'; url: string } | { type: 'file'; name: string } | { type: 'paste' };
	questions: Question[];
	words: string[];
	createdAt: number;
	updatedAt: number;
}

export const CUSTOM_PREFIX = 'custom:';

// ---- IndexedDB (custom banks can be several MB, beyond comfortable localStorage use) ----

const DB_NAME = 'lexical-flow';
const STORE = 'banks';

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open();
	try {
		return await new Promise<T>((resolve, reject) => {
			const req = run(db.transaction(STORE, mode).objectStore(STORE));
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	} finally {
		db.close();
	}
}

export async function listCustomBanks(): Promise<CustomBank[]> {
	try {
		const banks = await tx<CustomBank[]>('readonly', (s) => s.getAll());
		return banks.sort((a, b) => b.updatedAt - a.updatedAt);
	} catch {
		return [];
	}
}

export function getCustomBank(id: string): Promise<CustomBank | undefined> {
	return tx<CustomBank | undefined>('readonly', (s) => s.get(id));
}

export async function saveCustomBank(bank: CustomBank): Promise<void> {
	// Svelte state proxies cannot be structured-cloned; store a plain copy.
	await tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(bank))));
}

export async function deleteCustomBank(id: string): Promise<void> {
	await tx('readwrite', (s) => s.delete(id));
}

// ---- Resolving a selection to playable questions ----

export function inLevel(q: Question, l: Level): boolean {
	return q.difficulty >= l.min && q.difficulty <= l.max;
}

/** Built-in questions whose answer is one of `words` (by lemma or exact surface form). */
export function matchWords(questions: Question[], words: string[]): Question[] {
	const wanted = new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean));
	return questions.filter(
		(q) => wanted.has(q.lemma.toLowerCase()) || wanted.has(q.choices[q.answer].toLowerCase())
	);
}

export interface Playable {
	questions: Question[];
	/** Human-readable name of what is being played. */
	name: string;
	/** False when the level filter does not apply (custom question banks). */
	levelled: boolean;
	/** The level actually applied when levelled, which differs from the one asked for after a fallback. */
	level?: LevelId;
}

let builtin: Promise<Bank> | null = null;
/** The bundled bank (questions, word list and manifest), fetched once per page; retried after a failure. */
export function builtinBank(): Promise<Bank> {
	builtin ??= loadBank().catch((error) => {
		builtin = null;
		throw error;
	});
	return builtin;
}

/** Every question of the bundled bank. */
export async function builtinQuestions(): Promise<Question[]> {
	return (await builtinBank()).questions;
}

/**
 * Questions for a bank id and level. Falls back to all built-in questions at that level
 * when a custom bank is missing or yields nothing; 'My level' falls back to Medium before the
 * level test or when no question lies in its bands, and any level to All when it matches
 * nothing. `level` reports the level that was applied.
 */
export async function resolvePlayable(bankId: string, levelId: LevelId): Promise<Playable> {
	let l = level(levelId);
	if (bankId.startsWith(CUSTOM_PREFIX)) {
		const bank = await getCustomBank(bankId.slice(CUSTOM_PREFIX.length)).catch(() => undefined);
		if (bank?.kind === 'questions' && bank.questions.length) {
			return { questions: bank.questions, name: bank.name, levelled: false };
		}
		if (bank?.kind === 'words') {
			const matched = matchWords(await builtinQuestions(), bank.words);
			if (matched.length) return { questions: matched, name: bank.name, levelled: false };
		}
		bankId = 'all';
	}
	const all = await builtinQuestions();
	const topic = (CATEGORIES as readonly string[]).includes(bankId) ? bankId : null;
	const pick = (lv: Level) => all.filter((q) => (!topic || q.category === topic) && inLevel(q, lv));
	const name = BUILTIN_BANKS.find((b) => b.id === (topic ?? 'all'))?.label ?? 'All topics';
	if (l.frontier) {
		const range = await myBands().catch(() => null);
		const questions = range ? await inBands(pick(l), range) : [];
		if (questions.length) return { questions, name, levelled: true, level: l.id };
		l = level('medium');
	}
	const questions = pick(l);
	if (questions.length) return { questions, name, levelled: true, level: l.id };
	return { questions: pick(level('all')), name, levelled: true, level: 'all' };
}
