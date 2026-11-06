import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	Course,
	DEFAULT_DAILY_NEW,
	ESTIMATE_MIN_EVIDENCE,
	KEEP_GOING_NEW,
	LEARN_KEY,
	LOG_LIMIT,
	MAX_DAILY_NEW,
	Placement,
	TARGETS,
	addDays,
	bandCoverage,
	bandEstimates,
	defaultPlan,
	dueCount,
	emptyLearner,
	estimateRange,
	estimateReady,
	estimateVocabulary,
	fitBands,
	forecast,
	frontierBand,
	gradeThresholds,
	loadLearner,
	planSummary,
	recordAnswer,
	saveLearner,
	setPlan,
	studyMinutes,
	todayTally,
	vocabularyBreakdown,
	wordStatus,
	type DayTally,
	type DrawKind,
	type LearnerState,
	type LogEntry
} from './learner';
import { dayKey, loadSettings } from './progress';
import { AGAIN_DELAY_SEC, EASY_MS, HARD_MS, forgetting, newCard, packCard, type Grade } from './srs';
import type { Lexicon, Question, Result, WordInfo } from './types';

const BANDS = 6;
const PER_BAND = 40;
const DAY_MS = 86_400_000;
/** 10:00 local time, so a few hours either way stay on the same day. */
const NOW = new Date(2026, 10, 6, 10, 0, 0).getTime();
const TODAY = dayKey(new Date(NOW));

interface FixtureOptions {
	bands?: number;
	perBand?: number;
	/** Sentences per word. */
	sentences?: number;
	/** Words left without sentences. */
	skip?: (word: string) => boolean;
	/** The three distractors of a word's k-th sentence. */
	distractors?: (word: string, k: number) => [string, string, string];
}

/**
 * Words b<band>w<i>, ranked band by band; sentence k of each word is k levels harder than its
 * band. By default 6 bands × 40 words × 2 sentences with the distractors x, y, z.
 */
function fixture({
	bands = BANDS,
	perBand = PER_BAND,
	sentences = 2,
	skip = () => false,
	distractors = () => ['x', 'y', 'z']
}: FixtureOptions = {}): { lex: Lexicon; questions: Question[] } {
	const words = new Map<string, WordInfo>();
	const byRank: WordInfo[] = [];
	const questions: Question[] = [];
	for (let band = 1; band <= bands; band++) {
		for (let i = 0; i < perBand; i++) {
			const word = `b${band}w${i}`;
			const info: WordInfo = {
				word,
				pos: 'n',
				zipf: 7 - band,
				rank: (band - 1) * perBand + i + 1,
				band,
				ipa: '',
				en: '',
				zh: ''
			};
			words.set(word, info);
			byRank.push(info);
			if (skip(word)) continue;
			for (let k = 0; k < sentences; k++) {
				const [left, down, right] = distractors(word, k);
				questions.push({
					id: `${word}#${k}`,
					sentence: `The ___ was ${'very '.repeat((i + k * 3) % 7)}there.`,
					choices: { up: word, left, down, right },
					answer: 'up',
					category: 'travel',
					difficulty: Math.min(5, band + k),
					lemma: word
				});
			}
		}
	}
	return { lex: { words, byRank, bandSize: perBand, bands }, questions };
}

const { lex, questions } = fixture();
/** An 18-band bank of 1,000 words a band, one sentence each, shaped like the real one. */
const big = fixture({ bands: 18, perBand: 1000, sentences: 1 });

const good: Result = { outcome: 'correct', picked: 'up', ms: 3000, score: 70 };
const easy: Result = { outcome: 'correct', picked: 'up', ms: 900, score: 100 };
const hard: Result = { outcome: 'correct', picked: 'up', ms: 6000, score: 40 };
const miss: Result = { outcome: 'incorrect', picked: 'left', ms: 2000, score: 0 };
const timeout: Result = { outcome: 'timeout', picked: null, ms: 10_000, score: 0 };

const info = (word: string) => lex.words.get(word);
const bandOf = (word: string) => Number(/^b(\d+)w/.exec(word)![1]);
/** Where word i of a fixture band lies in it, as the evidence records it. */
const at = (i: number) => (i + 0.5) / PER_BAND;
/** A new word, or a probe (a new word asked for evidence). */
const fresh = (kind: DrawKind) => kind === 'new' || kind === 'probe';

/** A learner with careful first-encounter evidence per band: [answers, correct], spread evenly over the band. */
function withFirsts(firsts: Record<number, [number, number]>): LearnerState {
	const s = emptyLearner();
	for (const [band, [n, c]] of Object.entries(firsts)) s.firsts[band] = [n, c, n / 2];
	return s;
}

/** Bands 1–2 known (p ≥ 0.9), band 3 about half, bands 4–6 barely: the frontier is band 3. */
const PROFILE: Record<number, [number, number]> = {
	1: [30, 30],
	2: [30, 30],
	3: [30, 19],
	4: [30, 8],
	5: [30, 8],
	6: [30, 7]
};

/** A card reviewed `daysAgo` with Good and due since then. */
function dueCard(state: LearnerState, word: string, daysAgo: number, s = 3.173): void {
	const sec = Math.floor((NOW - daysAgo * DAY_MS) / 1000);
	state.cards[word] = packCard({ ...newCard(3, sec), s, due: sec + 86_400 });
}

/** Scored play (Quick, Standard, Survival), and learn mode. */
const opts = { introduce: false, now: NOW, lex };
const learn = { introduce: true, now: NOW, lex };

describe('recordAnswer', () => {
	it('keeps a missed first encounter new outside learn mode, as scored evidence', () => {
		const s = emptyLearner();
		const r = recordAnswer(s, info('b2w0'), miss, opts);
		expect(r).toEqual({ grade: 1, firstEncounter: true, created: false, verify: false });
		expect(s.cards).toEqual({});
		expect(s.firsts).toEqual({});
		expect(s.scoredFirsts['2']).toEqual([1, 0, at(0)]);
		expect(s.met).toEqual({ b2w0: 1 });
		expect(wordStatus(s, 'b2w0')).toBe('new');
		// The day's tally is learn mode's alone.
		expect(todayTally(s, NOW)).toEqual({ newIntroduced: 0, reviews: 0, correct: 0, answerMs: 0 });
	});

	it('creates a card for a correct first encounter in any mode, tallying it only in learn mode', () => {
		const s = emptyLearner();
		expect(recordAnswer(s, info('b1w0'), good, opts)).toEqual({
			grade: 3,
			firstEncounter: true,
			created: true,
			verify: false
		});
		expect(recordAnswer(s, info('b1w1'), hard, learn).created).toBe(true);
		expect(s.scoredFirsts['1']).toEqual([1, 1, at(0)]);
		expect(s.firsts['1']).toEqual([1, 1, at(1)]);
		expect(s.cards.b1w0[7]).toBe(3);
		expect(s.cards.b1w1[7]).toBe(2);
		expect(s.met).toEqual({});
		expect(todayTally(s, NOW)).toEqual({ newIntroduced: 1, reviews: 0, correct: 1, answerMs: 6000 });
	});

	it('introduces a missed word in learn mode', () => {
		const s = emptyLearner();
		const r = recordAnswer(s, info('b3w5'), timeout, learn);
		expect(r).toEqual({ grade: 1, firstEncounter: true, created: true, verify: false });
		expect(s.cards.b3w5[0]).toBeCloseTo(0.40255, 4);
		expect(s.firsts['3']).toEqual([1, 0, at(5)]);
		expect(todayTally(s, NOW).newIntroduced).toBe(1);
		expect(todayTally(s, NOW).answerMs).toBe(10_000);
	});

	it('reviews an existing card without touching first-encounter evidence', () => {
		const s = emptyLearner();
		recordAnswer(s, info('b1w0'), good, learn);
		const later = NOW + 3 * DAY_MS;
		const r = recordAnswer(s, info('b1w0'), good, { ...learn, now: later });
		expect(r).toEqual({ grade: 3, firstEncounter: false, created: false, verify: false });
		expect(s.firsts['1']).toEqual([1, 1, at(0)]);
		expect(s.cards.b1w0[4]).toBe(2);
		expect(s.cards.b1w0[0]).toBeGreaterThan(10);
		expect(todayTally(s, later)).toMatchObject({ newIntroduced: 0, reviews: 1 });
	});

	it("counts a word's first answer once, however often it comes back without a card", () => {
		const s = emptyLearner();
		for (let i = 0; i < 3; i++) recordAnswer(s, info('b5w0'), miss, opts);
		expect(s.scoredFirsts['5']).toEqual([1, 0, at(0)]);
		// Nor again when learn mode introduces it at last.
		expect(recordAnswer(s, info('b5w0'), miss, learn)).toMatchObject({ firstEncounter: true, created: true });
		expect(s.firsts).toEqual({});
		expect(s.met).toEqual({});
		expect(todayTally(s, NOW).newIntroduced).toBe(1);
	});

	it('keeps a bank the learner chose out of the evidence', () => {
		const s = emptyLearner();
		recordAnswer(s, info('b5w0'), miss, { ...opts, evidence: 'none' });
		recordAnswer(s, info('b1w0'), good, { ...opts, evidence: 'none' });
		expect(s.firsts).toEqual({});
		expect(s.scoredFirsts).toEqual({});
		expect(s.met).toEqual({});
		expect(Object.keys(s.cards)).toEqual(['b1w0']);
		// Its words still count when met at random later on.
		recordAnswer(s, info('b5w0'), miss, learn);
		expect(s.firsts['5']).toEqual([1, 0, at(0)]);
	});

	it('makes no card outside learn mode for a correct answer about as likely to be a guess', () => {
		const s = withFirsts(PROFILE);
		expect(bandEstimates(s, lex)[4]).toBeLessThan(0.5);
		expect(recordAnswer(s, info('b5w3'), good, opts)).toMatchObject({ grade: 3, firstEncounter: true, created: false });
		expect(s.met).toEqual({ b5w3: 1 });
		expect(s.scoredFirsts['5']).toEqual([1, 1, at(3)]);
		// Learn mode introduces it all the same, without counting it again.
		expect(recordAnswer(s, info('b5w3'), good, learn).created).toBe(true);
		expect(s.firsts['5']).toEqual([30, 8, 15]);
		expect(s.met).toEqual({});
	});

	it('ignores words outside the lexicon', () => {
		const s = emptyLearner();
		expect(recordAnswer(s, undefined, good, learn).created).toBe(false);
		expect(s).toEqual(emptyLearner());
	});
});

