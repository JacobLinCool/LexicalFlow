import { CUSTOM_PREFIX } from './banks';
import { senseFor, type Bank } from './data';
import { Deck } from './deck';
import {
	Course,
	DEFAULT_DAILY_NEW,
	KEEP_GOING_NEW,
	LEARN_KEY,
	MAX_DAILY_NEW,
	Placement,
	defaultPlan,
	dueCount,
	estimateReady,
	estimateVocabulary,
	frontierBand,
	loadLearner,
	planSummary,
	recordAnswer,
	roundEstimate,
	saveLearner,
	setPlan,
	todayTally,
	type LearnerState,
	type PlacementSummary,
	type PlanSummary,
	type Recorded
} from './learner';
import { DEMO, DEMO_PLAYER, LEARN, MAX_HP, MODES, PLACEMENT, hpDelta } from './modes';
import type { Mode } from './modes';
import {
	averageMs,
	dayKey,
	loadProgress,
	addXp,
	loadSettings,
	PROGRESS_KEY,
	record,
	recordBest,
	recordRun,
	saveProgress,
	saveSettings
} from './progress';
import type { GlossLanguage, Progress, Settings } from './progress';
import { RESPONSE_WINDOW_MS, score } from './scoring';
import { sounds } from './sound';
import { primeSpeech, silence, speak } from './speech';
import { isMastered, unpackCard } from './srs';
import { DIRECTIONS, type Direction, type Outcome, type Question, type Result, type WordInfo } from './types';
import { XP, answerXp, levelOf, type LevelInfo } from './xp';

/** Animation timings (ms); none of them count against the response window. */
export const TIMING = {
	select: 80,
	correct: 120,
	incorrect: 150,
	scroll: 320
} as const;

/** Native-speaker reading pace; choices wait until the sentence could have been read. */
export const READING_WPM = 300;

const HAN = /\p{Script=Han}/gu;

/**
 * Time to read a text at READING_WPM, counting the blank as a word. Chinese has no spaces;
 * each character takes about as long as an English word, and lone punctuation is free.
 */
export function readingMs(text: string): number {
	const han = text.match(HAN)?.length ?? 0;
	const words = text
		.replace(HAN, ' ')
		.split(/\s+/)
		.filter((w) => /[\p{L}\p{N}_]/u.test(w)).length;
	return Math.round(((words + han) * 60_000) / READING_WPM);
}

/** Shortest and longest study pause (ms) on a missed or unfamiliar word. */
export const STUDY_MS = { min: 1500, max: 4000 } as const;

/**
 * The meanings a gloss shows: 'en' hides the Chinese, 'zh' hides the English, unless the
 * word lacks the chosen one, when the other stands in.
 */
export function glossMeanings(info: WordInfo, language: GlossLanguage): { zh: string; en: string } {
	return {
		zh: language !== 'en' || !info.en ? info.zh : '',
		en: language !== 'zh' || !info.zh ? info.en : ''
	};
}

/**
 * Whether an answered word wants studying: a miss, or a first meeting answered right but slowly
 * (Hard). A quick first answer needs no pause; one that might have been a guess comes back later
 * as a check.
 */
export function wantsStudy(outcome: Outcome, recorded: Pick<Recorded, 'firstEncounter' | 'grade'> | null): boolean {
	return outcome !== 'correct' || (!!recorded?.firstEncounter && recorded.grade === 2);
}

/** How long the study pause holds a gloss: the time to read it, within STUDY_MS. */
export function studyMs(info: WordInfo, language: GlossLanguage): number {
	const { zh, en } = glossMeanings(info, language);
	return Math.min(STUDY_MS.max, Math.max(STUDY_MS.min, readingMs(`${zh} ${info.word} ${en}`)));
}

/**
 * Sentences kept ready below the current one. Learn mode and the level test pick each item
 * from the answers so far, so they draw only a little ahead.
 */
const LOOKAHEAD = 5;
const STUDY_LOOKAHEAD = 2;
/** Lines kept above the current one before old history is dropped. */
const HISTORY = 12;
/** Consecutive timeouts after which the stream waits for the player. */
const AWAY_AFTER = 3;
/**
 * The live estimate in the learn HUD moves with every answer while evidence is thin; it is
 * refreshed at most this often (ms), so the swings do not read as gains and losses.
 */
const HUD_ESTIMATE_MS = 60_000;

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Run `task` once the page is idle, and soon in any case; returns a function that cancels it. */
function whenIdle(task: () => void): () => void {
	if (typeof requestIdleCallback === 'function') {
		const id = requestIdleCallback(task, { timeout: 1000 });
		return () => cancelIdleCallback(id);
	}
	// Without idle callbacks (Safari), after the scroll: the clock does not run while a sentence is read.
	const id = setTimeout(task, TIMING.scroll);
	return () => clearTimeout(id);
}

export type Phase =
	| 'loading'
	| 'error'
	/** A card (mode menu or run results) is current and waits for a direction. */
	| 'card'
	/** Mid-run, waiting for a key before the next question starts. */
	| 'idle'
	/** Scrolling the next line into place; input ignored, clock not running. */
	| 'entering'
	/** Sentence in place, choices still hidden while it is read; clock not running. */
	| 'reading'
	/** Clock running; the first direction pressed is final. */
	| 'active'
	/** Selection highlight before the verdict (or before a card option acts). */
	| 'locked'
	/** Verdict flash before scrolling on. */
	| 'feedback'
	/** Learn mode, after the verdict on a missed or unfamiliar word: time to read its gloss; any key moves on. */
	| 'study';

