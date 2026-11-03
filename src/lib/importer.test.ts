import { describe, expect, it } from 'vitest';
import { matchWords } from './banks';
import { ImportError, normalizeUrl, parseBank, parseDelimited } from './importer';
import type { Question } from './types';

describe('parseBank', () => {
	it('reads question CSV with answer and three distractors', () => {
		const bank = parseBank(
			'sentence,answer,distractor1,distractor2,distractor3\n"Could you ___ me, please?",help,eat,sleep,run\n'
		);
		expect(bank.kind).toBe('questions');
		const [q] = bank.questions;
		expect(q.sentence).toBe('Could you ___ me, please?');
		expect(q.choices[q.answer]).toBe('help');
		expect(new Set(Object.values(q.choices))).toEqual(new Set(['help', 'eat', 'sleep', 'run']));
		expect(q.lemma).toBe('help');
	});

	it('blanks the answer when the sentence has no underscores, and skips bad rows', () => {
		const bank = parseBank(
			'sentence\tanswer\tdistractors\nWe booked a hotel.\tbooked\tate|ran|sang\nNo blank here.\tmissing\ta|b|c\n'
		);
		expect(bank.questions).toHaveLength(1);
		expect(bank.questions[0].sentence).toBe('We ___ a hotel.');
		expect(bank.skipped).toBe(1);
	});

	it("accepts the game's own JSON shape and the simple shape", () => {
		const bank = parseBank(
			JSON.stringify({
				name: 'Mine',
				questions: [
					{ sentence: 'A ___ b.', choices: { up: 'x', left: 'y', down: 'z', right: 'w' }, answer: 'left', difficulty: 2 },
					{ sentence: 'C ___ d.', answer: 'p', distractors: ['q', 'r', 's'] },
					{ sentence: 'E ___ f.', choices: ['m', 'n', 'o', 'p'], answer: 2 }
				]
			})
		);
		expect(bank.name).toBe('Mine');
		expect(bank.questions.map((q) => q.choices[q.answer])).toEqual(['y', 'p', 'o']);
		expect(bank.questions[0].difficulty).toBe(2);
	});

	it('treats plain lists as word banks', () => {
		expect(parseBank('word\nItinerary\nnegotiate\n\n').words).toEqual(['itinerary', 'negotiate']);
		expect(parseBank('["hypothesis", "data"]').kind).toBe('words');
	});

	it('rejects duplicate choices and empty input', () => {
		expect(() => parseBank('[{"sentence":"A ___.","answer":"x","distractors":["x","y","z"]}]')).toThrow(ImportError);
		expect(() => parseBank('   ')).toThrow(ImportError);
	});
});

describe('parseDelimited', () => {
	it('handles quotes, escaped quotes and CRLF', () => {
		expect(parseDelimited('a,"b, ""c"""\r\nd,e')).toEqual([
			['a', 'b, "c"'],
			['d', 'e']
		]);
	});
});

describe('normalizeUrl', () => {
	it('turns GitHub and Google Sheets page links into raw files', () => {
		expect(normalizeUrl('https://github.com/a/b/blob/main/x/bank.csv')).toBe(
			'https://raw.githubusercontent.com/a/b/main/x/bank.csv'
		);
		expect(normalizeUrl('https://docs.google.com/spreadsheets/d/ID/edit#gid=42')).toBe(
			'https://docs.google.com/spreadsheets/d/ID/export?format=csv&gid=42'
		);
	});
});

describe('matchWords', () => {
	it('matches by lemma or by the surface form in the sentence', () => {
		const q = (lemma: string, word: string) =>
			({ lemma, choices: { up: word, left: '', down: '', right: '' }, answer: 'up' }) as Question;
		const qs = [q('book', 'booked'), q('run', 'ran'), q('city', 'city')];
		expect(matchWords(qs, ['Book', 'ran']).map((x) => x.lemma)).toEqual(['book', 'run']);
	});
});