describe('first-encounter grading', () => {
	it('holds a fast first answer at Good where a lucky guess is still likely', () => {
		const s = withFirsts(PROFILE);
		expect(bandEstimates(s, lex)[2]).toBeLessThan(0.9);
		const r = recordAnswer(s, info('b3w0'), easy, learn);
		expect(r).toEqual({ grade: 3, firstEncounter: true, created: true, verify: true });
		expect(s.cards.b3w0[7]).toBe(3);
		expect(s.cards.b3w0[0]).toBeCloseTo(3.173, 3);
	});

	it('takes a fast first answer as Easy in a band known with p ≥ 0.9', () => {
		const s = withFirsts(PROFILE);
		expect(bandEstimates(s, lex)[1]).toBeGreaterThanOrEqual(0.9);
		expect(recordAnswer(s, info('b2w0'), easy, opts)).toMatchObject({ grade: 4, verify: false });
		expect(s.cards.b2w0[0]).toBeCloseTo(15.69105, 4);
	});

	it('leaves slower first answers and reviews alone', () => {
		const s = withFirsts(PROFILE);
		expect(recordAnswer(s, info('b4w0'), good, learn)).toMatchObject({ grade: 3, verify: false });
		s.cards.b5w0 = packCard(newCard(3, NOW / 1000 - 3 * 86_400));
		expect(recordAnswer(s, info('b5w0'), easy, learn)).toMatchObject({
			grade: 4,
			firstEncounter: false,
			verify: false
		});
	});

	it('judges by the evidence before the answer, with or without the lexicon at hand', () => {
		const a = withFirsts(PROFILE);
		const b = withFirsts(PROFILE);
		expect(recordAnswer(a, info('b3w0'), easy, learn)).toEqual(
			recordAnswer(b, info('b3w0'), easy, { introduce: true, now: NOW })
		);
		expect(a.cards).toEqual(b.cards);
		// Without the lexicon the word's place in its band is unknown: counted mid-band.
		expect(a.firsts['3']).toEqual([31, 20, 15 + at(0)]);
		expect(b.firsts['3']).toEqual([31, 20, 15.5]);
	});
});

describe('review log', () => {
	it('logs every answer with its question, outcome and the stability it met', () => {
		const s = emptyLearner();
		recordAnswer(s, info('b1w0'), good, { ...learn, questionId: 'b1w0#0' });
		recordAnswer(s, info('b1w0'), timeout, { ...learn, now: NOW + 3 * DAY_MS, questionId: 'b1w0#1' });
		recordAnswer(s, info('b2w0'), miss, opts);
		const sec = Math.floor(NOW / 1000);
		expect(s.log).toEqual([
			['b1w0', sec, 3, 3000, 'b1w0#0', 0, 0],
			['b1w0', sec + 3 * 86_400, 1, 10_000, 'b1w0#1', 2, 3.17],
			['b2w0', sec, 1, 2000, '', 1, 0]
		]);
	});

	it(`keeps the last ${LOG_LIMIT} answers`, () => {
		const s = emptyLearner();
		s.log = Array.from({ length: LOG_LIMIT }, (_, i): LogEntry => ['old', i, 3, 2000, `q${i}`, 0, 1]);
		recordAnswer(s, info('b1w0'), good, { ...learn, questionId: 'latest' });
		expect(s.log).toHaveLength(LOG_LIMIT);
		expect(s.log[0][1]).toBe(1);
		expect(s.log[LOG_LIMIT - 1][4]).toBe('latest');
	});
});

describe('gradeThresholds', () => {
	const entry = (ms: number, stability = 30, outcome: 0 | 1 | 2 = 0): LogEntry => ['w', 0, 3, ms, 'q', outcome, stability];

	it('keeps the defaults until 30 correct answers on mature cards', () => {
		const s = emptyLearner();
		s.log = [
			...Array.from({ length: 29 }, (_, i) => entry(1000 + i * 10)),
			entry(500, 20.9),
			entry(500, 30, 1),
			entry(500, 0)
		];
		expect(gradeThresholds(s)).toEqual({ easy: EASY_MS, hard: HARD_MS });
	});

	it('sets Easy at their 40th and Hard past their 90th percentile, within bounds', () => {
		const s = emptyLearner();
		// 1500, 1550, …, 2950 ms: 40th percentile 2080; 90th 2805, raised to the 3500 floor.
		s.log = Array.from({ length: 30 }, (_, i) => entry(1500 + i * 50));
		expect(gradeThresholds(s)).toEqual({ easy: 2080, hard: 3500 });
		s.log = Array.from({ length: 30 }, (_, i) => entry(400 + i * 10));
		expect(gradeThresholds(s).easy).toBe(1200);
		s.log = Array.from({ length: 40 }, (_, i) => entry(3000 + i * 200));
		expect(gradeThresholds(s)).toEqual({ easy: 2500, hard: 6000 });
	});

	it('grades the learner by them', () => {
		const s = emptyLearner();
		s.log = Array.from({ length: 30 }, (_, i) => entry(800 + i * 20));
		s.cards.b1w0 = packCard(newCard(3, NOW / 1000 - 3 * 86_400));
		// 1.5 s is Easy by default, but only Good for someone whose sure answers take about 1 s.
		expect(recordAnswer(s, info('b1w0'), { ...good, ms: 1500 }, learn).grade).toBe(3);
	});
});

describe('band model', () => {
	it('corrects for guessing: all correct ≈ 1, chance ≈ 0', () => {
		expect(fitBands([100], [100])[0]).toBeGreaterThan(0.98);
		const chance = fitBands([20, 20, 20, 20, 20, 20], [5, 5, 5, 5, 5, 5]);
		expect(chance[0]).toBeLessThan(0.2);
		expect(chance[5]).toBeLessThan(0.03);
	});

	it('lets short perfect runs clear the frontier line', () => {
		// Laplace's rule capped 2 of 2 at p = 0.67, which pinned every frontier to band 1.
		const p = fitBands([2, 2, 2, 2, 2, 2], [2, 2, 2, 0, 0, 0]);
		expect(p[0]).toBeGreaterThan(0.9);
		expect(p[1]).toBeGreaterThan(0.8);
		expect(p[5]).toBeLessThan(0.2);
	});

	it('is non-increasing for any evidence', () => {
		const random = mulberry(7);
		for (let trial = 0; trial < 200; trial++) {
			const n = Array.from({ length: 12 }, () => Math.floor(random() * 6));
			const c = n.map((k) => Math.floor(random() * (k + 1)));
			const p = fitBands(n, c);
			for (let b = 1; b < p.length; b++) expect(p[b]).toBeLessThanOrEqual(p[b - 1] + 1e-12);
			for (const x of p) expect(x >= 0 && x <= 1).toBe(true);
		}
	});

	it('fills bands without evidence from the curve', () => {
		const p = fitBands([0, 30, 0, 0, 30, 0], [0, 30, 0, 0, 15, 0]);
		expect(p[1]).toBeGreaterThan(0.95);
		expect(p[0]).toBeGreaterThanOrEqual(p[1]);
		expect(p[2]).toBeLessThan(p[1]);
		expect(p[2]).toBeGreaterThan(p[4]);
		// Half right is about a third known once guessing is taken out.
		expect(p[4]).toBeCloseTo(1 / 3, 1);
		expect(p[5]).toBeLessThan(p[4]);
	});

	it('falls back on the prior without evidence', () => {
		const prior = fitBands([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]);
		for (let b = 1; b < prior.length; b++) expect(prior[b]).toBeLessThan(prior[b - 1]);
		expect(prior[0]).toBeGreaterThan(0.8);
		expect(prior[5]).toBeLessThan(0.6);
	});

	it('reads rare bands without answers as mostly unknown', () => {
		// Bands 1–3 known, 4–6 at chance, nothing asked beyond. Under a uniform prior over the
		// floor, bands 9–18 would each sit above 8% known: some 800 rare words never asked about.
		const none = new Array<number>(12).fill(0);
		const p = fitBands([4, 4, 4, 4, 4, 4, ...none], [4, 4, 4, 1, 1, 1, ...none]);
		for (const x of p.slice(8)) expect(x).toBeLessThan(0.065);
		// Answers there still count: lucky guesses in rare bands raise them, if not to their face value.
		const lucky = fitBands([4, 4, 4, 4, 4, 4, 4, 4, ...none.slice(2)], [4, 4, 4, 1, 1, 1, 3, 3, ...none.slice(2)]);
		expect(lucky[17]).toBeGreaterThan(p[17] + 0.05);
	});

	it('shrugs off a stray miss in a known band', () => {
		const clean = fitBands([60, 60, 60, 20, 20, 20], [60, 60, 60, 5, 5, 5]);
		const slip = fitBands([60, 60, 60, 20, 20, 20], [59, 60, 60, 5, 5, 5]);
		for (let b = 0; b < 3; b++) expect(slip[b]).toBeGreaterThan(clean[b] - 0.03);
	});

	it('weighs at most 100 answers a band, so heavy practice cannot lock in one curve shape', () => {
		const heavy = fitBands([1000, 1000, 400, 0, 0, 0], [980, 720, 200, 0, 0, 0]);
		const capped = fitBands([100, 100, 100, 0, 0, 0], [98, 72, 50, 0, 0, 0]);
		heavy.forEach((p, b) => expect(p).toBeCloseTo(capped[b], 10));
	});

	it('weighs answers where they lie in their band, and the unseen words where they lie', () => {
		// Learn mode works down a band from its most frequent words: answers from the top of a band
		// say less about its rarer words than the same answers spread over the whole band.
		const even = emptyLearner();
		const top = emptyLearner();
		const evidence: [number, number, number][] = [
			[1, 20, 20],
			[2, 20, 19],
			[3, 100, 80],
			[4, 10, 3],
			[5, 10, 2]
		];
		for (const [b, n, c] of evidence) {
			even.firsts[b] = [n, c, n / 2];
			top.firsts[b] = [n, c, b === 3 ? n * 0.1 : n / 2];
		}
		const pe = bandEstimates(even, big.lex);
		const pt = bandEstimates(top, big.lex);
		expect(pt[2]).toBeLessThan(pe[2] - 0.05);
		for (let b = 1; b < pt.length; b++) expect(pt[b]).toBeLessThanOrEqual(pt[b - 1] + 1e-12);
	});

	it('reads scored play with a larger slip, so racing the clock does not pull the frontier down', () => {
		// Right after the level test (frontier 7, everyday bands barely asked), a Quick round on
		// everyday words (bands 1–3) with a few slips. Read like learn-mode answers, those slips
		// would make the frontier fall to everyday words.
		const tested: Record<number, [number, number]> = {
			1: [2, 2],
			3: [1, 1],
			4: [3, 3],
			5: [5, 5],
			6: [16, 14],
			7: [9, 5],
			8: [5, 3],
			9: [5, 0],
			10: [4, 0],
			11: [3, 0],
			13: [1, 0],
			15: [1, 0],
			17: [1, 1]
		};
		const play = (slips: number, evidence: 'scored' | 'careful') => {
			const state = emptyLearner();
			state.placement = { at: NOW, estimate: 6400, perBand: [] };
			for (const [b, [n, c]] of Object.entries(tested)) state.firsts[b] = [n, c, n / 2];
			expect(frontierBand(state, big.lex)).toBe(7);
			for (let i = 0; i < 30; i++) {
				const word = big.lex.words.get(`b${1 + (i % 3)}w${100 + i}`);
				// The slips spread over the three bands.
				recordAnswer(state, word, (i * 7) % 30 < slips ? miss : easy, { ...opts, lex: big.lex, evidence });
			}
			return frontierBand(state, big.lex);
		};
		expect(play(3, 'scored')).toBeGreaterThanOrEqual(6);
		expect(play(5, 'scored')).toBeGreaterThanOrEqual(6);
		expect(play(5, 'careful')).toBeLessThan(6);
	});

	it('hands out copies of its memoized results', () => {
		const a = fitBands([4, 4], [4, 1]);
		a[0] = 42;
		expect(fitBands([4, 4], [4, 1])[0]).not.toBe(42);
		const s = withFirsts(PROFILE);
		bandEstimates(s, lex)[0] = 42;
		expect(bandEstimates(s, lex)[0]).toBeLessThanOrEqual(1);
	});
});