export interface Option {
	label: string;
	detail?: string;
}

/** A non-question line in the stream: the mode menu or a run's results. */
export interface Card {
	title: string;
	/** Current word bank, shown on the menu card. */
	bank?: string;
	subtitle?: string;
	options: Partial<Record<Direction, Option>>;
	act: (direction: Direction) => void;
}

export interface Line {
	key: number;
	question?: Question;
	card?: Card;
	result: Result | null;
	/** The answer word's entry, shown under the sentence once answered. */
	gloss?: WordInfo;
	/** The word wants studying (missed, or new and slow): its gloss stands out. */
	study?: boolean;
}

export interface Summary {
	attempted: number;
	correct: number;
	accuracy: number | null;
	averageMs: number | null;
	totalScore: number;
}

export interface Run {
	count: number;
	correct: number;
	score: number;
	answered: number;
	answerMs: number;
	hp: number;
	/** Last HP change, keyed so the same value twice still re-animates. */
	delta: { value: number; key: number } | null;
	/** Experience earned in this run. */
	xp: number;
}

/** The player's level for the HUD, with the latest gain and level-up keyed so each re-animates. */
export interface LevelView extends LevelInfo {
	xp: number;
	gain: { value: number; key: number } | null;
	up: { level: number; key: number } | null;
}

/** How long the HUD shows an XP gain and a new level (their CSS animations last as long). */
export const XP_GAIN_MS = 1000;
export const LEVEL_UP_MS = 2600;

function levelView(xp: number): LevelView {
	return { ...levelOf(xp), xp, gain: null, up: null };
}

/** Learn-mode figures for the HUD. */
export interface LearnStatus {
	/** New words introduced today, and today's quota. */
	newToday: number;
	quota: number;
	/** Reviews due and not answered yet. */
	due: number;
	/** Estimated vocabulary, rounded for display; null until it rests on enough answers (estimateReady). */
	estimate: number | null;
}

/** Where the lines after the current one come from. */
type Feed = 'deck' | 'course' | 'test';

function summarize(p: Progress): Summary {
	return {
		attempted: p.attempted,
		correct: p.correct,
		accuracy: p.attempted ? p.correct / p.attempted : null,
		averageMs: averageMs(p),
		totalScore: p.totalScore
	};
}

function emptyRun(): Run {
	return { count: 0, correct: 0, score: 0, answered: 0, answerMs: 0, hp: MAX_HP, delta: null, xp: 0 };
}

