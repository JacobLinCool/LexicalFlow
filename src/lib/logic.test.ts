import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bank } from './data';
import { Deck } from './deck';
import {
	Game,
	STUDY_MS,
	doneSummary,
	glossMeanings,
	likelyRange,
	missedIntroductions,
	paceLine,
	readingMs,
	studyMs,
	wantsStudy,
	type Phase
} from './game.svelte';
import { LEARN_KEY, emptyLearner, type LearnerState, type PlanSummary } from './learner';
import { MODES, damage, heal, hpDelta } from './modes';
import { averageMs, emptyProgress, record, recordBest, type Progress } from './progress';
import { score } from './scoring';
import { silence, speak } from './speech';
import { newCard, packCard } from './srs';
import { DIRECTIONS, type BankManifest, type Question, type WordInfo } from './types';

// Speech is a browser API; the game's use of it is checked through these stand-ins.
vi.mock('./speech', () => ({ primeSpeech: vi.fn(), silence: vi.fn(), speak: vi.fn() }));

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
	it('decays linearly to zero at eight seconds', () => {
		expect(score(true, 4500)).toBe(50);
		expect(score(true, 2400)).toBe(80);
		expect(score(true, 7999)).toBe(0);
		expect(score(true, 8000)).toBe(0);
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
	it('counts each Chinese character as a word and skips lone punctuation', () => {
		expect(readingMs('文明；教化')).toBe(800);
		expect(readingMs('創造力 creativity — the ability to create')).toBe(1600);
	});
});

describe('menu modes', () => {
	it('puts one mode on each direction, with Learn on top', () => {
		expect(MODES.map((m) => m.direction).sort()).toEqual([...DIRECTIONS].sort());
		expect(MODES.find((m) => m.direction === 'up')?.id).toBe('learn');
		expect(MODES.some((m) => m.id === 'practice')).toBe(false);
	});
	it('gives Learn no limit or HP, so it never ends as a scored run', () => {
		const learn = MODES.find((m) => m.id === 'learn');
		expect(learn).toMatchObject({ limit: null, hp: false });
	});
});

describe('glosses', () => {
	const word: WordInfo = {
		word: 'civilization',
		pos: 'n',
		zipf: 4.01,
		rank: 4001,
		band: 5,
		ipa: 'siˌvilaiˈzeiʃən',
		en: 'a society in an advanced state of social development',
		zh: '文明；教化'
	};

	it('shows the meanings the setting asks for', () => {
		expect(glossMeanings(word, 'both')).toEqual({ zh: word.zh, en: word.en });
		expect(glossMeanings(word, 'en')).toEqual({ zh: '', en: word.en });
		expect(glossMeanings(word, 'zh')).toEqual({ zh: word.zh, en: '' });
	});
	it('falls back to the other language when one is missing', () => {
		expect(glossMeanings({ ...word, zh: '' }, 'zh')).toEqual({ zh: '', en: word.en });
		expect(glossMeanings({ ...word, en: '' }, 'en')).toEqual({ zh: word.zh, en: '' });
	});
	it('pauses for the reading time of what is shown, within bounds', () => {
		// 4 characters + the word + 9 words of definition = 14 words at 200 ms.
		expect(studyMs(word, 'both')).toBe(2800);
		expect(studyMs(word, 'zh')).toBe(STUDY_MS.min);
		const long = { ...word, en: Array(40).fill('word').join(' ') };
		expect(studyMs(long, 'en')).toBe(STUDY_MS.max);
	});
});

describe('study pause', () => {
	it('stops on a miss or a timeout, and on a first meeting answered slowly', () => {
		expect(wantsStudy('incorrect', { firstEncounter: false, grade: 1 })).toBe(true);
		expect(wantsStudy('timeout', null)).toBe(true);
		expect(wantsStudy('correct', { firstEncounter: true, grade: 2 })).toBe(true);
	});
	it('lets quick first answers and reviews of known words flow on', () => {
		// Grade 3 also covers a fast answer held at Good for a later check.
		expect(wantsStudy('correct', { firstEncounter: true, grade: 3 })).toBe(false);
		expect(wantsStudy('correct', { firstEncounter: true, grade: 4 })).toBe(false);
		expect(wantsStudy('correct', { firstEncounter: false, grade: 2 })).toBe(false);
		expect(wantsStudy('correct', null)).toBe(false);
	});
});