describe('vocabulary estimate', () => {
	it('starts from the prior with the frontier at band 1', () => {
		const s = emptyLearner();
		const p = bandEstimates(s, lex);
		fitBands([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]).forEach((x, b) => expect(p[b]).toBeCloseTo(x, 10));
		const estimate = estimateVocabulary(s, lex, NOW);
		expect(estimate).toBe(Math.round(p.reduce((sum, x) => sum + x * PER_BAND, 0)));
		expect(frontierBand(s, lex)).toBe(1);
		const { low, high } = estimateRange(s, lex, NOW);
		expect(high - low).toBeGreaterThan(estimate / 2);
	});

	it('follows first-encounter evidence; the frontier is the first band below p = 0.8', () => {
		const s = withFirsts(PROFILE);
		const p = bandEstimates(s, lex);
		expect(p[0]).toBeGreaterThan(0.95);
		expect(p[2]).toBeCloseTo(0.55, 1);
		expect(p[4]).toBeLessThan(0.1);
		expect(frontierBand(s, lex)).toBe(3);
		// Misses in band 2 pull it below the line.
		for (let i = 0; i < 20; i++) recordAnswer(s, info(`b2w${i}`), miss, { ...opts, evidence: 'careful' });
		expect(bandEstimates(s, lex)[1]).toBeLessThan(0.8);
		expect(frontierBand(s, lex)).toBe(2);
	});

	it('moves the frontier past a band with no unseen words left', () => {
		const s = withFirsts(PROFILE);
		for (let i = 0; i < PER_BAND; i++) s.cards[`b3w${i}`] = packCard(newCard(3, NOW / 1000));
		expect(frontierBand(s, lex)).toBe(4);
	});

	it('never falls when a first encounter is answered correctly', () => {
		const s = withFirsts({ 1: [6, 6], 2: [6, 5], 3: [6, 3], 4: [6, 2] });
		let before = estimateVocabulary(s, lex, NOW);
		for (let i = 0; i < 30; i++) {
			const word = `b${1 + (i % BANDS)}w${i}`;
			recordAnswer(s, info(word), good, opts);
			const after = estimateVocabulary(s, lex, NOW);
			expect(after).toBeGreaterThanOrEqual(before);
			before = after;
		}
	});

	it('counts met words by recall probability, so it decays without review', () => {
		const s = withFirsts(PROFILE);
		for (let i = 0; i < 10; i++) recordAnswer(s, info(`b4w${i}`), miss, learn);
		const p = bandEstimates(s, lex);
		const unseen = p.reduce((sum, x, b) => sum + x * (PER_BAND - (b === 3 ? 10 : 0)), 0);
		const now = estimateVocabulary(s, lex, NOW);
		expect(now).toBe(Math.round(10 + unseen));
		const decay = now - estimateVocabulary(s, lex, NOW + 7 * DAY_MS);
		expect(Math.abs(decay - 10 * (1 - forgetting(7, 0.40255)))).toBeLessThanOrEqual(1);
	});

	it('gives a 90% interval around the estimate that narrows with evidence', () => {
		const loose = withFirsts({ 1: [2, 2], 3: [2, 1], 5: [2, 0] });
		const tight = withFirsts(
			Object.fromEntries(Object.entries(PROFILE).map(([b, [n, c]]) => [b, [n * 10, c * 10]]))
		);
		const widths = [loose, tight].map((s) => {
			const estimate = estimateVocabulary(s, lex, NOW);
			const { low, high } = estimateRange(s, lex, NOW);
			expect(low).toBeLessThanOrEqual(estimate);
			expect(high).toBeGreaterThanOrEqual(estimate);
			return high - low;
		});
		expect(widths[1]).toBeLessThan(widths[0] / 2);
	});

	it('splits every band into mastered, learning, estimated and unknown', () => {
		const s = withFirsts(PROFILE);
		recordAnswer(s, info('b1w0'), good, learn);
		recordAnswer(s, info('b3w0'), miss, learn);
		s.cards.b2w0 = packCard({ ...newCard(4, NOW / 1000), s: 30 });
		const coverage = bandCoverage(s, lex, NOW);
		expect(coverage).toHaveLength(BANDS);
		for (const c of coverage) expect(c.mastered + c.learning + c.estimated + c.unknown).toBe(PER_BAND);
		expect(coverage[0]).toMatchObject({ band: 1, mastered: 0, learning: 1 });
		expect(coverage[1]).toMatchObject({ mastered: 1, learning: 0 });
		expect(coverage[5]).toMatchObject({ band: 6, mastered: 0, learning: 0, estimated: 1 });
		expect(wordStatus(s, 'b2w0')).toBe('mastered');
		expect(wordStatus(s, 'b3w0')).toBe('learning');
	});

	it('stays finite for empty bands and an empty bank', () => {
		const words = lex.byRank.filter((w) => w.band === 1 || w.band === 3);
		const gappy: Lexicon = { words: new Map(words.map((w) => [w.word, w])), byRank: words, bandSize: PER_BAND, bands: 4 };
		const empty: Lexicon = { words: new Map(), byRank: [], bandSize: PER_BAND, bands: 0 };
		for (const l of [gappy, empty]) {
			for (const s of [emptyLearner(), withFirsts({ 1: [5, 5], 3: [5, 1] })]) {
				setPlan(s, { target: 2000, days: 30, start: TODAY });
				const numbers = [
					estimateVocabulary(s, l, NOW),
					...Object.values(estimateRange(s, l, NOW)),
					...bandEstimates(s, l),
					...bandCoverage(s, l, NOW).flatMap((c) => [c.mastered, c.learning, c.estimated, c.unknown]),
					...Object.values(planSummary(s, l, NOW)).filter((x) => typeof x === 'number')
				];
				for (const x of numbers) expect(Number.isFinite(x)).toBe(true);
				expect(frontierBand(s, l)).toBeGreaterThanOrEqual(1);
			}
		}
		expect(bandCoverage(emptyLearner(), gappy, NOW)[1]).toEqual({ band: 2, mastered: 0, learning: 0, estimated: 0, unknown: 0 });
		expect(estimateVocabulary(emptyLearner(), empty, NOW)).toBe(0);
	});

	it('tells words confirmed at first sight and since from words seen once and words learned', () => {
		const s = emptyLearner();
		const card = (stability: number, firstGrade: Grade, reps = 1, lapses = 0) =>
			packCard({ ...newCard(firstGrade, NOW / 1000), s: stability, reps, lapses });
		s.cards.a = card(3.2, 3); // right once, not asked again (a guess is still possible), learning
		s.cards.b = card(40, 4, 3); // confirmed, mastered
		s.cards.c = card(2, 3, 2); // confirmed, learning
		s.cards.d = card(0.4, 1, 2, 1); // missed at first, not yet learned
		s.cards.e = card(9, 1, 4, 1); // learned, learning
		s.cards.f = card(25, 1, 6, 1); // learned, mastered
		s.cards.g = card(8, 3, 3, 1); // right at first but missed since, then learned
		expect(vocabularyBreakdown(s, NOW)).toEqual({ confirmed: 2, once: 1, learned: 3, learning: 5, mastered: 2 });
	});
});

