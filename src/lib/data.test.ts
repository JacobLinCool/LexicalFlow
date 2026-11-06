import { describe, expect, it } from 'vitest';
import { decodeBand, senseFor } from './data';
import type { BandFile } from './types';

const band: BandFile = {
	band: 3,
	words: [
		['time', 'n', 6.12, 'taɪm', 'an instance or single occasion for some event', '時間；次；時代'],
		['run', 'v', 5.4, '', '', ''],
		['quick', 'adj', 5.1, 'kwɪk', 'fast', '快的']
	],
	questions: [
		['a1b2c3d4', "I don't have ___ to talk.", 'time', 'space', 'money', 'room', 0, 1, 1, 0],
		['0badf00d', 'She ___ every morning.', 'walks', 'sleeps', 'eats', 'runs', 3, 3, 2, 1],
		['deadbeef', 'That was ___.', 'slow', 'quick', 'late', 'odd', 1, 0, 5, 2],
		['cafe0001', 'We ___ home.', 'sat', 'went', 'ran', 'stayed', 2, 2, 4, 1]
	]
};

describe('decodeBand', () => {
	const { questions, words } = decodeBand(band, 1000);

	it('ranks words by band and position', () => {
		expect(words.map((w) => w.rank)).toEqual([2001, 2002, 2003]);
		expect(words.every((w) => w.band === 3)).toBe(true);
		expect(decodeBand({ ...band, band: 1 }, 1000).words[0].rank).toBe(1);
		expect(decodeBand(band, 500).words[2].rank).toBe(1003);
	});

	it('keeps gloss fields, empty when unknown', () => {
		expect(words[0]).toEqual({
			word: 'time',
			pos: 'n',
			zipf: 6.12,
			rank: 2001,
			band: 3,
			ipa: 'taɪm',
			en: 'an instance or single occasion for some event',
			zh: '時間；次；時代'
		});
		expect(words[1]).toMatchObject({ word: 'run', pos: 'v', ipa: '', en: '', zh: '' });
	});

	it('maps choices in up, left, down, right order', () => {
		expect(questions[0].choices).toEqual({ up: 'time', left: 'space', down: 'money', right: 'room' });
		expect(Object.keys(questions[1].choices)).toEqual(['up', 'left', 'down', 'right']);
	});

	it('maps the answer index to a direction', () => {
		expect(questions.map((q) => q.answer)).toEqual(['up', 'right', 'left', 'down']);
		expect(questions.map((q) => q.choices[q.answer])).toEqual(['time', 'runs', 'quick', 'ran']);
	});

	it('maps the category index', () => {
		expect(questions.map((q) => q.category)).toEqual(['conversation', 'academic', 'travel', 'networking']);
	});

	it('takes the lemma from the word index, not the surface form', () => {
		expect(questions.map((q) => q.lemma)).toEqual(['time', 'run', 'quick', 'run']);
	});

	it('keeps id, sentence and difficulty', () => {
		expect(questions[2]).toMatchObject({ id: 'deadbeef', sentence: 'That was ___.', difficulty: 5 });
		expect(questions).toHaveLength(4);
	});

	it('rejects a question pointing at a missing word', () => {
		const broken: BandFile = { ...band, questions: [['ffffffff', 'A ___.', 'a', 'b', 'c', 'd', 0, 0, 1, 9]] };
		expect(() => decodeBand(broken, 1000)).toThrow(/no word 9/);
	});
});

describe('senses', () => {
	const file: BandFile = {
		band: 1,
		words: [
			[
				'steal',
				'n',
				4.5,
				'stil',
				'an advantageous purchase',
				'便宜貨',
				[
					['v', 'take without permission', '偷'],
					['v', 'move stealthily', '偷偷地走']
				]
			],
			['major', 'n', 5, 'ˈmeɪdʒɚ', 'the principal field of study of a student', '主修', [['n', 'a commissioned military officer', '少校']]],
			['quick', 'adj', 5.1, 'kwɪk', 'fast', '快的']
		],
		questions: [
			['00000001', 'What a ___!', 'steal', 'deal', 'meal', 'heal', 0, 1, 1, 0],
			['00000002', 'They ___ cars.', 'steal', 'sell', 'buy', 'fix', 0, 1, 1, 0, 0],
			['00000003', 'She ___ away.', 'stole', 'ran', 'flew', 'went', 0, 1, 1, 0, 1],
			['00000004', 'A ___ took command.', 'major', 'pilot', 'judge', 'nurse', 0, 1, 1, 1, 0]
		]
	};
	const { questions, words } = decodeBand(file, 1000);

	it('decodes other senses and the sense each sentence uses', () => {
		expect(words[0].senses).toEqual([
			{ pos: 'v', en: 'take without permission', zh: '偷' },
			{ pos: 'v', en: 'move stealthily', zh: '偷偷地走' }
		]);
		expect(words[2].senses).toBeUndefined();
		expect(questions.map((q) => q.sense)).toEqual([undefined, 0, 1, 0]);
	});

	it('keeps the blank part of speech only when it differs from the main one', () => {
		expect(questions.map((q) => q.pos)).toEqual([undefined, 'v', 'v', undefined]);
	});

	it('glosses a question with the sense its sentence uses', () => {
		expect(senseFor(words[0], questions[1])).toMatchObject({ pos: 'v', en: 'take without permission', zh: '偷' });
		expect(senseFor(words[0], questions[2])).toMatchObject({ pos: 'v', en: 'move stealthily' });
		expect(senseFor(words[1], questions[3])).toMatchObject({ pos: 'n', en: 'a commissioned military officer', zh: '少校' });
		expect(senseFor(words[0], questions[0])).toBe(words[0]);
		expect(senseFor(words[0], undefined)).toBe(words[0]);
	});

	it('takes a bare part of speech as its first sense', () => {
		expect(senseFor(words[0], 'v')).toMatchObject({ pos: 'v', en: 'take without permission' });
		expect(senseFor(words[0], 'n')).toBe(words[0]);
		expect(senseFor(words[0], 'adj')).toBe(words[0]);
	});

	it('rejects a question pointing at a missing sense', () => {
		const broken: BandFile = { ...file, questions: [['ffffffff', 'A ___.', 'a', 'b', 'c', 'd', 0, 0, 1, 2, 0]] };
		expect(() => decodeBand(broken, 1000)).toThrow(/no sense 0 of quick/);
	});
});
