import { CUSTOM_PREFIX, saveCustomBank, type CustomBank } from './banks';
import { DIRECTIONS, type Category, type Direction, type Question } from './types';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS = 50_000;

export interface ParsedBank {
	name: string | null;
	kind: 'questions' | 'words';
	questions: Question[];
	words: string[];
	/** Rows that were skipped, with the reason (first few only). */
	skipped: number;
	problems: string[];
}

export class ImportError extends Error {}

/** Turn page URLs of common hosts into their raw-file equivalents. */
export function normalizeUrl(input: string): string {
	const url = new URL(input.trim());
	// github.com/<owner>/<repo>/blob/<ref>/<path> → raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
	const blob = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
	if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
	// A Google Sheet link → its CSV export (the sheet must be shared or published).
	const sheet = url.hostname === 'docs.google.com' && url.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
	if (sheet && !url.pathname.includes('/export') && !url.pathname.includes('/pub')) {
		const gid = url.hash.match(/gid=(\d+)/)?.[1] ?? url.searchParams.get('gid') ?? '0';
		return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`;
	}
	return url.toString();
}

export async function fetchBankText(input: string): Promise<{ text: string; url: string }> {
	let url: string;
	try {
		url = normalizeUrl(input);
	} catch {
		throw new ImportError('That does not look like a URL.');
	}
	let res: Response;
	try {
		res = await fetch(url, { cache: 'no-cache' });
	} catch {
		throw new ImportError(
			'The file could not be fetched. The server must allow cross-origin requests (CORS); raw GitHub files, Gists and published Google Sheets do.'
		);
	}
	if (!res.ok) throw new ImportError(`The server answered ${res.status} ${res.statusText}.`);
	const text = await res.text();
	if (text.length > MAX_BYTES) throw new ImportError('The file is larger than 10 MB.');
	return { text, url };
}

// ---- Parsing ----

export function parseBank(text: string, hint = ''): ParsedBank {
	const trimmed = text.replace(/^﻿/, '').trim();
	if (!trimmed) throw new ImportError('The file is empty.');
	if (trimmed.length > MAX_BYTES) throw new ImportError('The file is larger than 10 MB.');
	const looksJson = /\.json$/i.test(hint) || trimmed.startsWith('[') || trimmed.startsWith('{');
	if (looksJson) {
		let data: unknown;
		try {
			data = JSON.parse(trimmed);
		} catch {
			throw new ImportError('The file looks like JSON but could not be parsed.');
		}
		return fromJson(data);
	}
	return fromTable(parseDelimited(trimmed));
}

function fromJson(data: unknown): ParsedBank {
	let name: string | null = null;
	let items: unknown = data;
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const obj = data as Record<string, unknown>;
		name = typeof obj.name === 'string' ? obj.name : null;
		items = obj.questions ?? obj.words;
	}
	if (!Array.isArray(items)) {
		throw new ImportError('Expected an array, or an object with a "questions" or "words" array.');
	}
	if (items.every((x) => typeof x === 'string')) return { name, ...wordsOnly(items as string[]) };
	const out = new Builder();
	items.slice(0, MAX_ITEMS).forEach((item, i) => out.add(i + 1, () => questionFromObject(item)));
	return { name, ...out.result() };
}

function fromTable(rows: string[][]): ParsedBank {
	const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
	if (!header.includes('sentence')) {
		const col = Math.max(0, header.indexOf('word'));
		const body = header.includes('word') ? rows.slice(1) : rows;
		return { name: null, ...wordsOnly(body.map((r) => r[col] ?? '')) };
	}
	const out = new Builder();
	rows.slice(1, MAX_ITEMS + 1).forEach((row, i) => {
		const rec: Record<string, string> = {};
		header.forEach((h, j) => (rec[h] = (row[j] ?? '').trim()));
		if (Object.values(rec).every((v) => !v)) return;
		out.add(i + 2, () => {
			const distractors = [1, 2, 3]
				.map((n) => rec[`distractor${n}`] ?? rec[`wrong${n}`] ?? rec[`d${n}`])
				.filter((v): v is string => !!v);
			const listed = rec.distractors?.split(/[|;]/).map((s) => s.trim()) ?? [];
			return questionFromObject({
				sentence: rec.sentence,
				answer: rec.answer,
				distractors: distractors.length ? distractors : listed,
				choices: DIRECTIONS.every((d) => rec[d]) ? Object.fromEntries(DIRECTIONS.map((d) => [d, rec[d]])) : undefined,
				category: rec.category || undefined,
				difficulty: rec.difficulty ? Number(rec.difficulty) : undefined
			});
		});
	});
	return { name: null, ...out.result() };
}

function wordsOnly(raw: string[]): Omit<ParsedBank, 'name'> {
	const seen = new Set<string>();
	let skipped = 0;
	for (const entry of raw) {
		const word = entry.trim().toLowerCase();
		if (!word) continue;
		if (/^[a-z][a-z' -]*$/.test(word) && word.length <= 40) seen.add(word);
		else skipped++;
	}
	if (!seen.size) throw new ImportError('No words found. Put one word per line or in a "word" column.');
	return {
		kind: 'words',
		questions: [],
		words: [...seen].slice(0, MAX_ITEMS),
		skipped,
		problems: skipped ? [`${skipped} entries are not plain English words.`] : []
	};
}

class Builder {
	questions: Question[] = [];
	skipped = 0;
	problems: string[] = [];

	add(row: number, make: () => Question) {
		try {
			this.questions.push(make());
		} catch (error) {
			this.skipped++;
			if (this.problems.length < 5) this.problems.push(`Row ${row}: ${(error as Error).message}`);
		}
	}

	result(): Omit<ParsedBank, 'name'> {
		if (!this.questions.length) {
			throw new ImportError(
				`No usable questions. ${this.problems[0] ?? 'Check the format described below.'}`
			);
		}
		return { kind: 'questions', questions: this.questions, words: [], skipped: this.skipped, problems: this.problems };
	}
}

function shuffled<T>(items: T[]): T[] {
	const a = [...items];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** Accepts the app's own format as well as the simpler answer + distractors shape. */
function questionFromObject(input: unknown): Question {
	if (!input || typeof input !== 'object') throw new Error('not an object');
	const o = input as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
	let sentence = str(o.sentence);
	if (!sentence) throw new Error('missing sentence');

	let choices: Record<Direction, string>;
	let answer: Direction;
	if (o.choices && typeof o.choices === 'object' && !Array.isArray(o.choices)) {
		const c = o.choices as Record<string, unknown>;
		choices = Object.fromEntries(DIRECTIONS.map((d) => [d, str(c[d])])) as Record<Direction, string>;
		const a = str(o.answer);
		const byWord = DIRECTIONS.find((d) => choices[d].toLowerCase() === a.toLowerCase());
		answer = (DIRECTIONS as readonly string[]).includes(a) ? (a as Direction) : (byWord as Direction);
	} else {
		let correct: string;
		let wrong: string[];
		if (Array.isArray(o.choices)) {
			const list = o.choices.map(str);
			const idx = typeof o.answer === 'number' ? o.answer : list.findIndex((w) => w.toLowerCase() === str(o.answer).toLowerCase());
			if (idx < 0 || idx >= list.length) throw new Error('answer is not one of the choices');
			correct = list[idx];
			wrong = list.filter((_, i) => i !== idx);
		} else {
			correct = str(o.answer);
			wrong = Array.isArray(o.distractors) ? o.distractors.map(str) : [];
		}
		if (wrong.length !== 3) throw new Error('needs exactly three distractors');
		const dirs = shuffled([...DIRECTIONS]);
		answer = dirs[0];
		choices = { up: '', left: '', down: '', right: '' };
		choices[dirs[0]] = correct;
		wrong.forEach((w, i) => (choices[dirs[i + 1]] = w));
	}
	if (!answer) throw new Error('answer must be a direction or one of the choices');
	const words = DIRECTIONS.map((d) => choices[d]);
	if (words.some((w) => !w)) throw new Error('a choice is empty');
	if (new Set(words.map((w) => w.toLowerCase())).size !== 4) throw new Error('choices must be different');

	// The blank: two or more underscores; failing that, the answer word itself, once.
	sentence = sentence.replace(/_{2,}/g, '___');
	if (!sentence.includes('___')) {
		const word = choices[answer].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`\\b${word}\\b`, 'gi');
		if ((sentence.match(re) ?? []).length !== 1) throw new Error('sentence needs one blank (___)');
		sentence = sentence.replace(re, '___');
	}
	if (sentence.split('___').length !== 2) throw new Error('sentence has more than one blank');

	const difficulty = Number(o.difficulty);
	return {
		id: '',
		sentence,
		choices,
		answer,
		category: (str(o.category).toLowerCase() || 'custom') as Category,
		difficulty: difficulty >= 1 && difficulty <= 5 ? Math.round(difficulty) : 3,
		lemma: str(o.lemma).toLowerCase() || choices[answer].toLowerCase()
	};
}

/** Minimal RFC 4180 reader; the delimiter is a tab or comma, whichever the first line uses. */
export function parseDelimited(text: string): string[][] {
	const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
	const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : firstLine.includes(';') ? ';' : ',';
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"' && field === '') quoted = true;
		else if (ch === delim) {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += ch;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((f) => f.trim()));
}

// ---- Building the stored bank ----

export function newBankId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function toCustomBank(
	parsed: ParsedBank,
	source: CustomBank['source'],
	fallbackName: string,
	id = newBankId()
): CustomBank {
	const now = Date.now();
	return {
		id,
		name: parsed.name?.trim() || fallbackName,
		kind: parsed.kind,
		source,
		questions: parsed.questions.map((q, i) => ({ ...q, id: `${CUSTOM_PREFIX}${id}:${i}` })),
		words: parsed.words,
		createdAt: now,
		updatedAt: now
	};
}

export function nameFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
		return last.replace(/\.(csv|tsv|json|txt)$/i, '') || u.hostname;
	} catch {
		return 'Imported bank';
	}
}

/**
 * Fetch, parse and store a bank from a URL. Re-importing a URL already in `existing`
 * refreshes that bank in place, so shared links do not pile up duplicates.
 */
export async function importUrl(
	input: string,
	existing: CustomBank[]
): Promise<{ bank: CustomBank; parsed: ParsedBank }> {
	const { text, url } = await fetchBankText(input);
	const parsed = parseBank(text, url);
	const prior = existing.find((b) => b.source.type === 'url' && b.source.url === url);
	const bank = toCustomBank(parsed, { type: 'url', url }, nameFromUrl(url), prior?.id);
	if (prior) bank.createdAt = prior.createdAt;
	await saveCustomBank(bank);
	return { bank, parsed };
}