describe('estimateReady', () => {
	it(`waits for the level test or ${ESTIMATE_MIN_EVIDENCE} careful first answers`, () => {
		const s = emptyLearner();
		const careful = { ...opts, evidence: 'careful' } as const;
		expect(estimateReady(s)).toBe(false);
		for (let i = 0; i < ESTIMATE_MIN_EVIDENCE - 1; i++) {
			recordAnswer(s, info(`b${1 + (i % BANDS)}w${i}`), i % 3 ? good : miss, careful);
		}
		// Answering a word met before is a review, not a first answer.
		recordAnswer(s, info('b2w1'), good, { ...careful, now: NOW + 3 * DAY_MS });
		expect(estimateReady(s)).toBe(false);
		recordAnswer(s, info('b6w39'), miss, careful);
		expect(estimateReady(s)).toBe(true);
		// Scored play alone is too noisy to stand for a size.
		const t = emptyLearner();
		for (let i = 0; i < 2 * ESTIMATE_MIN_EVIDENCE; i++) recordAnswer(t, info(`b${1 + (i % BANDS)}w${i % PER_BAND}`), good, opts);
		expect(estimateReady(t)).toBe(false);
	});

	it('is ready once the level test is done, whatever the evidence', () => {
		const s = emptyLearner();
		s.placement = { at: NOW, estimate: 0, perBand: [] };
		expect(estimateReady(s)).toBe(true);
	});
});

describe('reviews', () => {
	it('counts due cards and forecasts them by local day', () => {
		const s = emptyLearner();
		const at = (ms: number) => {
			const t = packCard(newCard(3, NOW / 1000 - 86_400));
			t[3] = Math.floor((NOW + ms) / 1000);
			return t;
		};
		s.cards.a = at(-3600_000);
		s.cards.b = at(3600_000);
		s.cards.c = at(DAY_MS);
		s.cards.d = at(3 * DAY_MS);
		s.cards.e = at(30 * DAY_MS);
		expect(dueCount(s, NOW)).toBe(1);
		expect(forecast(s, 7, NOW)).toEqual([2, 1, 0, 1, 0, 0, 0]);
		expect(forecast(s, 0, NOW)).toEqual([]);
	});

	it('serves a card all day on the day it falls due, whatever the hour it was answered', () => {
		// Answered late in a long evening session: due at the start of its day, so the next
		// evening's session takes it rather than the one after.
		const s = emptyLearner();
		const late = new Date(2026, 10, 6, 23, 40).getTime();
		recordAnswer(s, info('b1w0'), good, { ...learn, now: late });
		recordAnswer(s, info('b1w1'), good, { ...learn, now: late - 3 * 3600_000 });
		const dueDay = new Date(2026, 10, 9, 0, 0).getTime();
		expect(dueCount(s, dueDay - 60_000)).toBe(0);
		expect(dueCount(s, dueDay)).toBe(2);
		expect(forecast(s, 4, NOW)).toEqual([0, 0, 0, 2]);
	});
});

describe('plan', () => {
	it('proposes 1,000 words beyond the estimate, to the next hundred, in 60 days', () => {
		expect(TARGETS).toEqual([2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000]);
		expect(defaultPlan(6420, TODAY)).toEqual({ target: 7500, days: 60, start: TODAY });
		expect(defaultPlan(0, TODAY).target).toBe(1000);
		expect(defaultPlan(2500, TODAY).target).toBe(3500);
		expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
	});

	it('proposes a goal a learner can keep up right after the level test', () => {
		for (const size of [2000, 5000, 9000, 14000]) {
			for (let seed = 1; seed <= 3; seed++) {
				const random = mulberry(size + seed);
				const known = (b: number) => 1 / (1 + Math.exp(-(size / 1000 + 0.5 - b)));
				const placement = new Placement(big.lex, big.questions, { random: mulberry(seed), now: () => NOW });
				answerAll(placement, (q) => (random() < known(band(q)) || random() < 0.25 ? good : miss));
				const state = emptyLearner();
				const { estimate } = placement.finish(state, NOW);
				setPlan(state, defaultPlan(estimate, TODAY));
				const summary = planSummary(state, big.lex, NOW);
				// About the 20–50 words a day most learners can genuinely learn, at a pace well below the ceiling.
				expect(summary.dailyNew).toBeLessThanOrEqual(75);
				expect(summary.minutes).toBeLessThanOrEqual(35);
				expect(summary.finish! <= summary.deadline!).toBe(true);
				expect(summary.onTrack).toBe(true);
			}
		}
	});

	it('prices each word introduced a day at about 25 seconds of study', () => {
		expect(studyMinutes(0)).toBe(0);
		expect(studyMinutes(30)).toBe(13);
		expect(studyMinutes(MAX_DAILY_NEW)).toBe(63);
	});

	it('works out the daily load from the gap, the days left and the bands ahead', () => {
		const s = withFirsts(PROFILE);
		const estimate = estimateVocabulary(s, lex, NOW);
		expect(planSummary(s, lex, NOW)).toMatchObject({ plan: null, estimate, dailyNew: 0, reached: false, expired: false });
		setPlan(s, { target: estimate + 40, days: 4, start: TODAY });
		// 40 words over 4 days, walking up from the frontier (band 3): each of its 40 words adds
		// what is not known of it already, about half, and band 4's words the rest.
		const p = bandEstimates(s, lex);
		const words = PER_BAND + (40 - PER_BAND * (1 - p[2])) / (1 - p[3]);
		const dailyNew = Math.ceil(words / 4);
		const summary = planSummary(s, lex, NOW);
		expect(summary).toMatchObject({
			plan: { target: estimate + 40, days: 4, start: TODAY },
			estimate,
			daysLeft: 4,
			dailyGain: 10,
			dailyNew,
			minutes: studyMinutes(dailyNew),
			deadline: addDays(TODAY, 4),
			reached: false,
			expired: false,
			onTrack: true
		});
		expect(summary.finish! <= summary.deadline!).toBe(true);
	});

	it('counts a target beyond the bank as the whole bank', () => {
		const s = withFirsts(PROFILE);
		setPlan(s, { target: 20000, days: 10, start: TODAY });
		const summary = planSummary(s, lex, NOW);
		// The goal is capped at the bank's 240 words.
		expect(Math.abs(summary.dailyGain - (240 - summary.estimate) / 10)).toBeLessThanOrEqual(1);
		expect(summary.finish! <= summary.deadline!).toBe(true);
	});

	it('is on track on its first day, then while each day introduces 90% of what it asked', () => {
		const s = withFirsts(PROFILE);
		const target = estimateVocabulary(s, lex, NOW) + 40;
		setPlan(s, { target, days: 10, start: TODAY });
		expect(planSummary(s, lex, NOW).onTrack).toBe(true);
		const yesterday = addDays(TODAY, -1);
		setPlan(s, { target, days: 10, start: yesterday });
		s.days[yesterday] = [15, 4, 17, 60_000, 150, 16];
		expect(planSummary(s, lex, NOW).onTrack).toBe(true);
		s.days[yesterday] = [14, 4, 16, 60_000, 150, 16];
		expect(planSummary(s, lex, NOW).onTrack).toBe(false);
		// A day without learn mode falls short of whatever it would have asked.
		delete s.days[yesterday];
		expect(planSummary(s, lex, NOW).onTrack).toBe(false);
	});

	it('does not count a shortfall twice: the quota takes it up day by day', () => {
		// Each past day met its own quota; today's is larger than they were, which made
		// "introduced so far ≥ 90% of days × today's quota" fail although nothing was missed.
		const s = withFirsts(PROFILE);
		setPlan(s, { target: estimateVocabulary(s, lex, NOW) + 80, days: 10, start: addDays(TODAY, -8) });
		for (let d = 1; d <= 8; d++) s.days[addDays(TODAY, -d)] = [3, 0, 3, 9000, 0, 3];
		const summary = planSummary(s, lex, NOW);
		expect(summary.dailyNew).toBeGreaterThan(3 * 1.2);
		expect(summary.onTrack).toBe(true);
	});

	it('caps the daily load at 150 and holds it steady through the day', () => {
		const words = new Map<string, WordInfo>();
		const byRank: WordInfo[] = [];
		for (let r = 1; r <= 20_000; r++) {
			const w: WordInfo = { word: `w${r}`, pos: 'n', zipf: 1, rank: r, band: Math.ceil(r / 1000), ipa: '', en: '', zh: '' };
			words.set(w.word, w);
			byRank.push(w);
		}
		const wide: Lexicon = { words, byRank, bandSize: 1000, bands: 20 };
		const s = withFirsts({ 1: [20, 20], 2: [20, 18], 3: [20, 12], 4: [20, 8], 5: [20, 6] });
		setPlan(s, { target: 15000, days: 14, start: TODAY });
		expect(MAX_DAILY_NEW).toBe(150);
		const capped = planSummary(s, wide, NOW);
		// Out of reach, which the pace says; "behind" waits until a day has passed.
		expect(capped).toMatchObject({ dailyNew: MAX_DAILY_NEW, minutes: studyMinutes(MAX_DAILY_NEW), onTrack: true });
		// The capped pace adds fewer words a day than the deadline asks, and says so.
		expect(capped.dailyGain).toBeLessThan(Math.ceil((15000 - capped.estimate) / 14));
		expect(capped.dailyGain).toBeLessThanOrEqual(capped.dailyNew);
		expect(capped.finish! > capped.deadline!).toBe(true);
		setPlan(s, { target: 15000, days: 14, start: addDays(TODAY, -1) });
		s.days[addDays(TODAY, -1)] = [MAX_DAILY_NEW, 0, 0, 0, 0, MAX_DAILY_NEW];
		expect(planSummary(s, wide, NOW).onTrack).toBe(false);

		const t = withFirsts(PROFILE);
		setPlan(t, { target: 200, days: 10, start: TODAY });
		const before = planSummary(t, lex, NOW);
		// Eight new words answered: the live estimate moves with the new cards and band estimates,
		// but today's figures stay as the day began.
		for (let i = 0; i < 8; i++) recordAnswer(t, info(`b3w${i}`), i < 5 ? good : miss, learn);
		const after = planSummary(t, lex, NOW + 60_000);
		expect(after.estimate).not.toBe(before.estimate);
		expect({ ...after, estimate: 0 }).toEqual({ ...before, estimate: 0 });
		// Until tomorrow.
		const tomorrow = planSummary(t, lex, NOW + DAY_MS);
		expect(tomorrow.daysLeft).toBe(9);
	});

	it('counts the goal reached only once the learner is likely past it', () => {
		// Little evidence, so the estimate could well be a few hundred words too high.
		const s = withFirsts({ 1: [3, 3], 2: [3, 2], 3: [3, 1] });
		const estimate = estimateVocabulary(s, lex, NOW);
		const { low } = estimateRange(s, lex, NOW);
		setPlan(s, { target: estimate - 5, days: 30, start: TODAY });
		const near = planSummary(s, lex, NOW);
		expect(near).toMatchObject({ reached: false, expired: false, onTrack: true });
		expect(near.dailyNew).toBeGreaterThan(0);
		expect(near.dailyGain).toBeGreaterThan(0);
		setPlan(s, { target: low, days: 30, start: TODAY });
		expect(planSummary(s, lex, NOW)).toMatchObject({ reached: true, dailyNew: 0, dailyGain: 0, finish: TODAY, onTrack: true });
	});

	it('falls back to the default pace once the deadline has passed unreached', () => {
		const s = withFirsts(PROFILE);
		setPlan(s, { target: 220, days: 10, start: addDays(TODAY, -20) });
		const expired = planSummary(s, lex, NOW);
		expect(expired).toMatchObject({
			daysLeft: 0,
			expired: true,
			reached: false,
			dailyNew: DEFAULT_DAILY_NEW,
			minutes: studyMinutes(DEFAULT_DAILY_NEW),
			deadline: addDays(TODAY, -10),
			onTrack: false
		});
		expect(expired.finish! > TODAY).toBe(true);
		// The last day of the plan is still a day of it.
		setPlan(s, { target: 220, days: 10, start: addDays(TODAY, -9) });
		expect(planSummary(s, lex, NOW)).toMatchObject({ daysLeft: 1, expired: false });
	});
});