describe('level test result', () => {
	it('rounds the likely range outward and keeps the shown estimate inside it', () => {
		// A word joiner follows the dash, so the range never breaks across lines.
		expect(likelyRange(4730, 7340, 5900)).toBe('4,700–\u20607,400');
		expect(likelyRange(812, 1004, 900)).toBe('810–\u20601,010');
		expect(likelyRange(5850, 6200, 5800)).toBe('5,800–\u20606,200');
	});

	const summary = (over: Partial<PlanSummary>): PlanSummary => ({
		plan: { target: 8000, days: 30, start: '2026-11-06' },
		estimate: 5900,
		daysLeft: 30,
		dailyGain: 40,
		dailyNew: 120,
		minutes: 45,
		finish: '2026-12-05',
		deadline: '2026-12-06',
		reached: false,
		expired: false,
		onTrack: true,
		...over
	});

	it('names the words new to the learner when introductions are mostly known ones', () => {
		expect(paceLine(summary({}))).toBe('goal 8,000 in 30 days · ≈ 120 words a day, about 40 new to you · ~45 min');
		expect(paceLine(summary({ dailyNew: 34, dailyGain: 33, minutes: 20 }))).toBe(
			'goal 8,000 in 30 days · ≈ 34 new words a day · ~20 min'
		);
	});
	it('calls a heavy pace intensive and an unreachable one what it is', () => {
		expect(paceLine(summary({ dailyNew: 140, dailyGain: 70, minutes: 82 }))).toMatch(/· an intensive pace$/);
		expect(paceLine(summary({ minutes: 61 }))).toMatch(/· an intensive pace$/);
		expect(paceLine(summary({ dailyNew: 150, dailyGain: 38, minutes: 88, finish: '2027-01-02' }))).toBe(
			'goal 8,000 in 30 days needs more than the 150 words a day the course allows'
		);
	});
	it('says when the goal is reached, and nothing without a plan', () => {
		expect(paceLine(summary({ dailyNew: 0, dailyGain: 0, reached: true }))).toBe('goal 8,000 reached');
		expect(paceLine(summary({ plan: null }))).toBe('');
	});
	it('keeps a steady pace for a plan past its deadline', () => {
		expect(
			paceLine(summary({ expired: true, daysLeft: 0, dailyNew: 30, dailyGain: 12, minutes: 13, finish: '2027-02-01' }))
		).toBe('goal 8,000, past its deadline · ≈ 30 words a day, about 12 new to you · ~13 min');
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

describe('done card', () => {
	it('splits the new words into ones the learner knew and ones new to them', () => {
		expect(doneSummary({ introduced: 38, missed: 26, answers: 120, correct: 107 }, 6200)).toBe(
			'+38 words today: 12 you knew, 26 new to you\n120 answers, 89% right · ≈\u00a06,200\u00a0words'
		);
		expect(doneSummary({ introduced: 5, missed: 5, answers: 9, correct: 6 }, null)).toBe(
			'+5 new words today\n9 answers, 67% right'
		);
		expect(doneSummary({ introduced: 4, missed: 0, answers: 4, correct: 4 }, null)).toBe(
			'+4 words today, all known already\n4 answers, 100% right'
		);
	});
	it('says nothing of answers no learning produced, e.g. right after a level test', () => {
		expect(doneSummary({ introduced: 0, missed: 0, answers: 0, correct: 0 }, 6200)).toBe('≈\u00a06,200\u00a0words');
	});

	it('counts as new to the learner only words first met today and missed', () => {
		const now = new Date(2026, 10, 6, 10, 0, 0).getTime();
		const sec = now / 1000;
		const state: LearnerState = {
			...emptyLearner(),
			cards: {
				missedToday: packCard(newCard(1, sec - 3600)),
				knownToday: packCard(newCard(3, sec - 60)),
				missedYesterday: packCard(newCard(1, sec - 86_400))
			}
		};
		expect(missedIntroductions(state, now)).toBe(1);
	});
});

const PROGRESS_KEY = 'lexical-flow:progress:v1';
const SETTINGS_KEY = 'lexical-flow:settings:v1';

function memoryStorage() {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	};
}

/** Words b<band>w<i> with two sentences each, the answer always up. */
function smallBank(bands = 3, perBand = 20, band = (b: number) => b): Bank {
	const words = new Map<string, WordInfo>();
	const byRank: WordInfo[] = [];
	const questions: Question[] = [];
	for (let b = 1; b <= bands; b++) {
		for (let i = 0; i < perBand; i++) {
			const word = `b${b}w${i}`;
			const info: WordInfo = { word, pos: 'n', zipf: 6 - b, rank: byRank.length + 1, band: band(b), ipa: '', en: `a ${word}`, zh: '' };
			words.set(word, info);
			byRank.push(info);
			for (let k = 0; k < 2; k++) {
				questions.push({
					id: `${word}.${k}`,
					sentence: 'A ___ b.',
					choices: { up: word, left: 'x', down: 'y', right: 'z' },
					answer: 'up',
					category: 'travel',
					difficulty: b,
					lemma: word
				});
			}
		}
	}
	return { questions, lexicon: { words, byRank, bandSize: perBand, bands }, manifest: {} as BankManifest };
}

describe('Game', () => {
	let storage: ReturnType<typeof memoryStorage>;
	const bank = smallBank();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
		storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		vi.mocked(speak).mockClear();
		vi.mocked(silence).mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function loaded(questions = bank.questions): Game {
		const game = new Game();
		game.load(questions, { id: 'all', label: 'All topics' }, bank);
		return game;
	}

	/** Run the clock until `game` reaches `phase`. */
	function until(game: Game, phase: Phase, limit = 30_000): void {
		for (let t = 0; game.phase !== phase; t += 10) {
			if (t > limit) throw new Error(`stuck in '${game.phase}' waiting for '${phase}'`);
			vi.advanceTimersByTime(10);
		}
	}

	/** Answer the question on screen right, or wrong, and wait for the next one. */
	function answer(game: Game, right = true): void {
		const question = game.line?.question;
		if (!question) throw new Error('no question on screen');
		game.press(right ? question.answer : 'left');
		until(game, 'active');
	}

	function quick(game: Game): void {
		game.press('left');
		until(game, 'active');
	}

	const saved = <T>(key: string): T | null => JSON.parse(storage.getItem(key) ?? 'null');

	it('stops the clock while the page is away, and asks the question afresh on return', () => {
		const game = loaded();
		quick(game);
		const question = game.line?.question;
		game.pause();
		expect(game.phase).toBe('idle');
		vi.advanceTimersByTime(20_000);
		expect(game.phase).toBe('idle');
		expect(game.line?.result).toBeNull();
		game.flush();
		expect(storage.getItem(PROGRESS_KEY)).toBeNull();

		game.press('down');
		until(game, 'active');
		expect(game.line?.question).toEqual(question);
		expect(game.line?.result).toBeNull();
	});

	it('lets an answer settle while away, then waits before the next question', () => {
		const game = loaded();
		quick(game);
		game.press('up');
		game.pause();
		until(game, 'idle');
		expect(game.run.count).toBe(1);
		vi.advanceTimersByTime(20_000);
		expect(game.run.count).toBe(1);
	});

	it('lets a card scroll in while away', () => {
		const game = loaded();
		quick(game);
		game.quit();
		game.pause();
		until(game, 'card');
		expect(game.mode).toBeNull();
	});

	it('quits after the verdict when Esc comes while an answer settles', () => {
		const game = loaded();
		quick(game);
		game.press('up');
		game.quit();
		until(game, 'card');
		expect(game.mode).toBeNull();
		expect(game.summary.attempted).toBe(1);
	});

	it('keeps a level test whose last answer Esc follows', () => {
		const game = loaded();
		game.begin('placement');
		until(game, 'active');
		// The test draws nothing further once it has enough.
		while (game.lines.length > game.current + 1) answer(game);
		game.press('up');
		game.quit();
		until(game, 'card');
		expect(game.line?.card?.title).toMatch(/^About /);
		expect(saved<LearnerState>(LEARN_KEY)?.placement).not.toBeNull();
	});

	it('starts the demo from the menu only', () => {
		const game = loaded();
		quick(game);
		game.startDemo();
		expect(game.mode?.id).toBe('quick');
		game.quit();
		until(game, 'card');
		game.startDemo();
		expect(game.mode?.id).toBe('demo');
	});

	it('offers the menu on the card that asks for a level test first', () => {
		const game = loaded();
		game.press('up');
		until(game, 'card');
		expect(game.line?.card?.title).toBe('Find your level first.');
		game.press('left');
		until(game, 'card');
		expect(game.mode).toBeNull();
		expect(game.line?.card?.title).toBe('Choose your flow.');
	});

	it('writes saves when idle, and a page that only watched writes nothing', () => {
		const watcher = loaded();
		const player = loaded();
		quick(player);
		answer(player);
		answer(player);
		vi.advanceTimersByTime(1000);
		expect(saved<Progress>(PROGRESS_KEY)?.attempted).toBe(2);
		watcher.flush();
		watcher.destroy();
		expect(saved<Progress>(PROGRESS_KEY)?.attempted).toBe(2);
		expect(saved<LearnerState>(LEARN_KEY)?.log).toHaveLength(2);
	});

	it('records onto what another tab saved instead of over it', () => {
		const a = loaded();
		const b = loaded();
		quick(b);
		for (let i = 0; i < 3; i++) answer(b);
		b.flush();
		a.storageChanged(LEARN_KEY);
		a.storageChanged(PROGRESS_KEY);
		// The menu showing in tab a is brought up to date at once.
		expect(a.summary.attempted).toBe(3);

		quick(a);
		answer(a, false);
		a.flush();
		expect(saved<Progress>(PROGRESS_KEY)?.attempted).toBe(4);
		expect(saved<LearnerState>(LEARN_KEY)?.log).toHaveLength(4);
	});

	it('carries a learn session over to what another tab saved', () => {
		const a = loaded();
		a.begin('learn');
		until(a, 'active');
		answer(a);
		a.flush();
		// Another tab's answer, as storage would hold it.
		const other = saved<LearnerState>(LEARN_KEY)!;
		other.cards.b3w19 = packCard(newCard(3, Date.now() / 1000));
		storage.setItem(LEARN_KEY, JSON.stringify(other));
		a.storageChanged(LEARN_KEY);
		answer(a);
		a.flush();
		const learner = saved<LearnerState>(LEARN_KEY)!;
		expect(learner.cards.b3w19).toBeDefined();
		expect(learner.log).toHaveLength(2);
	});

	it('plays a swapped deck at once, not the lines drawn from the old one', () => {
		const game = loaded(bank.questions.filter((q) => q.difficulty === 1));
		game.useQuestions(
			bank.questions.filter((q) => q.difficulty === 3),
			'All topics · My level'
		);
		expect(game.line?.card?.bank).toMatch(/^All topics · My level/);
		quick(game);
		for (let i = 0; i < 6; i++) {
			expect(game.line?.question?.difficulty).toBe(3);
			answer(game);
		}
	});

	it('says words aloud only with sound on', () => {
		storage.setItem(SETTINGS_KEY, JSON.stringify({ speak: true, studyPause: false }));
		const game = loaded();
		game.begin('learn');
		until(game, 'active');
		answer(game);
		expect(speak).not.toHaveBeenCalled();
		game.toggleSound();
		answer(game);
		expect(speak).toHaveBeenCalledTimes(1);
		game.toggleSound();
		expect(silence).toHaveBeenCalled();
	});

	it('keeps the learn HUD estimate steady for a minute', () => {
		storage.setItem(
			LEARN_KEY,
			JSON.stringify({ ...emptyLearner(), placement: { at: Date.now(), estimate: 30, perBand: [1, 0.5, 0] } })
		);
		const game = loaded();
		game.begin('learn');
		until(game, 'active');
		const shown = game.learnStatus?.estimate;
		expect(shown).toEqual(expect.any(Number));
		for (let i = 0; i < 5; i++) answer(game, false);
		expect(game.learnStatus?.estimate).toBe(shown);
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