const points = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${points(n)} ${word}${n === 1 ? '' : 's'}`;


/** "≈ 6,400 words", kept on one line: a lone "words" wrapped onto the next reads as a stray. */
const size = (n: number) => `≈\u00a0${points(n)}\u00a0words`;

/** "3,001–4,000" on one line: a word joiner keeps a narrow screen from breaking after the dash. */
const span = (from: number, to: number) => `${points(from)}–\u2060${points(to)}`;

/** "4,700–7,400": the likely range outward to the hundred (ten when narrow), widened to hold the figure shown. */
export function likelyRange(low: number, high: number, shown: number): string {
	const unit = high - low >= 500 ? 100 : 10;
	return span(Math.min(shown, Math.floor(low / unit) * unit), Math.max(shown, Math.ceil(high / unit) * unit));
}

/** As on the plan page: a pace is intensive above this many genuinely new words, or minutes, a day. */
const INTENSIVE_GAIN = 60;
const INTENSIVE_MINUTES = 60;

/**
 * "goal 8,000 in 30 days · ≈ 120 words a day, about 40 new to you · ~45 min". Introductions
 * include words the learner probably knows, so the genuinely new ones are named when they differ.
 */
export function paceLine(summary: PlanSummary): string {
	const { plan, daysLeft, dailyNew, dailyGain, minutes, finish, deadline, reached, expired } = summary;
	if (!plan) return '';
	const goal = `goal ${points(plan.target)}`;
	if (reached) return `${goal} reached`;
	// Past its deadline, a plan keeps a steady pace until it is changed.
	const within = expired ? `${goal}, past its deadline` : `${goal} in ${plural(daysLeft, 'day')}`;
	// Not even the course's ceiling meets the deadline, so no daily pace would be honest.
	if (!expired && finish && deadline && finish > deadline) {
		return `${within} needs more than the ${points(MAX_DAILY_NEW)} words a day the course allows`;
	}
	const known = dailyNew - dailyGain;
	const words =
		known >= Math.max(3, 0.1 * dailyNew)
			? `≈ ${points(dailyNew)} words a day, about ${points(dailyGain)} new to you`
			: `≈ ${plural(dailyNew, 'new word')} a day`;
	const intensive = dailyGain > INTENSIVE_GAIN || minutes > INTENSIVE_MINUTES;
	return [within, words, `~${minutes} min`, intensive && 'an intensive pace'].filter(Boolean).join(' · ');
}

/** "Dec 6" for a local YYYY-MM-DD date. */
function shortDate(key: string): string {
	const [y, m, d] = key.split('-').map(Number);
	return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Words introduced today that were new to the learner: missed at first sight. Only learn mode
 * keeps a card for a missed first answer (other modes and the level test leave the word new), so
 * cards first met today with a first grade of Again are exactly these.
 */
export function missedIntroductions(state: LearnerState, now = Date.now()): number {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const since = midnight.getTime() / 1000;
	let n = 0;
	for (const lemma in state.cards) {
		const [, , , , , , first, firstGrade] = state.cards[lemma];
		if (firstGrade === 1 && first >= since) n++;
	}
	return n;
}

/**
 * The done card's summary of a day's learning (the day's tally counts learn mode only): the new
 * words, split into those the learner already knew (confirmed by a right first answer) and those
 * new to them, then all the day's answers and the estimate.
 */
export function doneSummary(
	{ introduced, missed, answers, correct }: { introduced: number; missed: number; answers: number; correct: number },
	estimate: number | null
): string {
	const known = Math.max(0, introduced - missed);
	const words = !introduced
		? ''
		: !known
			? `+${plural(introduced, 'new word')} today`
			: !missed
				? `+${plural(introduced, 'word')} today, all known already`
				: `+${points(introduced)} words today: ${points(known)} you knew, ${points(missed)} new to you`;
	const tally = answers ? `${plural(answers, 'answer')}, ${Math.round((correct / answers) * 100)}% right` : '';
	const rest = [tally, estimate === null ? '' : size(estimate)].filter(Boolean).join(' · ');
	return [words, rest].filter(Boolean).join('\n');
}

export class Game {
	#progress: Progress = loadProgress();
	phase = $state<Phase>('loading');
	lines = $state<Line[]>([]);
	current = $state(0);
	picked = $state<Direction | null>(null);
	sound = $state(false);
	summary = $state<Summary>(summarize(this.#progress));
	level = $state<LevelView>(levelView(this.#progress.xp));
	mode = $state<Mode | null>(null);
	/** What is being played, e.g. "Travel · Easy", shown on the menu. */
	bankLabel = $state('');
	#bankId = 'all';
	run = $state<Run>(emptyRun());
	learnStatus = $state<LearnStatus | null>(null);
	testStatus = $state<{ asked: number; expected: number } | null>(null);
	/** Length of the current study pause, for its countdown. */
	studyMs = $state(0);
	/** Which meanings glosses show; settings change on another page, which remounts the game. */
	readonly glossLanguage: GlossLanguage;

	#deck: Deck | null = null;
	/** The bundled bank: learn mode and the level test always use it, and glosses come from it. */
	#builtin: Bank | null = null;
	#feed: Feed = 'deck';
	#course: Course | null = null;
	#placement: Placement | null = null;
	#learner: LearnerState = loadLearner();
	/**
	 * Stores this page changed and has not written yet. A page that only watched never writes, so
	 * it cannot overwrite what another tab saved.
	 */
	#unsaved = { learner: false, progress: false };
	/** Stores another tab or page saved since this page read them; read again before use (#sync). */
	#stale = { learner: false, progress: false };
	#cancelSave: (() => void) | null = null;
	/** The latest vocabulary estimate in learn mode, unrounded; the HUD shows it once it is ready. */
	#estimate = 0;
	/** When the HUD's estimate was last updated (epoch ms). */
	#estimateShownAt = 0;
	#settings: Settings;
	#openPlan: () => void;
	#onPlaced: () => void;
	#nextKey = 0;
	#xpKey = 0;
	/** Clear the HUD's XP gain and level-up once their animations are over, so a remount does not replay them. */
	#xpTimer: ReturnType<typeof setTimeout> | undefined;
	#levelUpTimer: ReturnType<typeof setTimeout> | undefined;
	#activatedAt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** The demo player's pending answer. */
	#bot: ReturnType<typeof setTimeout> | undefined;
	#timeoutStreak = 0;
	/** The page was hidden or lost focus, and no key or tap has come since: the next question waits. */
	#away = false;
	/** Esc came while an answer was being settled; the menu follows once it is recorded. */
	#quitting = false;

	/**
	 * `openPlan` navigates to the plan page; cards offer it after a test or a day's learning.
	 * `onPlaced` runs once a level test is saved, e.g. to re-resolve a bank played at 'My level'.
	 */
	constructor(options: { openPlan?: () => void; onPlaced?: () => void } = {}) {
		this.#settings = loadSettings();
		this.sound = this.#settings.sound;
		this.glossLanguage = this.#settings.gloss;
		this.#openPlan = options.openPlan ?? (() => {});
		this.#onPlaced = options.onPlaced ?? (() => {});
	}

	get line(): Line | undefined {
		return this.lines[this.current];
	}

	/** `questions` feed the scored modes; `builtin` is the bundled bank for learning and glosses. */
	load(questions: Question[], bank: { id: string; label: string }, builtin: Bank): void {
		this.bankLabel = bank.label;
		this.#bankId = bank.id;
		this.#builtin = builtin;
		this.#deck = new Deck(questions, this.#progress.recent);
		this.lines = [{ key: this.#nextKey++, card: this.#menuCard(), result: null }];
		this.current = 0;
		this.#fill();
		this.phase = 'card';
	}

	/**
	 * Swap the questions the scored modes draw from, e.g. once 'My level' can follow a level
	 * test. Lines already drawn ahead from the old deck are drawn again, or the next run would
	 * open with them; the menu, if showing, takes the new label.
	 */
	useQuestions(questions: Question[], label: string): void {
		if (!questions.length) return;
		this.bankLabel = label;
		this.#deck = new Deck(questions, this.#deck?.recent ?? this.#progress.recent);
		if (this.#feed !== 'deck') return;
		this.lines.splice(this.current + 1);
		this.#fill();
		this.#redrawMenu();
	}

	fail(): void {
		this.phase = 'error';
	}

	/**
	 * A direction from the keyboard or a tap. `at` is the input event's timestamp, on the
	 * performance.now() clock.
	 */
	press(direction: Direction, at = performance.now()): void {
		this.#away = false;
		this.#unlockAudio();
		if (this.phase === 'active') return this.#answer(direction, at);
		if (this.phase === 'study') return this.#endStudy();
		if (this.phase === 'idle') return this.#resume();
		if (this.phase === 'card') return this.#choose(direction);
	}

	/** End a study pause early; any key or tap does, and it never counts as an answer. */
	skipStudy(): void {
		if (this.phase === 'study') this.#endStudy();
	}

	/** Start learn mode or the level test from the menu right away (links from the plan page). */
	begin(kind: 'learn' | 'placement'): void {
		if (this.phase !== 'card' || this.mode) return;
		if (kind === 'learn') this.#startLearn();
		else this.#startTest();
	}

	get demo(): boolean {
		return this.mode?.id === 'demo';
	}

	/** Start autoplay from the mode menu; anywhere else it would throw away a run or a result. */
	startDemo(): void {
		if (this.phase !== 'card' || this.mode || !this.#deck) return;
		this.#stopTimers();
		this.#start(DEMO);
	}

	/** Leave autoplay for the mode menu, whatever the demo was doing. */
	stopDemo(): void {
		if (!this.demo) return;
		this.#stopTimers();
		this.#showMenu();
	}

	#stopTimers(): void {
		clearTimeout(this.#timer);
		clearTimeout(this.#bot);
	}

	/**
	 * Abandon the current run (not recorded as a result) and return to the mode menu. Learn
	 * mode loses nothing: every answer is already recorded. An answer being settled is recorded
	 * first, and the menu follows its verdict.
	 */
	quit(): void {
		if (!this.mode) return;
		if (this.phase === 'locked' || this.phase === 'feedback') {
			this.#quitting = true;
			return;
		}
		this.#stopTimers();
		this.#showMenu();
	}

	/**
	 * The page was hidden or lost focus. A question waiting for an answer goes back to waiting for
	 * the player, so nobody away is timed out and their word marked missed; #resume reads it again
	 * with a fresh clock. An answer already given settles as usual and the next question then waits
	 * (#next), and a card scrolling in has no clock to stop.
	 */
	pause(): void {
		// The demo records nothing; it parks by itself once the page is hidden.
		if (this.demo) return;
		this.#away = true;
		const waiting = this.phase === 'entering' || this.phase === 'reading' || this.phase === 'active';
		if (!waiting || !this.line?.question) return;
		this.#stopTimers();
		this.picked = null;
		this.phase = 'idle';
	}

	/** The page is in view and focused again: a parked question still waits for a key or tap. */
	wake(): void {
		this.#away = false;
		if (this.#stale.learner || this.#stale.progress) this.#redrawMenu();
	}

	/**
	 * Another tab or page saved `key` (null: storage was cleared). This page reads that store again
	 * before it next uses it, so its own copy never overwrites newer work.
	 */
	storageChanged(key: string | null): void {
		if (key === null || key === LEARN_KEY) this.#stale.learner = true;
		if (key === null || key === PROGRESS_KEY) this.#stale.progress = true;
		// A hidden menu is brought up to date when it is shown again (wake).
		if (!pageHidden()) this.#redrawMenu();
	}

	/** Sound effects and speech; muting silences both. */
	toggleSound(): void {
		this.sound = !this.sound;
		if (this.sound) this.#unlockAudio();
		else silence();
		saveSettings({ ...loadSettings(), sound: this.sound });
	}

	/** Write unsaved changes now, e.g. when the page is hidden or left. */
	flush(): void {
		this.#persist();
	}

	destroy(): void {
		this.#stopTimers();
		clearTimeout(this.#xpTimer);
		clearTimeout(this.#levelUpTimer);
		this.#persist();
	}

	/** Audio and speech only start inside a user gesture in some browsers; every press is one. */
	#unlockAudio(): void {
		if (!this.sound) return;
		sounds.prime();
		if (this.#settings.speak) primeSpeech();
	}

	/**
	 * Note changed stores. Saving stringifies each store whole, which takes a while on a slow phone
	 * once the learner is large, so it waits for an idle moment rather than holding up the verdict;
	 * flush() writes at once.
	 */
	#changed(...stores: ('learner' | 'progress')[]): void {
		for (const store of stores) this.#unsaved[store] = true;
		this.#cancelSave ??= whenIdle(() => {
			this.#cancelSave = null;
			this.#persist();
		});
	}

	/** Write the stores this page changed, except one another tab has saved over since (see #sync). */
	#persist(): void {
		this.#cancelSave?.();
		this.#cancelSave = null;
		if (this.#unsaved.progress && !this.#stale.progress) saveProgress(this.#progress);
		if (this.#unsaved.learner && !this.#stale.learner) saveLearner(this.#learner);
		this.#unsaved = { learner: false, progress: false };
	}

	/**
	 * Read again the stores another tab or page saved since this page last did. Their save wins
	 * over a change of this page not written yet, which only two tabs answering within a second of
	 * each other could lose. A course under way carries on over the fresh learner.
	 */
	#sync(): void {
		if (this.#stale.progress) {
			this.#stale.progress = this.#unsaved.progress = false;
			this.#progress = loadProgress();
			this.summary = summarize(this.#progress);
			this.level = { ...this.level, ...levelOf(this.#progress.xp), xp: this.#progress.xp };
		}
		if (!this.#stale.learner) return;
		this.#stale.learner = this.#unsaved.learner = false;
		this.#learner = loadLearner();
		const builtin = this.#builtin;
		if (!this.#course || !builtin) return;
		this.#course = new Course(this.#learner, builtin.lexicon, builtin.questions);
		// Lines drawn ahead are pending in the old course only: let the new one draw them.
		if (this.#feed === 'course') this.lines.splice(this.current + 1);
	}

	/** Rebuild the mode menu in place if it is showing, after another tab saved or the bank changed. */
	#redrawMenu(): void {
		const line = this.line;
		if (this.phase !== 'card' || this.mode || !line?.card) return;
		this.#sync();
		line.card = this.#menuCard();
	}

	/** Learn can start without the test once the test was taken or learning began without it. */
	#placed(): boolean {
		const learner = this.#learner;
		return learner.placement !== null || Object.values(learner.days).some((day) => day[0] > 0);
	}

	#menuCard(): Card {
		const s = this.summary;
		const lexicon = this.#builtin?.lexicon;
		const outlook = lexicon && this.#placed() ? planSummary(this.#learner, lexicon) : null;
		const options: Card['options'] = {};
		for (const mode of MODES) {
			const best = this.#progress.bests[mode.id];
			let detail = best ? `${mode.detail} · best ${points(best.score)}` : mode.detail;
			if (mode.id === 'learn') detail = outlook ? this.#todayDetail(outlook) : 'Find your level';
			options[mode.direction] = { label: mode.label, detail };
		}
		const count = `${points(this.#deck?.size ?? 0)} questions`;
		return {
			title: 'Choose your flow.',
			bank: `${this.bankLabel} · ${count}`,
			subtitle: outlook
				? this.#vocabularyLine(outlook)
				: s.attempted
					? `${points(s.attempted)} answered · ${Math.round((s.accuracy ?? 0) * 100)}% correct · ${((s.averageMs ?? 0) / 1000).toFixed(2)}s average`
					: 'Pick the missing word before the line runs out.',
			options,
			act: (direction) => {
				const mode = MODES.find((m) => m.direction === direction);
				if (mode?.id === 'learn') this.#chooseLearn();
				else if (mode) this.#start(mode);
			}
		};
	}

	/**
	 * "≈ 6,400 words · goal 10,000 by Dec 6"; a plan with nothing left to add is reached. Until
	 * the estimate rests on enough answers it is only the prior, so the test is suggested instead.
	 */
	#vocabularyLine({ estimate, plan, deadline, reached, expired }: PlanSummary): string {
		if (!estimateReady(this.#learner)) return 'Take the level test to see your vocabulary size.';
		const words = size(roundEstimate(estimate));
		if (!plan || !deadline) return words;
		const goal = `goal ${points(plan.target)}`;
		const status = reached ? 'reached' : expired ? 'past its deadline' : `by ${shortDate(deadline)}`;
		return `${words} · ${goal} ${status}`;
	}

	/** What Learn holds today: "18 due · 30 new". */
	#todayDetail({ plan, dailyNew }: PlanSummary): string {
		const due = dueCount(this.#learner);
		const quota = plan ? dailyNew : DEFAULT_DAILY_NEW;
		const fresh = Math.max(0, quota - todayTally(this.#learner).newIntroduced);
		return due || fresh ? `${points(due)} due · ${points(fresh)} new` : 'Done for today';
	}

	#resultsCard(mode: Mode, newBest: boolean): Card {
		const run = this.run;
		const avg = run.answered ? `${(run.answerMs / run.answered / 1000).toFixed(2)}s average` : '';
		const best = this.#progress.bests[mode.id];
		const tally = mode.hp
			? `Survived ${run.count} ${run.count === 1 ? 'question' : 'questions'}, ${run.correct} correct`
			: `${run.correct} of ${run.count} correct`;
		return {
			title: `${points(run.score)} points.`,
			subtitle: [
				tally,
				avg,
				newBest ? 'New best' : best ? `best ${points(best.score)}` : '',
				run.xp ? `+${points(run.xp)} XP` : ''
			]
				.filter(Boolean)
				.join(' · '),
			options: {
				up: { label: 'Play again', detail: mode.label },
				down: { label: 'Change mode' }
			},
			act: (direction) => {
				if (direction === 'up') this.#start(mode);
				else if (direction === 'down') this.#showMenu();
			}
		};
	}

	/** Offered when Learn is chosen before any level test. */
	#levelCard(): Card {
		return {
			title: 'Find your level first.',
			subtitle: 'About 3 minutes: a few words from each frequency band.',
			options: {
				up: { label: 'Start the test', detail: 'About 3 minutes' },
				left: { label: 'Menu' },
				down: { label: 'Skip', detail: 'Start with the most common words' }
			},
			act: (direction) => {
				if (direction === 'up') this.#startTest();
				else if (direction === 'left') this.#showMenu();
				else if (direction === 'down') this.#startLearn();
			}
		};
	}

	/**
	 * The level test's result: the estimate with its likely range and where learning starts, then
	 * the plan's pace on a second line.
	 */
	#testCard({ estimate, low, high }: PlacementSummary): Card {
		const learner = this.#learner;
		const lexicon = this.#builtin?.lexicon;
		const shown = roundEstimate(estimate);
		const result = [`likely ${likelyRange(low, high, shown)}`];
		let pace = '';
		if (lexicon) {
			const band = frontierBand(learner, lexicon);
			const first = (band - 1) * lexicon.bandSize + 1;
			const last = Math.min(band * lexicon.bandSize, lexicon.byRank.length);
			result.push(`learning starts at words ${span(first, last)}`);
			pace = paceLine(planSummary(learner, lexicon));
		}
		return {
			title: `About ${plural(shown, 'word')}.`,
			subtitle: [result.join(' · '), pace].filter(Boolean).join('\n'),
			options: {
				up: { label: 'Start learning' },
				right: { label: 'Adjust plan' },
				down: { label: 'Menu' }
			},
			act: (direction) => {
				if (direction === 'up') this.#startLearn();
				else if (direction === 'right') this.#leaveForPlan();
				else if (direction === 'down') this.#showMenu();
			}
		};
	}

	/** Learn mode has nothing left for today: what the day's learning added up to. */
	#doneCard(): Card {
		const learner = this.#learner;
		const today = dayKey(new Date());
		// The first finished plan of the day earns its bonus; keeping going and finishing again does not.
		if (this.#progress.dayDone !== today) {
			this.#progress.dayDone = today;
			this.#gainXp(XP.dayDone);
		}
		const xpToday = this.#progress.xpDays[today] ?? 0;
		const day = todayTally(learner);
		const summary = {
			introduced: day.newIntroduced,
			missed: missedIntroductions(learner),
			answers: day.newIntroduced + day.reviews,
			correct: day.correct
		};
		return {
			title: "Today's plan is done.",
			subtitle: [
				doneSummary(summary, estimateReady(learner) ? roundEstimate(this.#estimate) : null),
				xpToday ? `+${points(xpToday)} XP today, ${points(XP.dayDone)} of them for finishing` : ''
			]
				.filter(Boolean)
				.join('\n'),
			options: {
				up: { label: 'Keep going', detail: `${KEEP_GOING_NEW} more new words` },
				right: { label: 'Plan' },
				down: { label: 'Menu' }
			},
			act: (direction) => {
				if (direction === 'up') this.#keepGoing();
				else if (direction === 'right') this.#leaveForPlan();
				else if (direction === 'down') this.#showMenu();
			}
		};
	}

	#choose(direction: Direction): void {
		const card = this.line?.card;
		if (!card?.options[direction]) return;
		this.picked = direction;
		this.phase = 'locked';
		this.#timer = setTimeout(() => (this.#quitting ? this.#showMenu() : card.act(direction)), TIMING.select);
	}

	#leaveForPlan(): void {
		// Settle the card first, in case navigation is slow or refused; the plan page reads storage.
		this.picked = null;
		this.phase = 'card';
		this.flush();
		this.#openPlan();
	}

	#start(mode: Mode): void {
		this.#sync();
		this.mode = mode;
		this.run = emptyRun();
		this.#timeoutStreak = 0;
		this.#quitting = false;
		this.#setFeed(mode.id === 'learn' ? 'course' : mode.id === 'placement' ? 'test' : 'deck');
		this.#next();
	}

	/** Learn from the menu; a learner who has not found their level yet is offered the test first. */
	#chooseLearn(): void {
		this.#sync();
		if (this.#placed()) return this.#startLearn();
		this.mode = LEARN;
		this.#insertCard(this.#levelCard());
	}

	#startLearn(): void {
		const builtin = this.#builtin;
		if (!builtin) return;
		this.#placement = null;
		this.#course = null;
		this.#sync();
		this.#course = new Course(this.#learner, builtin.lexicon, builtin.questions);
		this.#refreshLearn(estimateVocabulary(this.#learner, builtin.lexicon));
		this.#start(LEARN);
	}

	#startTest(): void {
		const builtin = this.#builtin;
		if (!builtin) return;
		this.#course = null;
		this.#sync();
		// A retake asks about words not met yet where it can; met ones say less about the rest.
		this.#placement = new Placement(builtin.lexicon, builtin.questions, { state: this.#learner });
		this.testStatus = this.#placement.progress;
		this.#start(PLACEMENT);
	}

	/** Past today's quota: more new words in the same session. */
	#keepGoing(): void {
		this.#sync();
		this.#course?.keepGoing();
		this.#refreshLearn();
		this.#setFeed('course');
		this.#next();
	}

	#showMenu(): void {
		this.mode = null;
		this.#quitting = false;
		this.#course = null;
		this.#placement = null;
		this.learnStatus = null;
		this.testStatus = null;
		this.#sync();
		this.#insertCard(this.#menuCard());
	}

	/** Put a card right after the current line and scroll to it; the stream below it is decor from the deck. */
	#insertCard(card: Card): void {
		this.lines.splice(this.current + 1, 0, { key: this.#nextKey++, card, result: null });
		this.current++;
		this.#setFeed('deck');
		this.#fill();
		this.#enter('card');
	}

	#resume(): void {
		this.#timeoutStreak = 0;
		this.#enter('active');
	}

	/** Switch the source of upcoming lines; lines drawn ahead from the old one are dropped. */
	#setFeed(feed: Feed): void {
		if (feed === this.#feed) return;
		this.#feed = feed;
		this.lines.splice(this.current + 1);
	}

	/** The next question from the current feed; null when the course or test has nothing right now. */
	#draw(): Question | null {
		if (this.#feed === 'course') return this.#course?.next()?.question ?? null;
		if (this.#feed === 'test') return this.#placement?.next() ?? null;
		return this.#deck?.next() ?? null;
	}

	#fill(): void {
		const ahead = this.#feed === 'deck' ? LOOKAHEAD : STUDY_LOOKAHEAD;
		while (this.lines.length <= this.current + ahead) {
			const question = this.#draw();
			if (!question) break;
			this.lines.push({ key: this.#nextKey++, question, result: null });
		}
		const excess = this.current - HISTORY;
		if (excess > 0) {
			this.lines.splice(0, excess);
			this.current -= excess;
		}
	}

	/** Scroll the current line into place, then hand over to `then`. */
	#enter(then: 'active' | 'card'): void {
		this.phase = 'entering';
		this.picked = null;
		this.#timer = setTimeout(() => {
			if (then === 'card') {
				this.phase = 'card';
				return;
			}
			const question = this.line?.question;
			this.phase = 'reading';
			this.#timer = setTimeout(() => this.#activate(), question ? readingMs(question.sentence) : 0);
		}, TIMING.scroll);
	}

	/** Reveal the choices and start the clock. */
	#activate(): void {
		this.phase = 'active';
		this.#activatedAt = performance.now();
		this.#timer = setTimeout(() => this.#resolve(null, RESPONSE_WINDOW_MS), RESPONSE_WINDOW_MS);
		if (this.demo) this.#autoplay();
	}

	/** The demo player: a human-ish delay, usually right, sometimes not. */
	#autoplay(): void {
		const question = this.line?.question;
		if (!question) return;
		const { minMs, maxMs, accuracy } = DEMO_PLAYER;
		const wrong = DIRECTIONS.filter((d) => d !== question.answer);
		const pick = Math.random() < accuracy ? question.answer : wrong[Math.floor(Math.random() * wrong.length)];
		this.#bot = setTimeout(() => this.#answer(pick, performance.now()), minMs + Math.random() * (maxMs - minMs));
	}

	#answer(direction: Direction, at: number): void {
		clearTimeout(this.#timer);
		const ms = Math.max(0, at - this.#activatedAt);
		if (ms >= RESPONSE_WINDOW_MS) return this.#resolve(null, RESPONSE_WINDOW_MS);
		this.picked = direction;
		this.phase = 'locked';
		this.#timer = setTimeout(() => this.#resolve(direction, ms), TIMING.select);
	}

	#resolve(picked: Direction | null, ms: number): void {
		const line = this.line;
		const question = line?.question;
		if (!line || !question) return;
		const correct = picked === question.answer;
		const result: Result = {
			outcome: picked === null ? 'timeout' : correct ? 'correct' : 'incorrect',
			picked,
			ms,
			score: score(correct, ms)
		};
		line.result = result;
		this.picked = picked;
		this.phase = 'feedback';

		const word = this.#builtin?.lexicon.words.get(question.lemma);
		// The demo plays for show: nothing it does is recorded.
		const recorded = this.demo ? null : this.#record(question, result, word);

		// Learn mode explains every word; the level test gives nothing away; elsewhere only misses are explained.
		const learn = this.mode?.id === 'learn';
		const info = word && senseFor(word, question);
		const gloss = info && this.mode?.id !== 'placement' && (learn || !correct) ? info : undefined;
		const study = !!gloss && wantsStudy(result.outcome, recorded);
		const pause = learn && gloss && study && this.#settings.studyPause ? studyMs(gloss, this.glossLanguage) : 0;
		const explain = () => {
			line.gloss = gloss;
			line.study = study;
		};
		// A pause shows the gloss right away. Otherwise it arrives as the line moves up, so the
		// choices do not shift under the verdict.
		if (pause) explain();

		const run = this.run;
		if (this.mode?.hp) {
			const value = hpDelta(result, run.count);
			run.hp = Math.max(0, Math.min(MAX_HP, run.hp + value));
			run.delta = { value, key: run.count };
		}
		run.count++;
		run.score += result.score;
		if (result.outcome === 'correct') run.correct++;
		if (result.outcome !== 'timeout') {
			run.answered++;
			run.answerMs += ms;
		}
		this.#timeoutStreak = result.outcome === 'timeout' ? this.#timeoutStreak + 1 : 0;

		const mode = this.mode;
		const over = !!mode && ((mode.limit !== null && run.count >= mode.limit) || (mode.hp && run.hp <= 0));
		let newBest = false;
		if (over && mode) {
			recordRun(this.#progress, {
				mode: mode.id,
				bank: this.#bankId,
				score: run.score,
				count: run.count,
				correct: run.correct,
				answered: run.answered,
				answerMs: Math.round(run.answerMs),
				at: Date.now()
			});
			newBest = recordBest(this.#progress, mode.id, {
				score: run.score,
				correct: run.correct,
				count: run.count,
				at: Date.now()
			});
			this.#changed('progress');
		}

		if (this.sound && !this.demo) {
			sounds[result.outcome]();
			// Speech is sound too, so muting silences it.
			if (learn && gloss && this.#settings.speak) speak(gloss.word);
		}
		const hold = result.outcome === 'correct' ? TIMING.correct : TIMING.incorrect;
		this.#timer = setTimeout(() => {
			// Esc during the verdict leaves now, unless that was the level test's last answer: its result is kept.
			const quitting = this.#quitting && !this.#placement?.done;
			this.#quitting = false;
			if (pause && !quitting) return this.#study(pause);
			if (gloss) explain();
			if (quitting) this.#showMenu();
			else if (over && mode) this.#insertCard(this.#resultsCard(mode, newBest));
			else this.#next();
		}, hold);
	}

	/**
	 * Fold an answer into the profile and the learner. Learn mode goes through its course; the
	 * level test keeps its answers until it is finished; other modes add evidence about `word`,
	 * the answer's entry in the built-in lexicon (absent for words only a custom bank has).
	 */
	#record(question: Question, result: Result, word: WordInfo | undefined): Recorded | null {
		// Another tab may have saved since: record onto its work, not over it.
		this.#sync();
		// Learning and the level test are not competitions: their answers count, their points do not.
		const scored = this.mode?.id !== 'learn' && this.mode?.id !== 'placement';
		record(this.#progress, question, scored ? result : { ...result, score: 0 });
		this.#progress.recent = this.#deck?.recent ?? [];
		this.summary = summarize(this.#progress);
		this.#changed('progress');
		const masteredBefore = this.#mastered(question.lemma);
		const gained = this.mode ? answerXp(this.mode.id, result) : 0;
		const recorded = this.#recordLearner(question, result, word);
		const bonus = !masteredBefore && this.#mastered(question.lemma) ? XP.mastered : 0;
		this.#gainXp(gained + bonus);
		return recorded;
	}

	/** Whether the learner's card for this word counts as mastered (remembered three weeks or more). */
	#mastered(lemma: string): boolean {
		const card = Object.hasOwn(this.#learner.cards, lemma) ? this.#learner.cards[lemma] : undefined;
		return !!card && isMastered(unpackCard(card));
	}

	/** Add experience; the HUD shows the gain, and a new level with a chime. */
	#gainXp(amount: number): void {
		if (amount <= 0) return;
		const before = this.level.level;
		addXp(this.#progress, amount);
		this.#changed('progress');
		const key = ++this.#xpKey;
		const info = levelOf(this.#progress.xp);
		const up = info.level > before ? { level: info.level, key } : this.level.up;
		this.level = { ...info, xp: this.#progress.xp, gain: { value: amount, key }, up };
		if (this.mode) this.run.xp += amount;
		clearTimeout(this.#xpTimer);
		this.#xpTimer = setTimeout(() => (this.level = { ...this.level, gain: null }), XP_GAIN_MS);
		if (info.level > before) {
			if (this.sound && !this.demo) sounds.levelUp();
			clearTimeout(this.#levelUpTimer);
			this.#levelUpTimer = setTimeout(() => (this.level = { ...this.level, up: null }), LEVEL_UP_MS);
		}
	}

	/** The learner's side of an answer (see #record). */
	#recordLearner(question: Question, result: Result, word: WordInfo | undefined): Recorded | null {
		if (this.mode?.id === 'placement') {
			this.#placement?.answer(question, result);
			this.testStatus = this.#placement?.progress ?? null;
			return null;
		}
		let recorded: Recorded;
		if (this.mode?.id === 'learn' && this.#course) {
			recorded = this.#course.answer(question, result);
			// The course has just stored the new estimate as today's snapshot (DayTally[4]).
			this.#refreshLearn(this.#learner.days[dayKey(new Date())]?.[4]);
		} else {
			const lexicon = this.#builtin?.lexicon;
			if (!word || !lexicon) return null;
			// A custom bank's words were picked by the player, so they say nothing about a band as a whole.
			const evidence = this.#bankId.startsWith(CUSTOM_PREFIX) ? 'none' : undefined;
			recorded = recordAnswer(this.#learner, word, result, {
				introduce: false,
				lex: lexicon,
				questionId: question.id,
				evidence
			});
		}
		this.#changed('learner');
		return recorded;
	}

	/**
	 * Update the learn HUD; the estimate stays as it was unless a new one is given. The HUD shows it
	 * roughly, and updates it at most every HUD_ESTIMATE_MS.
	 */
	#refreshLearn(estimate?: number): void {
		if (estimate !== undefined) this.#estimate = estimate;
		const stats = this.#course?.stats;
		if (!stats) return;
		let shown = this.learnStatus?.estimate ?? null;
		const now = Date.now();
		if (!estimateReady(this.#learner)) shown = null;
		else if (shown === null || now - this.#estimateShownAt >= HUD_ESTIMATE_MS) {
			shown = roundEstimate(this.#estimate);
			this.#estimateShownAt = now;
		}
		this.learnStatus = { newToday: stats.newToday, quota: stats.quota, due: stats.due, estimate: shown };
	}

	/** Hold the gloss of a missed or unfamiliar word up to be read. */
	#study(ms: number): void {
		this.phase = 'study';
		this.studyMs = ms;
		this.#timer = setTimeout(() => this.#endStudy(), ms);
	}

	#endStudy(): void {
		clearTimeout(this.#timer);
		this.#next();
	}

	/** The course or test has nothing more to ask: close the run with its card. */
	#finish(): void {
		this.#sync();
		const placement = this.#feed === 'test' ? this.#placement : null;
		if (!placement) return this.#insertCard(this.#doneCard());
		const summary = placement.finish(this.#learner);
		if (!this.#learner.plan) setPlan(this.#learner, defaultPlan(summary.estimate, dayKey(new Date())));
		// Written at once: onPlaced resolves 'My level' from storage.
		this.#changed('learner');
		this.#persist();
		this.#insertCard(this.#testCard(summary));
		this.#onPlaced();
	}

	/** Move on to the next question, or park on it if nobody seems to be playing. */
	#next(): void {
		this.#fill();
		// Only a course or test runs dry, and that ends its run.
		if (!this.lines[this.current + 1]) return this.#finish();
		this.current++;
		this.#fill();
		if (this.#feed === 'test') this.testStatus = this.#placement?.progress ?? null;
		const away = pageHidden() || (!this.demo && (this.#away || this.#timeoutStreak >= AWAY_AFTER));
		if (away) {
			this.picked = null;
			this.phase = 'idle';
		} else {
			this.#enter('active');
		}
	}
}