interface Drawn {
	lemma: string;
	id: string;
	kind: DrawKind;
	/** New words were held back when this item was drawn. */
	throttled: boolean;
	/** Answers given before this item was drawn. */
	answered: number;
}

/** Drives a course like the game does: `ahead` items drawn beyond the one being answered. */
function drive(
	course: Course,
	answer: (q: Question, kind: DrawKind, index: number) => Result,
	limit: number,
	ahead = 0
): Drawn[] {
	const log: Drawn[] = [];
	const queue: { question: Question; kind: DrawKind; index: number }[] = [];
	let answered = 0;
	const fill = () => {
		while (queue.length <= ahead && log.length < limit) {
			const throttled = course.stats.throttled;
			const d = course.next();
			if (!d) break;
			// A word in flight is never drawn again.
			expect(queue.some((x) => x.question.lemma === d.question.lemma)).toBe(false);
			queue.push({ ...d, index: log.length });
			log.push({ lemma: d.question.lemma, id: d.question.id, kind: d.kind, throttled, answered });
		}
	};
	fill();
	while (queue.length) {
		const item = queue.shift()!;
		course.answer(item.question, answer(item.question, item.kind, item.index));
		answered++;
		fill();
	}
	return log;
}

const positions = (log: Drawn[], lemma: string) =>
	log.map((x, i) => (x.lemma === lemma ? i : -1)).filter((i) => i >= 0);

/** Takes a level test like the game does: `ahead` items drawn beyond the one being answered. */
function answerAll(placement: Placement, pick: (q: Question, i: number) => Result, ahead = 0): Question[] {
	const drawn: Question[] = [];
	const queue: Question[] = [];
	const fill = () => {
		while (queue.length <= ahead) {
			const q = placement.next();
			if (!q) break;
			queue.push(q);
			drawn.push(q);
		}
	};
	fill();
	while (queue.length) {
		const q = queue.shift()!;
		placement.answer(q, pick(q, drawn.indexOf(q)));
		fill();
	}
	return drawn;
}

const band = (q: Question) => bandOf(q.lemma);

