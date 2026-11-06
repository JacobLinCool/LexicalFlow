import { asset } from '$app/paths';
import type { AssetPath } from '$app/types';
import {
	CATEGORIES,
	DIRECTIONS,
	type BandFile,
	type BankManifest,
	type Lexicon,
	type PartOfSpeech,
	type Question,
	type WordInfo
} from './types';

function url(path: string): string {
	return asset(`/data/${path}` as AssetPath);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url(path), init);
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** Expand a compact band file into questions and its words with their global ranks. */
export function decodeBand(file: BandFile, bandSize: number): { questions: Question[]; words: WordInfo[] } {
	const band = file.band;
	const words = file.words.map(([word, pos, zipf, ipa, en, zh, senses], i): WordInfo => {
		const info: WordInfo = { word, pos, zipf, rank: (band - 1) * bandSize + i + 1, band, ipa, en, zh };
		if (senses?.length) info.senses = senses.map(([p, senseEn, senseZh]) => ({ pos: p, en: senseEn, zh: senseZh }));
		return info;
	});
	const questions = file.questions.map(
		([id, sentence, up, left, down, right, answer, category, difficulty, word, sense]): Question => {
			const info = words[word];
			if (info === undefined) throw new Error(`band ${band}, question ${id}: no word ${word}`);
			const question: Question = {
				id,
				sentence,
				choices: { up, left, down, right },
				answer: DIRECTIONS[answer],
				category: CATEGORIES[category],
				difficulty,
				lemma: info.word
			};
			if (sense !== undefined) {
				const own = info.senses?.[sense];
				if (!own) throw new Error(`band ${band}, question ${id}: no sense ${sense} of ${info.word}`);
				question.sense = sense;
				if (own.pos !== info.pos) question.pos = own.pos;
			}
			return question;
		}
	);
	return { questions, words };
}

export interface Bank {
	questions: Question[];
	lexicon: Lexicon;
	manifest: BankManifest;
}

/** Load every band of the bundled bank: all questions plus the word list with ranks and glosses. */
export async function loadBank(): Promise<Bank> {
	// The manifest is revalidated; band files are versioned by it and safe to cache forever.
	const manifest = await json<BankManifest>('manifest.json', { cache: 'no-cache' });
	const format = (manifest as { format?: unknown }).format ?? 1;
	if (format !== 2) throw new Error(`manifest.json: unsupported bank format ${String(format)}, expected 2`);
	const v = encodeURIComponent(manifest.version);
	const bands = await Promise.all(
		manifest.bands.map(async ({ file }) => decodeBand(await json<BandFile>(`${file}?v=${v}`), manifest.bandSize))
	);

	const words = new Map<string, WordInfo>();
	for (const band of bands) {
		for (const w of band.words) {
			// A lemma in two bands keeps its more frequent (lower) rank.
			const seen = words.get(w.word);
			if (!seen || w.rank < seen.rank) words.set(w.word, w);
		}
	}
	const byRank = [...words.values()].sort((a, b) => a.rank - b.rank);
	const lexicon: Lexicon = {
		words,
		byRank,
		bandSize: manifest.bandSize,
		bands: manifest.bands.reduce((n, b) => Math.max(n, b.band), 0)
	};
	return { questions: bands.flatMap((b) => b.questions), lexicon, manifest };
}

/**
 * A word as glossed in one question: the sense its sentence uses. A bare part of speech, from a
 * caller that knows only the blank's, picks that part of speech's first sense.
 */
export function senseFor(info: WordInfo, question: Pick<Question, 'pos' | 'sense'> | PartOfSpeech | undefined): WordInfo {
	const { pos, sense: index } = typeof question === 'string' ? { pos: question, sense: undefined } : (question ?? {});
	const sense =
		index !== undefined
			? info.senses?.[index]
			: pos && pos !== info.pos
				? info.senses?.find((s) => s.pos === pos)
				: undefined;
	return sense ? { ...info, ...sense } : info;
}
