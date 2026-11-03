import { describe, expect, it } from 'vitest';
import { Deck } from './deck';
import { readingMs } from './game.svelte';
import { damage, heal, hpDelta } from './modes';
import { averageMs, emptyProgress, record, recordBest } from './progress';
import { score } from './scoring';
import type { Question } from './types';

function question(i: number, lemma = `w${i}`): Question {
	return {
		id: `q${i}`,
		sentence: 'A ___ b.',
		choices: { up: lemma, left: 'x', down: 'y', right: 'z' },
		answer: 'up',
		category: 'travel',
		difficulty: 1,
		lemma
	};
}

describe('score', () => {
	it('awards full marks within one second', () => {
		expect(score(true, 0)).toBe(100);
		expect(score(true, 1000)).toBe(100);
	});
	it('decays linearly to zero at ten seconds', () => {
		expect(score(true, 5500)).toBe(50);
		expect(score(true, 2800)).toBe(80);
		expect(score(true, 9999)).toBe(0);
		expect(score(true, 10_000)).toBe(0);
	});
	it('gives nothing for a wrong answer', () => {
		expect(score(false, 200)).toBe(0);
	});
});

describe('readingMs', () => {
	it('allows 200 ms per word at 300 WPM, counting the blank', () => {
		expect(readingMs('The results ___ that the method is effective.')).toBe(1600);
		expect(readingMs('  Hi   ___ ')).toBe(400);
	});
});

describe('Deck', () => {
	it('never repeats a question or word back to back', () => {
		const deck = new Deck(
			Array.from({ length: 40 }, (_, i) => question(i, `w${i % 20}`)),
			[],
			mulberry(1)
		);
		let prev = deck.next();
		for (let i = 0; i < 2000; i++) {
			const q = deck.next();
			expect(q.id).not.toBe(prev.id);
			expect(q.lemma).not.toBe(prev.lemma);
			prev = q;
		}
	});

	it('keeps recently seen questions out of a fresh deck', () => {
		const questions = Array.from({ length: 500 }, (_, i) => question(i));
		const recent = questions.slice(0, 150).map((q) => q.id);
		const deck = new Deck(questions, recent, mulberry(2));
		for (let i = 0; i < 50; i++) expect(recent).not.toContain(deck.next().id);
	});

	it('copes with a single question', () => {
		const deck = new Deck([question(0)]);
		expect(deck.next().id).toBe('q0');
		expect(deck.next().id).toBe('q0');
	});
});

describe('record', () => {
	it('tracks outcomes, response time and per-word stats separately', () => {
		const p = emptyProgress();
		const q = question(1, 'suggest');
		record(p, q, { outcome: 'correct', picked: 'up', ms: 800, score: 100 });
		record(p, q, { outcome: 'incorrect', picked: 'left', ms: 1200, score: 0 });
		record(p, q, { outcome: 'timeout', picked: null, ms: 5000, score: 0 });
		expect(p).toMatchObject({ attempted: 3, correct: 1, incorrect: 1, timedOut: 1, totalScore: 100 });
		expect(averageMs(p)).toBe(1000);
		expect(p.words.suggest.slice(0, 5)).toEqual([3, 1, 1, 1, 2000]);
	});
});

describe('survival HP', () => {
	it('heals by speed on a correct answer', () => {
		expect(heal(100)).toBe(10);
		expect(heal(50)).toBe(5);
		expect(hpDelta({ outcome: 'correct', picked: 'up', ms: 3000, score: 50 }, 0)).toBe(5);
	});
	it('charges a growing penalty for misses and timeouts', () => {
		expect(damage(0)).toBe(20);
		expect(damage(24)).toBe(20);
		expect(damage(25)).toBe(25);
		expect(hpDelta({ outcome: 'timeout', picked: null, ms: 5000, score: 0 }, 50)).toBe(-30);
	});
});

describe('recordBest', () => {
	it('keeps only the higher score per mode', () => {
		const p = emptyProgress();
		expect(recordBest(p, 'quick', { score: 900, correct: 10, count: 30, at: 1 })).toBe(true);
		expect(recordBest(p, 'quick', { score: 800, correct: 12, count: 30, at: 2 })).toBe(false);
		expect(recordBest(p, 'standard', { score: 100, correct: 1, count: 100, at: 3 })).toBe(true);
		expect(p.bests.quick?.score).toBe(900);
	});
});

function mulberry(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