describe('Course', () => {
	const seeded = (seed: number) => ({ random: mulberry(seed), now: () => NOW });

	it('brings a missed word back after 4 items in a new sentence, then after 20 more', () => {
		for (const ahead of [0, 2]) {
			const course = new Course(emptyLearner(), lex, questions, seeded(1));
			const log = drive(course, (_q, _k, i) => (i === 0 ? miss : good), 30, ahead);
			expect(positions(log, log[0].lemma)).toEqual([0, 5, 26]);
			expect(log[5].kind).toBe('relearn');
			expect(log[5].id).not.toBe(log[0].id);
			expect(log[26].id).not.toBe(log[5].id);
		}
	});

	it('checks a new word answered Hard once, 12 items later', () => {
		const course = new Course(emptyLearner(), lex, questions, seeded(2));
		const log = drive(course, (_q, _k, i) => (i === 0 ? hard : good), 30, 2);
		expect(positions(log, log[0].lemma)).toEqual([0, 13]);
		expect(log[13].kind).toBe('check');
	});

	it('verifies a fast first answer in a guessable band, and a fast check is Easy', () => {
		const state = withFirsts(PROFILE);
		const course = new Course(state, lex, questions, seeded(3));
		const log = drive(course, (_q, _k, i) => (i === 0 || i === 13 ? easy : good), 30, 2);
		const word = log[0].lemma;
		expect(bandOf(word)).toBe(3);
		expect(positions(log, word)).toEqual([0, 13]);
		expect(log[13].kind).toBe('check');
		expect(log[13].id).not.toBe(log[0].id);
		expect(state.log.filter((e) => e[0] === word).map((e) => e[2])).toEqual([3, 4]);
	});

	it('takes a fast first answer as known in a well-known band, without a check', () => {
		const state = withFirsts({ ...PROFILE, 3: [30, 30], 4: [30, 30], 5: [30, 30], 6: [30, 30] });
		const course = new Course(state, lex, questions, seeded(4));
		const log = drive(course, () => easy, 20, 2);
		expect(log.every((x) => fresh(x.kind))).toBe(true);
		expect(Object.values(state.cards).every((t) => t[7] === 4)).toBe(true);
	});

	it('stops at the daily quota until told to keep going', () => {
		const state = emptyLearner();
		const course = new Course(state, lex, questions, seeded(3));
		const log = drive(course, () => good, 500, 2);
		expect(log).toHaveLength(DEFAULT_DAILY_NEW);
		expect(log.every((x) => fresh(x.kind))).toBe(true);
		expect(course.next()).toBeNull();
		expect(course.stats).toMatchObject({ newToday: 30, quota: 30, due: 0, items: 30, correct: 30, done: true });

		course.keepGoing();
		expect(course.stats.done).toBe(false);
		expect(drive(course, () => good, 500, 2)).toHaveLength(KEEP_GOING_NEW);
		expect(course.stats).toMatchObject({ newToday: 50, quota: 50, done: true });
		expect(todayTally(state, NOW).newIntroduced).toBe(50);
	});

	it('takes the quota from the plan, minus what was introduced today', () => {
		const state = withFirsts(PROFILE);
		setPlan(state, { target: 200, days: 4, start: TODAY });
		state.days[TODAY] = [15, 0, 0, 0, 0, 0];
		const quota = planSummary(state, lex, NOW).dailyNew;
		expect(quota).toBeGreaterThan(15);
		const course = new Course(state, lex, questions, seeded(4));
		expect(drive(course, () => good, 500, 2)).toHaveLength(quota - 15);
		expect(course.stats).toMatchObject({ newToday: quota, quota, done: true });
	});

	it('serves due reviews by lowest recall first, two to each new word', () => {
		const state = emptyLearner();
		for (let i = 0; i < 20; i++) dueCard(state, `b1w${i}`, 2 + (i % 5), 1 + i);
		const course = new Course(state, lex, questions, seeded(5));
		expect(course.stats.due).toBe(20);
		const log = drive(course, () => good, 9);
		// The third new word of a session is a probe (see 'probes a band far above the frontier').
		expect(log.map((x) => x.kind)).toEqual(['review', 'review', 'new', 'review', 'review', 'new', 'review', 'review', 'probe']);
		// Recall falls with elapsed/stability: 2/1, 3/2, 4/3, 5/4 for b1w0..b1w3, below every other card.
		expect([log[0], log[1], log[3], log[4]].map((x) => x.lemma)).toEqual(['b1w0', 'b1w1', 'b1w2', 'b1w3']);
		expect(course.stats.due).toBe(14);
	});

	it('slows new words to one per four reviews with a backlog over 100', () => {
		const state = emptyLearner();
		for (let i = 0; i < 120; i++) dueCard(state, `b${1 + Math.floor(i / 40)}w${i % 40}`, 4);
		const log = drive(new Course(state, lex, questions, seeded(6)), () => good, 10);
		expect(log.map((x) => x.kind)).toEqual([
			'review',
			'review',
			'review',
			'review',
			'new',
			'review',
			'review',
			'review',
			'review',
			'new'
		]);
	});

	it('holds new words back below 80% on reviews and resumes at 86%', () => {
		const state = emptyLearner();
		for (let i = 0; i < 80; i++) dueCard(state, `b${1 + Math.floor(i / 40)}w${i % 40}`, 4);
		const course = new Course(state, lex, questions, seeded(7));
		let reviews = 0;
		/** Correctness of each answer that counts towards the throttle, in answer order. */
		const graded: boolean[] = [];
		/** Per answer: whether it counts (not a first encounter, nor the first return after a miss). */
		const counted: boolean[] = [];
		const missed = new Set<string>();
		const log = drive(
			course,
			(q, kind) => {
				const right = !(kind === 'review' && reviews++ < 12);
				const counts = !fresh(kind) && !missed.has(q.lemma);
				counted.push(counts);
				if (counts) graded.push(right);
				if (right) missed.delete(q.lemma);
				else missed.add(q.lemma);
				return right ? good : miss;
			},
			90,
			2
		);
		const rolling = (answered: number) => {
			const window = graded.slice(0, counted.slice(0, answered).filter(Boolean).length).slice(-20);
			return { n: window.length, accuracy: window.filter(Boolean).length / window.length };
		};
		const start = log.findIndex((x) => x.throttled);
		const end = log.findIndex((x, i) => i > start && !x.throttled);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		expect(log.slice(0, start).some((x) => x.kind === 'new')).toBe(true);
		expect(rolling(log[start].answered)).toMatchObject({ n: 10 });
		expect(rolling(log[start].answered).accuracy).toBeLessThan(0.8);
		for (const x of log.slice(start, end)) expect(fresh(x.kind)).toBe(false);
		expect(rolling(log[end - 1].answered).accuracy).toBeLessThan(0.86);
		expect(rolling(log[end].answered).accuracy).toBeGreaterThanOrEqual(0.86);
		expect(log.slice(end).some((x) => x.kind === 'new')).toBe(true);
	});

	it('does not let missed first encounters throttle new words', () => {
		const course = new Course(emptyLearner(), lex, questions, seeded(8));
		const log = drive(course, (_q, kind) => (kind === 'new' ? miss : good), 80, 2);
		expect(log.some((x) => x.throttled)).toBe(false);
		expect(log.filter((x) => fresh(x.kind))).toHaveLength(DEFAULT_DAILY_NEW);
	});

	it('does not count the return right after a miss towards the throttle', () => {
		// Two of the first ten reviews missed is 80%, not below it. Missing each word's first
		// return as well would make it 4 of 12 if those returns counted.
		const state = emptyLearner();
		for (let i = 0; i < 40; i++) dueCard(state, `b${1 + Math.floor(i / 20)}w${i % 20}`, 4);
		const course = new Course(state, lex, questions, seeded(16));
		let reviews = 0;
		const returned = new Set<string>();
		const log = drive(
			course,
			(q, kind) => {
				if (kind === 'review') return [1, 4].includes(reviews++) ? miss : good;
				if (kind === 'relearn' && !returned.has(q.lemma)) {
					returned.add(q.lemma);
					return miss;
				}
				return good;
			},
			60,
			2
		);
		expect(log.filter((x) => x.kind === 'relearn').length).toBeGreaterThanOrEqual(4);
		expect(log.some((x) => x.throttled)).toBe(false);
	});

	it('turns to easier words below the frontier when struggling with nothing due', () => {
		// Four of fourteen reviews missed: the reviews run out while new words are held back.
		// New words are answered Hard, so their checks bring the accuracy back up.
		const state = withFirsts(PROFILE);
		for (let i = 0; i < 14; i++) dueCard(state, `b1w${i}`, 4);
		const course = new Course(state, lex, questions, seeded(12));
		let reviews = 0;
		const log = drive(
			course,
			(_q, kind) => (kind === 'review' && reviews++ < 4 ? miss : kind === 'new' ? hard : good),
			60,
			2
		);
		const throttledNew = log.filter((x) => x.throttled && x.kind === 'new');
		expect(throttledNew.length).toBeGreaterThan(0);
		for (const x of throttledNew) expect(bandOf(x.lemma)).toBeLessThan(3);
		const end = log.findLastIndex((x) => x.throttled);
		expect(log.slice(end + 1).some((x) => x.kind === 'new' && bandOf(x.lemma) >= 3)).toBe(true);
	});

	it('never repeats a word within 3 items and only draws words with sentences', () => {
		const missing = (w: string) => w.endsWith('w3') || w.endsWith('w7');
		const data = fixture({ skip: missing });
		const state = emptyLearner();
		for (let i = 0; i < 30; i++) dueCard(state, `b2w${i}`, 3);
		const random = mulberry(8);
		const course = new Course(state, data.lex, data.questions, { random: mulberry(9), now: () => NOW });
		const log = drive(course, () => (random() < 0.7 ? good : miss), 70, 2);
		expect(log).toHaveLength(70);
		for (let i = 0; i < log.length; i++) {
			expect(missing(log[i].lemma)).toBe(false);
			for (let j = Math.max(0, i - 3); j < i; j++) expect(log[j].lemma).not.toBe(log[i].lemma);
		}
	});

	it('fills gaps below the frontier and climbs with it', () => {
		const state = withFirsts(PROFILE);
		const course = new Course(state, lex, questions, seeded(10));
		const log = drive(course, () => good, 30, 2);
		const bands = log.map((x) => bandOf(x.lemma));
		expect(bands[0]).toBe(3);
		expect(bands.filter((b) => b < 3).length).toBeGreaterThanOrEqual(2);
		expect(bands.filter((b) => b < 3).length).toBeLessThanOrEqual(4);
	});

	it("keeps today's estimate snapshot current after every answer", () => {
		const state = withFirsts(PROFILE);
		for (let i = 0; i < 30; i++) dueCard(state, `b${1 + (i % 3)}w${i}`, 2 + (i % 4));
		let clock = NOW;
		const course = new Course(state, lex, questions, { random: mulberry(14), now: () => clock });
		const random = mulberry(15);
		for (let i = 0; i < 60; i++) {
			const d = course.next();
			if (!d) break;
			course.answer(d.question, random() < 0.8 ? good : miss);
			expect(Math.abs(state.days[TODAY][4] - estimateVocabulary(state, lex, clock))).toBeLessThanOrEqual(1);
			clock += 5500;
		}
	});

	it("never brings a word straight back: a lone step waits for the card's again-delay", () => {
		// The last new word of the day, missed, with nothing else left: asking it again at once
		// would only test whether the answer is still on screen.
		const state = emptyLearner();
		state.days[TODAY] = [DEFAULT_DAILY_NEW - 1, 0, 0, 0, 0, 0];
		const course = new Course(state, lex, questions, seeded(11));
		const log = drive(course, (_q, _k, i) => (i === 0 ? miss : good), 20, 2);
		expect(log.map((x) => x.kind)).toEqual(['new']);
		expect(course.stats.done).toBe(true);
		expect(state.cards[log[0].lemma][3]).toBe(Math.floor(NOW / 1000) + AGAIN_DELAY_SEC);
		// With another word in between, the miss comes back once before the session ends.
		const other = emptyLearner();
		other.days[TODAY] = [DEFAULT_DAILY_NEW - 2, 0, 0, 0, 0, 0];
		const next = new Course(other, lex, questions, seeded(11));
		const two = drive(next, (_q, _k, i) => (i === 0 ? miss : good), 20, 2);
		expect(two.map((x) => x.kind)).toEqual(['new', 'new', 'relearn']);
		expect(two[2].lemma).toBe(two[0].lemma);
		expect(next.stats.done).toBe(true);
	});

	it('without the level test, climbs from the most common words a band at a time', () => {
		// Under the prior alone, one right answer in band 1 would put the frontier at band 6 or so.
		const state = emptyLearner();
		const course = new Course(state, big.lex, big.questions, seeded(21));
		course.keepGoing();
		course.keepGoing();
		const log = drive(course, () => good, 70);
		const answered = new Array<number>(20).fill(0);
		let top = 0;
		for (const x of log) {
			const b = bandOf(x.lemma);
			if (x.kind === 'new') {
				// Bands climbed: from band 1 on, each with five first answers.
				let climbed = 0;
				while (answered[climbed + 1] >= 5) climbed++;
				expect(b).toBeLessThanOrEqual(climbed + 1);
				top = Math.max(top, b);
			}
			answered[b]++;
		}
		expect(bandOf(log[0].lemma)).toBe(1);
		expect(top).toBeGreaterThanOrEqual(5);
	});

	it('probes a band far above the frontier now and then, and drills no missed probe', () => {
		const state = withFirsts(PROFILE);
		const course = new Course(state, lex, questions, seeded(22));
		course.keepGoing();
		const log = drive(course, (_q, kind) => (kind === 'probe' ? miss : good), 60, 2);
		const probes = log.filter((x) => x.kind === 'probe');
		// The third new word, then one in 25.
		expect(probes).toHaveLength(2);
		for (const x of probes) {
			// The frontier is band 3: probes come from band 6, the only one three above it.
			expect(bandOf(x.lemma)).toBe(6);
			expect(state.cards[x.lemma]).toBeUndefined();
			expect(state.met[x.lemma]).toBe(1);
			expect(positions(log, x.lemma)).toHaveLength(1);
		}
		expect(state.firsts['6'].slice(0, 2)).toEqual([32, 7]);
		// A probe is one of the day's new words.
		expect(todayTally(state, NOW).newIntroduced).toBe(log.filter((x) => fresh(x.kind)).length);
	});

	it("keeps the day's quota however the day's answers move the estimate", () => {
		const state = withFirsts(PROFILE);
		setPlan(state, { target: 200, days: 10, start: TODAY });
		const first = new Course(state, lex, questions, seeded(23));
		const quota = first.stats.quota;
		const before = estimateVocabulary(state, lex, NOW);
		drive(first, (_q, _k, i) => (i % 3 ? good : miss), 25, 2);
		expect(estimateVocabulary(state, lex, NOW)).not.toBe(before);
		// Leaving learn mode and coming back, the menu and the plan page: all the same figure.
		expect(new Course(state, lex, questions, seeded(24)).stats.quota).toBe(quota);
		expect(planSummary(state, lex, NOW).dailyNew).toBe(quota);
		expect(state.days[TODAY][5]).toBe(quota);
	});

	it('keeps confusable new words twenty draws apart', () => {
		// Each word's sentences offer its partner (w0↔w1, w2↔w3, …) as a distractor.
		const partner = (word: string) => word.replace(/w(\d+)$/, (_, i) => `w${Number(i) ^ 1}`);
		const data = fixture({ perBand: 80, distractors: (word) => [partner(word), 'x', 'y'] });
		for (let seed = 1; seed <= 5; seed++) {
			const course = new Course(emptyLearner(), data.lex, data.questions, { random: mulberry(seed), now: () => NOW });
			const log = drive(course, () => good, 30, 2);
			for (let i = 0; i < log.length; i++) {
				for (let j = i + 1; j < Math.min(log.length, i + 21); j++) expect(log[j].lemma).not.toBe(partner(log[i].lemma));
			}
		}
	});

	it('prefers sentences whose distractors are not words still being learned', () => {
		const data = fixture({ distractors: (word, k) => (word === 'b1w0' && k === 0 ? ['b1w1', 'x', 'y'] : ['x', 'y', 'z']) });
		for (let seed = 1; seed <= 8; seed++) {
			const state = emptyLearner();
			dueCard(state, 'b1w0', 3);
			state.cards.b1w1 = packCard(newCard(1, NOW / 1000));
			const course = new Course(state, data.lex, data.questions, { random: mulberry(seed), now: () => NOW });
			expect(course.next()?.question.id).toBe('b1w0#1');
		}
	});

	it('starts a new day at local midnight in mid-session', () => {
		const midnight = new Date(2026, 10, 7).getTime();
		let clock = midnight - 60_000;
		const state = emptyLearner();
		const course = new Course(state, lex, questions, { random: mulberry(17), now: () => clock });
		course.keepGoing();
		expect(drive(course, () => good, 20).every((x) => fresh(x.kind))).toBe(true);
		clock = midnight + 60_000;
		// A fresh quota for the new day; the evening's keep-going extension does not carry over.
		expect(course.stats).toMatchObject({ newToday: 0, quota: DEFAULT_DAILY_NEW, done: false });
		expect(drive(course, () => good, 500)).toHaveLength(DEFAULT_DAILY_NEW);
		expect(todayTally(state, midnight - 60_000).newIntroduced).toBe(20);
		expect(todayTally(state, clock).newIntroduced).toBe(DEFAULT_DAILY_NEW);
		const snapshot = state.days[dayKey(new Date(clock))][4];
		expect(Math.abs(snapshot - estimateVocabulary(state, lex, clock))).toBeLessThanOrEqual(1);
	});

	it('ends once every word has been met and nothing is due', () => {
		const small = fixture({ bands: 2, perBand: 3 });
		const state = emptyLearner();
		const course = new Course(state, small.lex, small.questions, seeded(18));
		expect(drive(course, () => good, 100, 2)).toHaveLength(6);
		expect(course.next()).toBeNull();
		expect(course.stats).toMatchObject({ newToday: 6, due: 0, done: true });
		expect(Object.keys(state.cards)).toHaveLength(6);
	});

	it('has nothing to draw without questions', () => {
		const state = withFirsts(PROFILE);
		dueCard(state, 'b1w0', 3);
		const course = new Course(state, lex, [], seeded(19));
		expect(course.next()).toBeNull();
		expect(course.stats).toMatchObject({ due: 0, items: 0, accuracy: null, done: true });
	});

	it("rotates a word's sentences, avoiding its last two, the log included", () => {
		const data = fixture({ sentences: 3 });
		const state = emptyLearner();
		dueCard(state, 'b1w0', 3);
		const sec = Math.floor(NOW / 1000);
		state.log.push(['b1w0', sec - 2 * 86_400, 3, 2500, 'b1w0#0', 0, 3.2], ['b1w0', sec - 86_400, 3, 2500, 'b1w0#1', 0, 5]);
		const course = new Course(state, data.lex, data.questions, seeded(13));
		const log = drive(course, (_q, _k, i) => (i === 0 ? miss : good), 30, 2);
		expect(log.filter((x) => x.lemma === 'b1w0').map((x) => x.id)).toEqual(['b1w0#2', 'b1w0#0', 'b1w0#1']);
	});
});

describe('Placement', () => {
	const perBandCounts = (drawn: Question[]) => {
		const counts = new Map<number, number>();
		for (const q of drawn) counts.set(band(q), (counts.get(band(q)) ?? 0) + 1);
		return [...counts.values()];
	};

	it('sweeps every other band, then stops a small bank once it is measured precisely', () => {
		const placement = new Placement(lex, questions, { random: mulberry(1) });
		// Five items for each of six bands at most.
		expect(placement.progress).toEqual({ asked: 0, expected: 30 });
		const drawn = answerAll(placement, (q) => (band(q) <= 3 ? good : miss));
		expect(drawn.slice(0, 3).map(band)).toEqual([1, 3, 5]);
		// Six bands of 40 words never leave 700 words of doubt: the test ends at its 20-item minimum.
		expect(drawn).toHaveLength(20);
		expect(new Set(drawn.map((q) => q.lemma)).size).toBe(20);
		for (const n of perBandCounts(drawn)) expect(n).toBeLessThanOrEqual(5);
		// Each band's typical difficulty is its own number (capped at 5): no harder sentence is used.
		for (const q of drawn) expect(q.difficulty).toBeLessThanOrEqual(Math.min(5, band(q)));
		expect(placement.done).toBe(true);
		expect(placement.next()).toBeNull();
		expect(placement.progress).toEqual({ asked: 20, expected: 20 });
	});

	it('asks where the answer is least predictable', () => {
		const placement = new Placement(big.lex, big.questions, { random: mulberry(2) });
		const drawn = answerAll(placement, (q) => (band(q) <= 8 ? good : miss));
		expect(drawn.slice(0, 9).map(band)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17]);
		const adaptive = drawn.slice(9).map(band);
		const near = adaptive.filter((b) => b >= 7 && b <= 11).length;
		expect(near / adaptive.length).toBeGreaterThan(0.6);
	});

	it('runs 20 to 40 items, at most five a band, with up to two items of lookahead', () => {
		const random = mulberry(4);
		for (let trial = 0; trial < 12; trial++) {
			const placement = new Placement(big.lex, big.questions, { random: mulberry(trial) });
			const skill = 1 + random() * 17;
			const ahead = trial % 3;
			const drawn = answerAll(placement, (q) => (band(q) < skill || random() < 0.25 ? good : miss), ahead);
			expect(drawn.length).toBeGreaterThanOrEqual(20);
			expect(drawn.length).toBeLessThanOrEqual(40);
			expect(new Set(drawn.map((q) => q.lemma)).size).toBe(drawn.length);
			for (const n of perBandCounts(drawn)) expect(n).toBeLessThanOrEqual(5);
			expect(placement.done).toBe(true);
			expect(placement.progress.asked).toBe(drawn.length);
		}
	});

	it('never asks more than 40 items, however many bands the bank has', () => {
		// Ninety bands: the opening sweep alone would ask 45.
		const wide = fixture({ bands: 90, perBand: 2, sentences: 1 });
		const placement = new Placement(wide.lex, wide.questions, { random: mulberry(7) });
		expect(answerAll(placement, () => good, 2)).toHaveLength(40);
		expect(placement.done).toBe(true);
		expect(placement.progress).toEqual({ asked: 40, expected: 40 });
	});

	it('skips words the learner has already met while others are left', () => {
		const state = emptyLearner();
		for (let i = 0; i < PER_BAND - 2; i++) state.cards[`b1w${i}`] = packCard(newCard(3, NOW / 1000));
		state.met[`b1w${PER_BAND - 2}`] = 1;
		const placement = new Placement(lex, questions, { random: mulberry(5), state });
		const drawn = answerAll(placement, () => good);
		const firstBand = drawn.filter((q) => band(q) === 1).map((q) => q.lemma);
		expect(firstBand[0]).toBe(`b1w${PER_BAND - 1}`);
	});

	it('writes the result: first encounters, cards for correct answers only, the log', () => {
		let clock = NOW;
		const placement = new Placement(lex, questions, { random: mulberry(5), now: () => clock });
		const drawn = answerAll(placement, (q) => {
			clock += 4000;
			return band(q) <= 3 ? good : miss;
		});
		const state = emptyLearner();
		const result = placement.finish(state, clock);
		const right = drawn.filter((q) => band(q) <= 3).map((q) => q.lemma);
		const wrong = drawn.filter((q) => band(q) > 3).map((q) => q.lemma);
		expect(Object.keys(state.cards).sort()).toEqual([...right].sort());
		expect(Object.keys(state.met).sort()).toEqual([...wrong].sort());
		const firsts = Object.values(state.firsts).reduce((sum, [n, c]) => [sum[0] + n, sum[1] + c], [0, 0]);
		expect(firsts).toEqual([drawn.length, right.length]);
		expect(state.log.map((e) => e[4])).toEqual(drawn.map((q) => q.id));
		expect(state.log[0][1]).toBe(Math.floor((NOW + 4000) / 1000));
		expect(state.placement).toEqual({ at: clock, estimate: result.estimate, perBand: result.perBand });
		expect(estimateReady(state)).toBe(true);
		expect(result.perBand.map((p) => Math.round(p * 1000) / 1000)).toEqual(result.perBand);
		expect(result.perBand[0]).toBeGreaterThan(0.9);
		expect(result.perBand[5]).toBeLessThan(0.1);
		// The edge lies between bands 3 and 4; the frontier is the first band below p = 0.8.
		expect([3, 4]).toContain(frontierBand(state, lex));
		expect(frontierBand(state, lex)).toBe(result.perBand.findIndex((p) => p < 0.8) + 1);
		expect(result.estimate).toBe(estimateVocabulary(state, lex, clock));
		expect(result.estimate).toBeGreaterThan(100);
		expect(result.estimate).toBeLessThan(140);
		expect(result.low).toBeLessThanOrEqual(result.estimate);
		expect(result.high).toBeGreaterThanOrEqual(result.estimate);
		expect(state.days[TODAY][4]).toBe(result.estimate);
		// Not learn mode: nothing in the day's tally, but the test is where today's plan starts.
		expect(todayTally(state, clock)).toEqual({ newIntroduced: 0, reviews: 0, correct: 0, answerMs: 0 });
		expect(state.morning).toMatchObject({ day: TODAY, estimate: result.estimate, frontier: frontierBand(state, lex) });
		// Finishing twice changes nothing.
		const before = structuredClone(state);
		expect(placement.finish(state, clock + 1000)).toBe(result);
		expect(state).toEqual(before);
	});

	it('makes cards only where a correct answer is unlikely to be a guess', () => {
		const placement = new Placement(lex, questions, { random: mulberry(5) });
		let lucky = '';
		answerAll(placement, (q) => {
			if (band(q) <= 3) return good;
			if (band(q) === 5 && !lucky) {
				lucky = q.lemma;
				return good;
			}
			return miss;
		});
		const state = emptyLearner();
		const { perBand } = placement.finish(state, NOW);
		expect(perBand[4]).toBeLessThan(0.5);
		// The right answer counts as evidence; the word waits for learn mode.
		expect(state.cards[lucky]).toBeUndefined();
		expect(state.met[lucky]).toBe(1);
		expect(state.firsts['5'][1]).toBe(1);
	});

	it('grades its fast answers like any first encounter', () => {
		const placement = new Placement(lex, questions, { random: mulberry(6) });
		answerAll(placement, (q) => (band(q) <= 2 ? easy : band(q) === 3 ? (q.lemma.length % 2 ? easy : miss) : miss));
		const state = emptyLearner();
		const { perBand } = placement.finish(state, NOW);
		for (const [lemma, t] of Object.entries(state.cards)) {
			expect(t[7]).toBe(perBand[bandOf(lemma) - 1] >= 0.9 ? 4 : 3);
		}
		expect(Object.values(state.cards).some((t) => t[7] === 4)).toBe(true);
		expect(Object.values(state.cards).some((t) => t[7] === 3)).toBe(true);
	});

	it('estimates vocabulary size within ±1,500 words for most simulated learners', () => {
		const errors: number[] = [];
		for (const size of [3000, 6000, 10000]) {
			for (const slope of [0.7, 1, 1.5]) {
				for (let seed = 1; seed <= 3; seed++) {
					const random = mulberry(size + seed * 31 + slope * 1000);
					const known = (b: number) => 1 / (1 + Math.exp(-slope * (size / 1000 + 0.5 - b)));
					let truth = 0;
					for (let b = 1; b <= 18; b++) truth += 1000 * known(b);
					const placement = new Placement(big.lex, big.questions, { random: mulberry(seed), now: () => NOW });
					answerAll(placement, (q) => (random() < known(band(q)) || random() < 0.25 ? good : miss), seed % 3);
					errors.push(placement.finish(emptyLearner(), NOW).estimate - truth);
				}
			}
		}
		const within = errors.filter((e) => Math.abs(e) <= 1500).length / errors.length;
		expect(within).toBeGreaterThanOrEqual(0.8);
		const meanAbs = errors.reduce((sum, e) => sum + Math.abs(e), 0) / errors.length;
		expect(meanAbs).toBeLessThan(1000);
	});
});

describe('persistence', () => {
	afterEach(() => vi.unstubAllGlobals());

	function memoryStorage() {
		const store = new Map<string, string>();
		return {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k)
		};
	}

	it('round-trips the learner through localStorage', () => {
		vi.stubGlobal('localStorage', memoryStorage());
		expect(loadLearner()).toEqual(emptyLearner());
		const s = withFirsts(PROFILE);
		s.placement = { at: NOW, estimate: 100, perBand: [1, 0.9, 0.5, 0.1, 0, 0] };
		setPlan(s, defaultPlan(80, TODAY));
		recordAnswer(s, info('b1w0'), good, { ...learn, questionId: 'b1w0#0' });
		saveLearner(s);
		expect(loadLearner()).toEqual(s);
	});

	it('loads a state saved before the review log with an empty one, and drops malformed entries', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		const card = packCard(newCard(3, NOW / 1000));
		storage.setItem(LEARN_KEY, JSON.stringify({ v: 1, cards: { b1w0: card }, firsts: { 1: [1, 1] }, placement: null, plan: null, days: {} }));
		// Evidence from before positions were kept counts as spread over the band.
		expect(loadLearner()).toEqual({ ...emptyLearner(), cards: { b1w0: card }, firsts: { 1: [1, 1, 0.5] } });
		const entry: LogEntry = ['b1w0', 1, 3, 2000, 'q', 0, 0];
		storage.setItem(LEARN_KEY, JSON.stringify({ v: 1, log: [entry, ['short'], 'x', null] }));
		expect(loadLearner().log).toEqual([entry]);
	});

	it('drops malformed cards, evidence and days on loading rather than fail later', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		const card = packCard(newCard(3, NOW / 1000));
		const tally: DayTally = [1, 2, 3, 4000, 120, 30];
		storage.setItem(
			LEARN_KEY,
			JSON.stringify({
				v: 1,
				cards: { b1w0: card, b1w1: [0, 5, 1, 2, 1, 0, 1, 3], b1w2: 'x', b1w3: [1, 2], b1w4: null },
				firsts: { 1: [4, 3, 1.25], 2: null, 3: ['a', 1], x: [2, 2], 1e9: [1, 1] },
				scoredFirsts: { 2: [3, 1, 1], 4: [1, 1, 1, 1] },
				met: { b2w0: 1, b2w1: true },
				morning: { day: TODAY, estimate: 120, sure: 100, frontier: 3, p: [1, 0.5], unseen: [40] },
				placement: { at: 'yesterday', perBand: [] },
				days: { [TODAY]: tally, '2026-11-05': [1], '2026-11-04': [1, 2, 3, 4000, 110], someday: tally }
			})
		);
		const loaded = loadLearner();
		expect(loaded).toEqual({
			...emptyLearner(),
			cards: { b1w0: card },
			firsts: { 1: [4, 3, 1.25] },
			scoredFirsts: { 2: [3, 1, 1] },
			met: { b2w0: 1 },
			// Tallies from before the quota slot get an empty one.
			days: { [TODAY]: tally, '2026-11-04': [1, 2, 3, 4000, 110, 0] }
		});
		expect(estimateReady(loaded)).toBe(false);
		expect(estimateVocabulary(loaded, lex, NOW)).toBeGreaterThan(0);
		expect(wordStatus(loaded, 'b1w2')).toBe('new');
		expect(dueCount(loaded, NOW + 4 * DAY_MS)).toBe(1);
	});

	it('starts fresh on missing, corrupt or foreign data', () => {
		expect(loadLearner()).toEqual(emptyLearner());
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		storage.setItem(LEARN_KEY, '{oops');
		expect(loadLearner()).toEqual(emptyLearner());
		storage.setItem(LEARN_KEY, JSON.stringify({ v: 2, cards: { a: [1] } }));
		expect(loadLearner()).toEqual(emptyLearner());
		storage.setItem(LEARN_KEY, JSON.stringify({ v: 1, cards: [], plan: { target: 1, days: 1, start: 'x' } }));
		expect(loadLearner()).toEqual(emptyLearner());
	});

	it('defaults the new settings, glossing in both languages for Chinese browsers', () => {
		vi.stubGlobal('navigator', { language: 'en-US' });
		expect(loadSettings()).toMatchObject({ gloss: 'en', speak: false, studyPause: true, sound: false });
		vi.stubGlobal('navigator', { language: 'zh-TW' });
		expect(loadSettings().gloss).toBe('both');
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		storage.setItem('lexical-flow:settings:v1', JSON.stringify({ sound: true, gloss: 'zh' }));
		expect(loadSettings()).toMatchObject({ sound: true, gloss: 'zh', speak: false, studyPause: true, level: 'medium' });
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
