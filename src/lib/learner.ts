import { dayKey } from './progress';
import {
	DEFAULT_THRESHOLDS,
	MASTERED_DAYS,
	forgetting,
	gradeOf,
	newCard,
	packCard,
	review,
	unpackCard,
	type CardTuple,
	type Grade,
	type GradeThresholds
} from './srs';
import { DIRECTIONS, type Lexicon, type Question, type Result, type WordInfo } from './types';

/**
 * The long-term course: what the learner knows (one FSRS card per word they have met),
 * an estimate of their vocabulary size, a daily plan towards a goal, and the session
 * engines for learn mode (`Course`) and the level test (`Placement`).
 *
 * Everything here is plain data and pure logic. Callers own persistence: they mutate a
 * LearnerState through these functions and write it back with saveLearner().
 */

export const LEARN_KEY = 'lexical-flow:learn:v1';

/** Per local day: [newIntroduced, reviews, correct, answerMs, estimateSnapshot, quota]; see LearnerState.days. */
export type DayTally = [number, number, number, number, number, number];

/**
 * First-encounter evidence of one band: [answers, correct, Σ position]. A word's position is where
 * its rank lies in the band, from 0 at the band's most frequent word to 1 at its rarest. Learn mode
 * works through a band from the top, so its answers say more about the band's frequent words than
 * about the rest, and the band model weighs them where they lie.
 */
export type Evidence = [number, number, number];

/**
 * How an answer counts towards the band estimates. 'careful': learn mode and the level test.
 * 'scored': Quick, Standard and Survival, where speed earns points and a known word is missed
 * far more often. 'none': a bank the learner chose (a word list), which is no sample of its bands.
 */
export type EvidenceKind = 'careful' | 'scored' | 'none';

export interface Plan {
	/** Words to know by the end of the plan. */
	target: number;
	/** Length in days, counted from `start`. */
	days: number;
	/** Local start date, YYYY-MM-DD. */
	start: string;
}

export interface PlacementResult {
	/** Epoch milliseconds. */
	at: number;
	/** Estimated vocabulary right after the test. */
	estimate: number;
	/** p_known per band right after the test, index band − 1. Kept for display; estimates come from `firsts`. */
	perBand: number[];
}

/**
 * Where the learner stood as the day began: before its first answer, or right after a level test
 * taken that day. The plan's daily figures are worked out from it, so they hold all day however
 * the day's answers move the estimate.
 */
export interface Morning {
	/** Local date, YYYY-MM-DD. */
	day: string;
	/** Estimated vocabulary, and the size the learner is past with 80% probability (SURE_QUANTILE). */
	estimate: number;
	sure: number;
	frontier: number;
	/** Per band (index band − 1): p_known of its unseen words, and how many there are. */
	p: number[];
	unseen: number[];
}

/** How an answer went, in the review log: 0 correct, 1 wrong choice, 2 timeout. */
export type LogOutcome = 0 | 1 | 2;

/**
 * One recorded answer: [lemma, epochSeconds, grade, ms, questionId, outcome, stabilityBefore].
 * `grade` is the one the card received; `stabilityBefore` is the card's stability in days just
 * before the answer, 0 for a first encounter, so reviews of mature cards can be told apart.
 */
export type LogEntry = [string, number, Grade, number, string, LogOutcome, number];

/** The review log keeps this many answers, enough to fit FSRS weights and response times later. */
export const LOG_LIMIT = 5000;

export interface LearnerState {
	v: 1;
	/** One card per word met (by lemma), packed. */
	cards: Record<string, CardTuple>;
	/**
	 * First-encounter evidence per band from careful answers (learn mode, the level test). With
	 * `scoredFirsts`, it drives the estimate for unseen words.
	 */
	firsts: Record<string, Evidence>;
	/** First-encounter evidence per band from scored play (see EvidenceKind). */
	scoredFirsts: Record<string, Evidence>;
	/**
	 * Words whose first answer is in the evidence but that have no card: missed outside learn
	 * mode, or answered right where a lucky guess was about as likely. Their later answers are
	 * not first encounters again, so one word never counts twice.
	 */
	met: Record<string, 1>;
	placement: PlacementResult | null;
	plan: Plan | null;
	/** Today's starting point for the plan; see Morning. */
	morning: Morning | null;
	/**
	 * Per local day (YYYY-MM-DD), learn mode's: [newIntroduced, reviews, correct, answerMs,
	 * estimateSnapshot, quota]. newIntroduced counts first encounters and reviews every other
	 * answer, so the two add up to the day's learn-mode answers; other modes and the level test
	 * are not counted. answerMs is time spent answering (a timeout counts the full window).
	 * estimateSnapshot is the latest vocabulary estimate of that day. quota is the day's new-word
	 * quota as learn mode worked it out, keep-going extensions aside (0 if it never did).
	 */
	days: Record<string, DayTally>;
	/** The last LOG_LIMIT recorded answers, oldest first. */
	log: LogEntry[];
}

export interface Recorded {
	grade: Grade;
	/** The word had no card before this answer. */
	firstEncounter: boolean;
	/** This answer created the word's card. */
	created: boolean;
	/**
	 * A first answer fast enough for Easy was held at Good, because a lucky guess is still likely
	 * in the word's band. Learn mode verifies the word once more in a new sentence.
	 */
	verify: boolean;
}

const DAY = 86_400;
/** The frontier is the lowest open band whose unseen words are known with less than this probability. */
const FRONTIER_P = 0.8;
/**
 * A fast first answer is Easy only in bands known with at least this probability, where
 * P(known | correct) = p / (p + (1 − p)/4) ≥ 0.97. Elsewhere it is held at Good until verified.
 */
const EASY_FIRST_P = 0.9;
/**
 * Outside learn mode's introductions a correct first answer makes a card only in bands known with
 * at least this probability, where P(known | correct) ≈ 0.8. Below it the answer may well be a
 * lucky guess: it stays evidence, and the word waits for learn mode to reach it.
 */
const CARD_P = 0.5;
/**
 * Without a level test, a band needs this many first answers before the frontier moves past it,
 * so a learner who skipped the test climbs from the most common words on, a band at a time.
 */
const CLIMB_EVIDENCE = 5;
/** A word first answered wrong counts as learned from this stability (days). */
const LEARNED_DAYS = 7;
/** New words a day without a plan, and once a plan has run out unreached. */
export const DEFAULT_DAILY_NEW = 30;
/** Ceiling on the planned new words a day, however far behind the plan is. */
export const MAX_DAILY_NEW = 150;
/**
 * Workload model, per word introduced, its in-session steps and reviews over the following
 * weeks included. Calibrated on simulated 30-day courses at about 5.5 s an item: a word new to
 * the learner takes 5–7 items, but many introductions are words already known, confirmed in
 * one or two, which brings the average to four or five items.
 */
const SECONDS_PER_NEW_WORD = 25;
/**
 * The default plan aims DEFAULT_GAIN words beyond the estimate in DEFAULT_PLAN_DAYS. Only a third
 * to a half of the words met at the frontier are new to the learner, so this takes some 35–55
 * introductions a day, 15–25 minutes: a pace most learners can keep up.
 */
const DEFAULT_GAIN = 1000;
const DEFAULT_PLAN_DAYS = 60;
/** A goal counts as reached once the learner is past it with 80% probability: this quantile of the size. */
const SURE_QUANTILE = 0.2;

export const TARGETS = [2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000];
export const DURATIONS = [14, 30, 60, 90];

/** Response-time calibration: correct answers on mature cards needed, and the percentiles used. */
const CALIBRATION_MIN = 30;
const EASY_PERCENTILE = 0.4;
const EASY_RANGE = [1200, 2500] as const;
const HARD_PERCENTILE = 0.9;
const HARD_RANGE = [3500, 6000] as const;

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- Persistence ----

export function emptyLearner(): LearnerState {
	return {
		v: 1,
		cards: {},
		firsts: {},
		scoredFirsts: {},
		met: {},
		placement: null,
		plan: null,
		morning: null,
		days: {},
		log: []
	};
}

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validPlan(plan: unknown): plan is Plan {
	if (!isRecord(plan)) return false;
	const p = plan as Partial<Plan>;
	return (
		typeof p.target === 'number' &&
		p.target > 0 &&
		typeof p.days === 'number' &&
		p.days > 0 &&
		typeof p.start === 'string' &&
		Number.isFinite(dayNumber(p.start))
	);
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isNumbers = (x: unknown): x is number[] => Array.isArray(x) && x.every(isFiniteNumber);

/** A stored card: eight numbers, the stability positive (at zero, recall can come out NaN). */
function isCardTuple(x: unknown): x is CardTuple {
	return isNumbers(x) && x.length === 8 && x[0] > 0;
}

/** Stored evidence: [answers, correct], with the position sum since it was added. */
function isEvidence(x: unknown): x is number[] {
	return isNumbers(x) && (x.length === 2 || x.length === 3) && x[0] >= 0;
}

/** A stored tally: the quota slot came later. */
function isDayTally(x: unknown): x is number[] {
	return isNumbers(x) && (x.length === 5 || x.length === 6);
}

function isMorning(x: unknown): x is Morning {
	if (!isRecord(x)) return false;
	const m = x as Partial<Morning>;
	return (
		typeof m.day === 'string' &&
		isFiniteNumber(m.estimate) &&
		isFiniteNumber(m.sure) &&
		isFiniteNumber(m.frontier) &&
		isNumbers(m.p) &&
		isNumbers(m.unseen) &&
		m.p.length === m.unseen.length
	);
}

/**
 * The entries of a stored record that pass `valid`. A malformed entry is dropped on loading
 * rather than left to break a page later; Object.fromEntries keeps any key an own property.
 */
function validEntries<T>(x: unknown, valid: (value: unknown, key: string) => boolean): Record<string, T> {
	if (!isRecord(x)) return {};
	return Object.fromEntries(Object.entries(x).filter(([key, value]) => valid(value, key))) as Record<string, T>;
}

/** Stored evidence for bands 1–99 (without a lexicon at hand, the highest key sizes the band model's grid). */
function loadEvidence(x: unknown): Record<string, Evidence> {
	const valid = validEntries<number[]>(x, (value, key) => isEvidence(value) && /^[1-9]\d?$/.test(key));
	// Evidence saved before positions were kept counts as spread evenly over its band.
	return Object.fromEntries(Object.entries(valid).map(([band, [n, c, at = n / 2]]) => [band, [n, c, at]]));
}

function isLogEntry(x: unknown): x is LogEntry {
	return (
		Array.isArray(x) &&
		x.length === 7 &&
		typeof x[0] === 'string' &&
		typeof x[3] === 'number' &&
		typeof x[5] === 'number' &&
		typeof x[6] === 'number'
	);
}

/** The saved learner, or a fresh one when there is none (or storage is unavailable). */
export function loadLearner(): LearnerState {
	let raw: unknown = null;
	try {
		const text = localStorage.getItem(LEARN_KEY);
		raw = text ? JSON.parse(text) : null;
	} catch {
		raw = null;
	}
	if (!isRecord(raw) || raw.v !== 1) return emptyLearner();
	const saved = raw as Partial<LearnerState>;
	const placement = saved.placement;
	const days = validEntries<number[]>(saved.days, (value, key) => isDayTally(value) && Number.isFinite(dayNumber(key)));
	return {
		v: 1,
		cards: validEntries(saved.cards, isCardTuple),
		firsts: loadEvidence(saved.firsts),
		scoredFirsts: loadEvidence(saved.scoredFirsts),
		met: validEntries(saved.met, (value) => value === 1),
		placement:
			isRecord(placement) &&
			Array.isArray(placement.perBand) &&
			isFiniteNumber(placement.at) &&
			isFiniteNumber(placement.estimate)
				? placement
				: null,
		plan: validPlan(saved.plan) ? saved.plan : null,
		morning: isMorning(saved.morning) ? saved.morning : null,
		days: Object.fromEntries(Object.entries(days).map(([key, [a, b, c, d, e, quota = 0]]) => [key, [a, b, c, d, e, quota]])),
		// States saved before the log existed load with an empty one.
		log: Array.isArray(saved.log) ? saved.log.filter(isLogEntry).slice(-LOG_LIMIT) : []
	};
}

export function saveLearner(state: LearnerState): void {
	try {
		localStorage.setItem(LEARN_KEY, JSON.stringify(state));
	} catch {
		// Storage can be full or blocked (private mode); learning continues without saving.
	}
}

// ---- Grading ----

/** Linearly interpolated quantile of ascending values. */
function quantile(sorted: ArrayLike<number>, q: number): number {
	const i = (sorted.length - 1) * q;
	const lo = Math.floor(i);
	const hi = Math.min(sorted.length - 1, lo + 1);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Response-time cut-offs for this learner. Reading speed and tapping differ a lot between
 * people, so once the log holds CALIBRATION_MIN correct answers on mature cards (stability
 * ≥ MASTERED_DAYS when answered: words they surely know), Easy becomes their 40th percentile
 * of those times and Hard starts beyond their 90th, each clamped to a sane range. Until then
 * the defaults apply.
 */
export function gradeThresholds(state: LearnerState): GradeThresholds {
	const times: number[] = [];
	for (const entry of state.log) if (entry[5] === 0 && entry[6] >= MASTERED_DAYS) times.push(entry[3]);
	if (times.length < CALIBRATION_MIN) return { ...DEFAULT_THRESHOLDS };
	// Runs on every answer: a typed array sorts numbers natively, without a comparator.
	const sorted = Float64Array.from(times).sort();
	return {
		easy: Math.round(clamp(quantile(sorted, EASY_PERCENTILE), ...EASY_RANGE)),
		hard: Math.round(clamp(quantile(sorted, HARD_PERCENTILE), ...HARD_RANGE))
	};
}

// ---- Recording answers ----

function dayOf(state: LearnerState, now: number): DayTally {
	const key = dayKey(new Date(now));
	return (state.days[key] ??= [0, 0, 0, 0, 0, 0]);
}

/** Where `info`'s rank lies in its band: 0 at the band's most frequent word, towards 1 at its rarest; mid-band without the band size. */
function positionOf(info: WordInfo, bandSize?: number): number {
	return bandSize ? clamp((info.rank - 0.5) / bandSize - (info.band - 1), 0, 1) : 0.5;
}

/** One more first-encounter answer in `info`'s band of `record`. */
function addFirst(record: Record<string, Evidence>, info: WordInfo, correct: boolean, bandSize?: number): void {
	const first = (record[String(info.band)] ??= [0, 0, 0]);
	first[0]++;
	if (correct) first[1]++;
	// Four decimals keep the stored sum short; rounding moves it by at most half a position in ten thousand answers.
	first[2] = Math.round((first[2] + positionOf(info, bandSize)) * 1e4) / 1e4;
}

/**
 * After an answer to `lemma`: a word with a card is no longer only met; one without a card whose
 * first answer was just counted is.
 */
function settle(state: LearnerState, lemma: string, counted: boolean): void {
	if (own(state.cards, lemma)) {
		if (own(state.met, lemma)) delete state.met[lemma];
	} else if (counted) {
		state.met[lemma] = 1;
	}
}

const OUTCOME_CODES: Record<Result['outcome'], LogOutcome> = { correct: 0, incorrect: 1, timeout: 2 };

interface AnswerContext {
	/** Learn mode's introductions: a missed first encounter still gets a card. */
	introduce: boolean;
	/** A learn-mode answer, counted in the day's tally. */
	learn: boolean;
	/** Epoch milliseconds of the answer. */
	now: number;
	questionId: string;
	/** Probability that an unseen word of each band is known (index band − 1). */
	p: number[];
	thresholds: GradeThresholds;
}

/** Card, log and today's tally for one answer. First-encounter evidence is the caller's job. */
function applyAnswer(state: LearnerState, info: WordInfo, result: Result, ctx: AnswerContext): Recorded {
	const sec = Math.floor(ctx.now / 1000);
	const lemma = info.word;
	let grade = gradeOf(result, ctx.thresholds);
	let created = false;
	let verify = false;
	const before = own(state.cards, lemma) ? unpackCard(state.cards[lemma]) : null;
	if (before) {
		state.cards[lemma] = packCard(review(before, grade, sec));
	} else {
		const p = ctx.p[info.band - 1] ?? 0;
		const held = grade === 4 && p < EASY_FIRST_P;
		if (held) grade = 3;
		if (ctx.introduce || (grade > 1 && p >= CARD_P)) {
			state.cards[lemma] = packCard(newCard(grade, sec));
			created = true;
			verify = held;
		}
	}
	// Two decimals keep every card (S ≥ 0.01) apart from a first encounter (0).
	const stability = before ? Math.round(before.s * 100) / 100 : 0;
	state.log.push([lemma, sec, grade, Math.round(result.ms), ctx.questionId, OUTCOME_CODES[result.outcome], stability]);
	if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);

	if (ctx.learn) {
		const day = dayOf(state, ctx.now);
		if (before) day[1]++;
		else day[0]++;
		if (result.outcome === 'correct') day[2]++;
		day[3] += Math.round(result.ms);
	}
	return { grade, firstEncounter: !before, created, verify };
}

/** Band count when no lexicon is given: the highest band with evidence or being answered. */
function bandsInSight(state: LearnerState, band: number): number {
	let bands = band;
	for (const record of [state.firsts, state.scoredFirsts]) {
		for (const key in record) bands = Math.max(bands, Number(key) || 0);
	}
	return bands;
}

interface RecordOptions {
	introduce: boolean;
	learn: boolean;
	evidence: EvidenceKind;
	now: number;
	lex?: Lexicon;
	questionId: string;
}

/** recordAnswer, with learn mode's options spelled out: Course asks probes without introducing them. */
function record(state: LearnerState, info: WordInfo, result: Result, o: RecordOptions): Recorded {
	const thresholds = gradeThresholds(state);
	if (o.lex) startDay(state, o.lex, o.now);
	const first = !own(state.cards, info.word);
	const counts = first && o.evidence !== 'none' && !own(state.met, info.word);
	// Judged by what was known before this answer; then the answer joins the evidence.
	const p = !first
		? []
		: o.lex
			? posteriorFor(state, o.lex).mean
			: posteriorOf(...samplesOf(state, bandsInSight(state, info.band)), null).mean;
	if (counts) {
		const into = o.evidence === 'scored' ? state.scoredFirsts : state.firsts;
		addFirst(into, info, result.outcome === 'correct', o.lex?.bandSize);
	}
	const recorded = applyAnswer(state, info, result, {
		introduce: o.introduce,
		learn: o.learn,
		now: o.now,
		questionId: o.questionId,
		p,
		thresholds
	});
	settle(state, info.word, counts);
	return recorded;
}

/**
 * Fold one answer into the learner (mutates `state`). A word with a card gets an FSRS review
 * graded by the learner's response-time thresholds. The first answer to a word joins its band's
 * evidence, once: a word answered before without getting a card (see LearnerState.met) does not
 * count again. A first encounter creates a card when `introduce` is set (learn mode), even if
 * wrong, so a missed word starts being learned; elsewhere only when correct in a band known with
 * p ≥ 0.5, where it is unlikely to be a guess. A fast first answer is held at Good unless its band
 * is well known (see Recorded.verify). Every answer is logged; learn mode's are tallied by day.
 * Words outside the lexicon (`info` undefined) are ignored.
 *
 * `evidence` says how the answer counts (see EvidenceKind): by default 'careful' in learn mode
 * and 'scored' elsewhere; pass 'none' for a bank the learner chose. Pass `lex` (the built-in
 * lexicon) so first answers are judged against the same band estimates as everywhere else and
 * today's starting point is kept (see Morning), and `questionId` for the log.
 */
export function recordAnswer(
	state: LearnerState,
	info: WordInfo | undefined,
	result: Result,
	opts: { introduce: boolean; now?: number; lex?: Lexicon; questionId?: string; evidence?: EvidenceKind }
): Recorded {
	if (!info) return { grade: gradeOf(result, gradeThresholds(state)), firstEncounter: false, created: false, verify: false };
	return record(state, info, result, {
		introduce: opts.introduce,
		learn: opts.introduce,
		evidence: opts.evidence ?? (opts.introduce ? 'careful' : 'scored'),
		now: opts.now ?? Date.now(),
		lex: opts.lex,
		questionId: opts.questionId ?? ''
	});
}

/** Store the current estimate as today's snapshot; returns it. Course keeps the snapshot current on its own. */
export function recordEstimate(state: LearnerState, lex: Lexicon, now = Date.now()): number {
	const estimate = estimateVocabulary(state, lex, now);
	dayOf(state, now)[4] = estimate;
	return estimate;
}

/** Today's learn-mode tally. */
export function todayTally(
	state: LearnerState,
	now = Date.now()
): { newIntroduced: number; reviews: number; correct: number; answerMs: number } {
	const day = state.days[dayKey(new Date(now))];
	return {
		newIntroduced: day?.[0] ?? 0,
		reviews: day?.[1] ?? 0,
		correct: day?.[2] ?? 0,
		answerMs: day?.[3] ?? 0
	};
}

// ---- Band model ----
//
// What a learner knows of the frequency scale is one falling curve,
//   p(u) = f + (1 − f)·σ(s·(m − u)),
// the share of words known at u on the band scale (band b's words span b − 0.5 to b + 0.5, most
// frequent first): near 1 well below the midpoint m, down to the floor f (scattered knowledge of
// rare words) well above it, with slope s. An answer to an unseen word is correct with probability
// g + (1 − g)·p·(1 − slip): a known word is answered right unless the answer slips (a mis-tap, a
// lapse of attention, the clock in scored play), anything else is a guess among four choices
// (g = 0.25). The slip keeps a stray miss in an easy band from bending the whole curve, and
// applying it to known words only leaves the guessing floor exact, so lucky guesses in rare bands
// are not read as knowledge. The curve gets a posterior over a grid of (m, s, f) from first-
// encounter answers, each band's answers taken at their mean position. The prior is uniform over
// m and s but leans towards low floors: a floor is a claim about thousands of rare words the
// learner was never asked, and under a uniform prior the rarest bands would read as about an
// eighth known before any answer there. Every band borrows strength from the others, so a few
// answers per band already give sensible estimates, and they never rise with rarer bands.
//
// Positions matter because learn mode introduces a band's words from its most frequent on: its
// answers sample the top of the band, and taken at the band's middle they would credit the rest
// with the knowledge of its easiest words. Estimates for a band's unseen words are read at where
// those words lie on average.
//
// Learn mode piles up hundreds of answers in the bands around the frontier and almost none in
// rare bands. A curve this coarse cannot fit hundreds of answers exactly, so with all of them
// the posterior would lock onto one grid shape and swing the rare-band tail between shapes from
// day to day. Each band therefore weighs at most EVIDENCE_CAP answers (tempered likelihood):
// enough to pin its own p within a few points, while the tail stays an honest average.

const GUESS = 0.25;
const SLIP = 0.02;
/** Slip in scored play: racing the clock, a learner misses or times out on known words far more often. */
const SCORED_SLIP = 0.1;
/** Midpoints run from 0 to bands + MIDPOINT_BEYOND in MIDPOINT_STEP steps. */
const MIDPOINT_STEP = 0.25;
const MIDPOINT_BEYOND = 4;
const SLOPES = [0.4, 0.7, 1.0, 1.5, 2.5];
const FLOORS = [0, 0.05, 0.15, 0.3];
/** Prior weight of each floor: rare words count as unknown until answers there say otherwise. */
const FLOOR_PRIOR = [0.4, 0.3, 0.2, 0.1];
/** A band's answers of each kind count as at most this many in the posterior. */
const EVIDENCE_CAP = 100;
/** Grid points below this posterior weight cannot move an estimate; skipping them saves most of the work. */
const NEGLIGIBLE = 1e-12;

interface Grid {
	bands: number;
	/** Number of grid points. */
	points: number;
	/** Midpoint, slope and floor of each point. */
	m: Float64Array;
	s: Float64Array;
	f: Float64Array;
	/** Log prior weight of each point (unnormalised). */
	logPrior: Float64Array;
}

const grids = new Map<number, Grid>();

function gridFor(bands: number): Grid {
	let grid = grids.get(bands);
	if (grid) return grid;
	const midpoints = Math.round((bands + MIDPOINT_BEYOND) / MIDPOINT_STEP) + 1;
	const points = midpoints * SLOPES.length * FLOORS.length;
	grid = {
		bands,
		points,
		m: new Float64Array(points),
		s: new Float64Array(points),
		f: new Float64Array(points),
		logPrior: new Float64Array(points)
	};
	let k = 0;
	for (let mi = 0; mi < midpoints; mi++) {
		for (const s of SLOPES) {
			for (let fi = 0; fi < FLOORS.length; fi++, k++) {
				grid.m[k] = mi * MIDPOINT_STEP;
				grid.s[k] = s;
				grid.f[k] = FLOORS[fi];
				grid.logPrior[k] = Math.log(FLOOR_PRIOR[fi]);
			}
		}
	}
	grids.set(bands, grid);
	return grid;
}

/** p_known at grid point `k` for words at `u` on the band scale. */
function knownAt(grid: Grid, k: number, u: number): number {
	const f = grid.f[k];
	return f + (1 - f) / (1 + Math.exp(-grid.s[k] * (grid.m[k] - u)));
}

/** First answers per band (index band − 1): how many, how many correct, and the sum of their positions. */
interface Sample {
	n: number[];
	c: number[];
	x: number[];
}

const emptySample = (bands: number): Sample => ({
	n: new Array<number>(bands).fill(0),
	c: new Array<number>(bands).fill(0),
	x: new Array<number>(bands).fill(0)
});

/** A lexicon's bands: words in each, and the sum of their positions (index band − 1). */
interface Shape {
	sizes: number[];
	positions: number[];
	key: string;
}

const shapes = new WeakMap<Lexicon, Shape>();

function shapeOf(lex: Lexicon): Shape {
	let shape = shapes.get(lex);
	if (!shape) {
		const sizes = new Array<number>(lex.bands).fill(0);
		const positions = new Array<number>(lex.bands).fill(0);
		for (const w of lex.byRank) {
			if (w.band < 1 || w.band > lex.bands) continue;
			sizes[w.band - 1]++;
			positions[w.band - 1] += positionOf(w, lex.bandSize);
		}
		shape = { sizes, positions, key: `${sizes.join(',')}/${positions.map((x) => x.toFixed(3)).join(',')}` };
		shapes.set(lex, shape);
	}
	return shape;
}

interface Posterior {
	grid: Grid;
	/** Normalised weight of each grid point. */
	weights: Float64Array;
	/** p_known of each band's unseen words by point: known[k · bands + b] (0 for negligible points). */
	known: Float64Array;
	/** Posterior mean of p_known for each band's unseen words. Shared: never mutate. */
	mean: number[];
}

/** Recently used posteriors by evidence; the level test alone walks through a few dozen. */
const POSTERIOR_CACHE = 48;
const posteriors = new Map<string, Posterior>();

/**
 * Where each band's unseen words lie on average on the band scale: the band's positions less
 * those of the words answered, assuming those are the words met. Mid-band without a lexicon.
 */
function unseenAt(careful: Sample, scored: Sample, shape: Shape | null): number[] {
	return careful.n.map((_, b) => {
		const answered = careful.n[b] + scored.n[b];
		const size = shape?.sizes[b] ?? 0;
		const x =
			shape && size > answered
				? clamp((shape.positions[b] - careful.x[b] - scored.x[b]) / (size - answered), 0, 1)
				: 0.5;
		return b + 0.5 + x;
	});
}

/** The band model's posterior after careful and scored first answers; estimates for `shape`'s unseen words. Memoized. */
function posteriorOf(careful: Sample, scored: Sample, shape: Shape | null): Posterior {
	const key = [careful.n, careful.c, careful.x, scored.n, scored.c, scored.x].map((a) => a.join(',')).join('|') + `|${shape?.key}`;
	const cached = posteriors.get(key);
	if (cached) {
		// Refresh its place in the least-recently-used order.
		posteriors.delete(key);
		posteriors.set(key, cached);
		return cached;
	}
	const bands = careful.n.length;
	const grid = gridFor(bands);
	const terms: { n: number; c: number; u: number; keep: number; scale: number }[] = [];
	for (const [sample, slip] of [
		[careful, SLIP],
		[scored, SCORED_SLIP]
	] as const) {
		for (let b = 0; b < bands; b++) {
			const n = sample.n[b];
			if (n <= 0) continue;
			terms.push({
				n,
				c: sample.c[b],
				u: b + 0.5 + clamp(sample.x[b] / n, 0, 1),
				keep: 1 - slip,
				scale: n > EVIDENCE_CAP ? EVIDENCE_CAP / n : 1
			});
		}
	}
	const weights = new Float64Array(grid.points);
	let max = -Infinity;
	for (let k = 0; k < grid.points; k++) {
		let ll = grid.logPrior[k];
		for (const t of terms) {
			const right = GUESS + (1 - GUESS) * knownAt(grid, k, t.u) * t.keep;
			ll += t.scale * (t.c * Math.log(right) + (t.n - t.c) * Math.log(1 - right));
		}
		weights[k] = ll;
		if (ll > max) max = ll;
	}
	let total = 0;
	for (let k = 0; k < grid.points; k++) total += weights[k] = Math.exp(weights[k] - max);
	const at = unseenAt(careful, scored, shape);
	const known = new Float64Array(grid.points * bands);
	const mean = new Array<number>(bands).fill(0);
	for (let k = 0; k < grid.points; k++) {
		const w = (weights[k] /= total);
		if (w < NEGLIGIBLE) continue;
		for (let b = 0, i = k * bands; b < bands; b++, i++) {
			const p = knownAt(grid, k, at[b]);
			known[i] = p;
			mean[b] += w * p;
		}
	}
	const posterior = { grid, weights, known, mean };
	posteriors.set(key, posterior);
	if (posteriors.size > POSTERIOR_CACHE) posteriors.delete(posteriors.keys().next().value!);
	return posterior;
}

/** First-encounter evidence of `record`, cleaned of anything malformed. */
function sampleOf(record: Record<string, Evidence> | undefined, bands: number): Sample {
	const sample = emptySample(bands);
	for (let b = 0; b < bands; b++) {
		const first = record?.[String(b + 1)];
		if (!Array.isArray(first)) continue;
		const n = (sample.n[b] = Math.max(0, Math.floor(Number(first[0])) || 0));
		sample.c[b] = clamp(Math.floor(Number(first[1])) || 0, 0, n);
		const x = Number(first[2]);
		sample.x[b] = Number.isFinite(x) ? clamp(x, 0, n) : n / 2;
	}
	return sample;
}

function samplesOf(state: LearnerState, bands: number): [careful: Sample, scored: Sample] {
	return [sampleOf(state.firsts, bands), sampleOf(state.scoredFirsts, bands)];
}

function posteriorFor(state: LearnerState, lex: Lexicon): Posterior {
	return posteriorOf(...samplesOf(state, lex.bands), shapeOf(lex));
}

/**
 * p_known per band (index band − 1) from first-encounter answer counts: n answers per band,
 * c of them correct, spread evenly over the band. The posterior mean of the band model, so
 * guessing is accounted for and the result never rises with rarer bands. Without evidence it is
 * the prior mean.
 */
export function fitBands(n: number[], c: number[]): number[] {
	return posteriorOf({ n, c, x: n.map((k) => k / 2) }, emptySample(n.length), null).mean.slice();
}

/** Probability that an unseen word of each band is known (index band − 1), non-increasing. */
export function bandEstimates(state: LearnerState, lex: Lexicon): number[] {
	return posteriorFor(state, lex).mean.slice();
}

/** Mean and standard deviation over the posterior of Σ_b p(b)·words[b]. */
function sizeSpread(posterior: Posterior, words: number[]): { mean: number; sd: number } {
	const { grid, weights, known } = posterior;
	let mean = 0;
	let square = 0;
	for (let k = 0; k < grid.points; k++) {
		if (weights[k] < NEGLIGIBLE) continue;
		let size = 0;
		for (let b = 0, i = k * grid.bands; b < grid.bands; b++, i++) size += known[i] * (words[b] ?? 0);
		mean += weights[k] * size;
		square += weights[k] * size * size;
	}
	return { mean, sd: Math.sqrt(Math.max(0, square - mean * mean)) };
}

/** Quantiles (ascending `qs`) over the posterior of Σ_b p(b)·words[b]. */
function sizeQuantiles(posterior: Posterior, words: number[], qs: number[]): number[] {
	const { grid, weights, known } = posterior;
	const points: [size: number, weight: number][] = [];
	for (let k = 0; k < grid.points; k++) {
		// Points without posterior weight cannot move a quantile; skipping them keeps the sort small.
		if (weights[k] < NEGLIGIBLE) continue;
		let size = 0;
		for (let b = 0, i = k * grid.bands; b < grid.bands; b++, i++) size += known[i] * (words[b] ?? 0);
		points.push([size, weights[k]]);
	}
	points.sort((a, b) => a[0] - b[0]);
	const out: number[] = [];
	let cumulative = 0;
	let j = 0;
	for (const [size, weight] of points) {
		cumulative += weight;
		while (j < qs.length && cumulative >= qs[j]) {
			out.push(size);
			j++;
		}
	}
	while (out.length < qs.length) out.push(points[points.length - 1]?.[0] ?? 0);
	return out;
}

interface Census {
	/** Cards per band whose word is in the lexicon. */
	seen: number[];
	mastered: number[];
	/** Σ R(now) over those cards. */
	recall: number;
}

/**
 * Cards looked up word by word along the lexicon: enumerating the keys of a large card record
 * costs several times more than the lookups, and cards outside the lexicon do not count anyway.
 * A card is an array, so names inherited from Object.prototype never pass for one.
 */
function cardOf(cards: LearnerState['cards'], lemma: string): CardTuple | undefined {
	const t = cards[lemma];
	return Array.isArray(t) ? t : undefined;
}

function censusOf(state: LearnerState, lex: Lexicon, now: number): Census {
	const seen = new Array<number>(lex.bands).fill(0);
	const mastered = new Array<number>(lex.bands).fill(0);
	const sec = now / 1000;
	let recall = 0;
	for (const info of lex.byRank) {
		const t = cardOf(state.cards, info.word);
		if (!t || info.band < 1 || info.band > lex.bands) continue;
		const b = info.band - 1;
		seen[b]++;
		if (t[0] >= MASTERED_DAYS) mastered[b]++;
		recall += forgetting(Math.max(0, sec - t[2]) / DAY, t[0]);
	}
	return { seen, mastered, recall };
}

/** Words per band, index band − 1. */
export function bandSizes(lex: Lexicon): number[] {
	return shapeOf(lex).sizes;
}

function unseenOf(sizes: number[], seen: number[]): number[] {
	return sizes.map((size, b) => Math.max(0, size - seen[b]));
}

function unseenKnown(p: number[], unseen: number[]): number {
	let sum = 0;
	for (let b = 0; b < p.length; b++) sum += p[b] * unseen[b];
	return sum;
}

/** First answers needed before a learner who skipped the level test is shown an estimate. */
export const ESTIMATE_MIN_EVIDENCE = 40;

/**
 * Whether the vocabulary estimate means anything yet: after the level test, or once enough first
 * answers have come in. Before that it is only the prior, which no one should be shown as a size.
 */
export function estimateReady(state: LearnerState): boolean {
	if (state.placement) return true;
	let seen = 0;
	for (const [n] of Object.values(state.firsts)) seen += n;
	return seen >= ESTIMATE_MIN_EVIDENCE;
}

/**
 * Expected number of words known now: recall probability of every word met, plus the band
 * estimate for every word not met yet. Rounded to a whole word; see roundEstimate for display.
 */
export function estimateVocabulary(state: LearnerState, lex: Lexicon, now = Date.now()): number {
	const c = censusOf(state, lex, now);
	return Math.round(c.recall + unseenKnown(posteriorFor(state, lex).mean, unseenOf(bandSizes(lex), c.seen)));
}

/**
 * 90% credible interval of estimateVocabulary: its 5th and 95th percentiles under the band
 * model's posterior. The posterior only knows the uncertainty within its family of curves, so a
 * narrower interval held the true size too rarely for advanced learners. Words met count at
 * their recall probability in both bounds. The interval always contains the estimate, which a
 * lumpy posterior could otherwise leave just outside.
 */
export function estimateRange(state: LearnerState, lex: Lexicon, now = Date.now()): { low: number; high: number } {
	const c = censusOf(state, lex, now);
	const posterior = posteriorFor(state, lex);
	const unseen = unseenOf(bandSizes(lex), c.seen);
	const [low, high] = sizeQuantiles(posterior, unseen, [0.05, 0.95]);
	const estimate = Math.round(c.recall + unseenKnown(posterior.mean, unseen));
	return {
		low: Math.min(estimate, Math.round(c.recall + low)),
		high: Math.max(estimate, Math.round(c.recall + high))
	};
}

/**
 * Estimates are shown to the nearest 100 words (10 below 1,000): the level test is no more
 * precise than that, and finer figures would jitter by tens with every answer.
 */
export function roundEstimate(estimate: number): number {
	return estimate < 1000 ? Math.round(estimate / 10) * 10 : Math.round(estimate / 100) * 100;
}

/**
 * Bands climbed, from band 1 on, by a learner without a level test: each has CLIMB_EVIDENCE first
 * answers or nothing left to introduce. Without the test the band model knows the rare bands
 * only from its prior and the shape of the curve, and one right answer in band 1 would place the
 * frontier bands higher. Unlimited once the test has been taken.
 */
function climbedOf(state: LearnerState, careful: Sample, scored: Sample, open: (b: number) => boolean): number {
	if (state.placement) return Infinity;
	let b = 0;
	while (b < careful.n.length && (careful.n[b] + scored.n[b] >= CLIMB_EVIDENCE || !open(b))) b++;
	return b;
}

/**
 * 1-based frontier band: the lowest band that still has words to introduce (`open`) and whose
 * unseen words are known with p < FRONTIER_P, but never beyond the first open band past the
 * `climbed` ones; failing that, the lowest open band.
 */
function frontierOf(p: number[], open: (b: number) => boolean, climbed: number): number {
	for (let b = 0; b < p.length; b++) if (open(b) && (p[b] < FRONTIER_P || b >= climbed)) return b + 1;
	for (let b = 0; b < p.length; b++) if (open(b)) return b + 1;
	return Math.max(1, p.length);
}

/** The frontier: where learn mode introduces new words (see frontierOf). */
function frontierFor(state: LearnerState, lex: Lexicon, p: number[], open: (b: number) => boolean): number {
	return frontierOf(p, open, climbedOf(state, ...samplesOf(state, lex.bands), open));
}

/** Lowest band with unseen words known with p < 0.8, else the lowest band with unseen words. */
export function frontierBand(state: LearnerState, lex: Lexicon): number {
	const sizes = bandSizes(lex);
	const { seen } = censusOf(state, lex, Date.now());
	return frontierFor(state, lex, posteriorFor(state, lex).mean, (b) => seen[b] < sizes[b]);
}

/** 'new' without a card, 'mastered' at stability ≥ MASTERED_DAYS, else 'learning'. `now` is reserved. */
export function wordStatus(state: LearnerState, lemma: string, _now?: number): 'new' | 'learning' | 'mastered' {
	if (!own(state.cards, lemma)) return 'new';
	return state.cards[lemma][0] >= MASTERED_DAYS ? 'mastered' : 'learning';
}

/**
 * Per band: words mastered, learning, estimated known among the unseen, and the rest. The
 * four add up to the band's word count.
 */
export function bandCoverage(
	state: LearnerState,
	lex: Lexicon,
	now = Date.now()
): { band: number; mastered: number; learning: number; estimated: number; unknown: number }[] {
	const p = posteriorFor(state, lex).mean;
	const c = censusOf(state, lex, now);
	return bandSizes(lex).map((size, b) => {
		const mastered = c.mastered[b];
		const learning = c.seen[b] - mastered;
		const estimated = Math.round(p[b] * Math.max(0, size - c.seen[b]));
		return { band: b + 1, mastered, learning, estimated, unknown: Math.max(0, size - mastered - learning - estimated) };
	});
}

/**
 * The words met, split two ways. By origin: `confirmed` were answered correctly at first sight
 * and every time since, at least once more (known, and shown to be); `once` were answered
 * correctly at first sight but not asked again yet, so a lucky guess is still possible;
 * `learned` were missed at some point and have since reached LEARNED_DAYS of stability
 * (genuinely new words that stuck). By strength: `learning` (stability < 21 days) and `mastered`
 * (≥ 21). The two splits overlap: a confirmed word is also learning or mastered, and missed
 * words below LEARNED_DAYS are in no origin count. `now` is reserved.
 */
export function vocabularyBreakdown(
	state: LearnerState,
	_now?: number
): { confirmed: number; once: number; learned: number; learning: number; mastered: number } {
	let confirmed = 0;
	let once = 0;
	let learned = 0;
	let learning = 0;
	let mastered = 0;
	for (const lemma in state.cards) {
		const [s, , , , reps, lapses, , firstGrade] = state.cards[lemma];
		const right = firstGrade > 1 && lapses === 0;
		if (right && reps >= 2) confirmed++;
		else if (right) once++;
		else if (s >= LEARNED_DAYS) learned++;
		if (s >= MASTERED_DAYS) mastered++;
		else learning++;
	}
	return { confirmed, once, learned, learning, mastered };
}

// ---- Reviews ----

/** Cards due now: every card falling due today, since cards fall due at the start of their day. */
export function dueCount(state: LearnerState, now = Date.now()): number {
	const sec = now / 1000;
	let n = 0;
	for (const lemma in state.cards) if (state.cards[lemma][3] <= sec) n++;
	return n;
}

/** Reviews falling due on each of the next `days` local days; index 0 is today, overdue included. */
export function forecast(state: LearnerState, days: number, now = Date.now()): number[] {
	const out = new Array<number>(Math.max(0, days)).fill(0);
	if (!out.length) return out;
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	// Ends of each local day in epoch seconds (DST-safe: built from calendar dates).
	const ends = out.map((_, i) => {
		const d = new Date(midnight);
		d.setDate(d.getDate() + i + 1);
		return d.getTime() / 1000;
	});
	const last = ends[ends.length - 1];
	for (const lemma in state.cards) {
		const due = state.cards[lemma][3];
		if (due >= last) continue;
		let i = 0;
		while (due >= ends[i]) i++;
		out[i]++;
	}
	return out;
}

// ---- Plan ----

/** Days since the epoch of a YYYY-MM-DD date (NaN when malformed). */
function dayNumber(key: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000) : NaN;
}

function dateOf(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD `n` days after `key`. */
export function addDays(key: string, n: number): string {
	return dateOf(dayNumber(key) + n);
}

/**
 * Default goal: 1,000 words beyond the estimate, to the next hundred, in 60 days (see
 * DEFAULT_GAIN). It is not one of the TARGETS: their steps above 5,000 would make the gap two or
 * three times as large.
 */
export function defaultPlan(estimate: number, today: string): Plan {
	return { target: Math.ceil((estimate + DEFAULT_GAIN) / 100) * 100, days: DEFAULT_PLAN_DAYS, start: today };
}

export function setPlan(state: LearnerState, plan: Plan | null): void {
	state.plan = plan ? { target: plan.target, days: plan.days, start: plan.start } : null;
}

/** Rough study minutes a day for this many introductions a day (PlanSummary.dailyNew), reviews included. */
export function studyMinutes(dailyNew: number): number {
	return Math.round((dailyNew * SECONDS_PER_NEW_WORD) / 60);
}

/** The learner as they stand now, as a starting point for the day. */
function standing(state: LearnerState, lex: Lexicon, now: number): Morning {
	const posterior = posteriorFor(state, lex);
	const c = censusOf(state, lex, now);
	const unseen = unseenOf(bandSizes(lex), c.seen);
	const estimate = Math.round(c.recall + unseenKnown(posterior.mean, unseen));
	const [sure] = sizeQuantiles(posterior, unseen, [SURE_QUANTILE]);
	return {
		day: dayKey(new Date(now)),
		estimate,
		sure: Math.min(estimate, Math.round(c.recall + sure)),
		frontier: frontierFor(state, lex, posterior.mean, (b) => unseen[b] > 0),
		p: posterior.mean.map((x) => Math.round(x * 1e4) / 1e4),
		unseen
	};
}

/** Today's starting point: the stored one, or the learner as they stand when today has none yet. */
function morningOf(state: LearnerState, lex: Lexicon, now: number): Morning {
	const m = state.morning;
	return m && m.day === dayKey(new Date(now)) && m.p.length === lex.bands ? m : standing(state, lex, now);
}

/** Keep today's starting point (mutates `state`), unless today already has one. */
function startDay(state: LearnerState, lex: Lexicon, now: number): void {
	const m = morningOf(state, lex, now);
	if (m !== state.morning) state.morning = m;
}

/** Band indices in the order learn mode introduces their words: up from the frontier, then the bands below it. */
function walk(m: Morning): number[] {
	const from = clamp(m.frontier - 1, 0, m.p.length);
	return [...m.p.keys()].slice(from).concat([...m.p.keys()].slice(0, from).reverse());
}

/**
 * Words to introduce for the learner to gain `gain` words, in learn mode's order: each adds what
 * is not known of it already, 1 − p of its band. Infinity when the bank runs out more than half a
 * word short (a goal of the whole bank also needs what was met and forgotten relearned).
 */
function wordsFor(m: Morning, gain: number): number {
	let words = 0;
	for (const b of walk(m)) {
		const per = 1 - m.p[b];
		if (gain <= 0) break;
		if (per <= 0 || m.unseen[b] <= 0) continue;
		const take = Math.min(m.unseen[b], gain / per);
		words += take;
		gain -= take * per;
	}
	return gain > 0.5 ? Infinity : words;
}

/** What introducing `words` words gains, in the same order as wordsFor. */
function gainOf(m: Morning, words: number): number {
	let gain = 0;
	for (const b of walk(m)) {
		if (words <= 0) break;
		const take = Math.min(m.unseen[b], words);
		gain += take * (1 - m.p[b]);
		words -= take;
	}
	return gain;
}

export interface PlanSummary {
	plan: Plan | null;
	/** Estimated vocabulary now. */
	estimate: number;
	/** Days until the deadline, today included; 0 once the plan has run out. */
	daysLeft: number;
	/**
	 * Words introduced each day: the learn-mode quota (Course). An introduction is any word met
	 * for the first time, so this counts words the learner turns out to know already as well.
	 */
	dailyNew: number;
	/**
	 * Words genuinely added to the estimate each day at that pace: the part of dailyNew that is
	 * new to the learner, given how much of the bands ahead they know (never more than dailyNew).
	 * With 120 introductions a day of which a third are unknown, dailyNew is 120 and dailyGain 40:
	 * "≈ 120 words a day, about 40 of them new to you". It is what the deadline asks for, unless
	 * dailyNew is capped at MAX_DAILY_NEW; then it is the smaller gain the capped pace delivers,
	 * and `finish` falls after the deadline. 0 once the target is reached.
	 */
	dailyGain: number;
	/** Rough study minutes a day at that pace, reviews included. */
	minutes: number;
	/**
	 * Date (YYYY-MM-DD) the target is reached at the planned pace; today once reached; null
	 * without a plan or when the bank's words cannot add enough.
	 */
	finish: string | null;
	/** Deadline (YYYY-MM-DD): start + days; the plan runs until the day before. */
	deadline: string | null;
	/** The learner is past the target with 80% probability: no new words are asked for. */
	reached: boolean;
	/**
	 * The deadline has come without the target reached. The quota falls back to
	 * DEFAULT_DAILY_NEW rather than the whole gap in a day, until the plan is changed.
	 */
	expired: boolean;
	/**
	 * Reached; or, before the deadline, the plan's first day; or the target is reachable below
	 * MAX_DAILY_NEW a day and yesterday introduced at least 90% of what it asked.
	 */
	onTrack: boolean;
}

/**
 * The plan's numbers today. Two daily figures describe the pace: `dailyNew`, the words to
 * introduce (the learn-mode quota, words already known included), and `dailyGain`, how many of
 * those are new to the learner and so add to the estimate; see PlanSummary. They are worked out
 * from where the learner stood as the day began (see Morning), so the quota holds all day for
 * every caller, whatever the day's answers do to the estimate; `estimate` is the live value.
 *
 * The goal counts as reached only once the learner is likely past it (80%), not when the
 * estimate merely touches it: the estimate of rare bands rests on few answers and can rise by
 * hundreds of words in a session. Near the goal, what is left is therefore at least half the
 * distance from that cautious figure to the goal, which shrinks to nothing as answers confirm
 * the estimate. A target beyond the bank counts as the whole bank.
 */
export function planSummary(state: LearnerState, lex: Lexicon, now = Date.now()): PlanSummary {
	const plan = state.plan;
	const estimate = estimateVocabulary(state, lex, now);
	if (!plan) {
		return {
			plan: null,
			estimate,
			daysLeft: 0,
			dailyGain: 0,
			dailyNew: 0,
			minutes: 0,
			finish: null,
			deadline: null,
			reached: false,
			expired: false,
			onTrack: true
		};
	}

	const m = morningOf(state, lex, now);
	const today = dayNumber(dayKey(new Date(now)));
	const start = dayNumber(plan.start);
	const from = Number.isFinite(start) ? start : today;
	const end = from + plan.days;
	const daysLeft = Math.max(0, end - today);
	const goal = Math.min(plan.target, lex.byRank.length);
	const gap = Math.max(0, goal - m.estimate, (goal - m.sure) / 2);
	const reached = gap === 0;
	const expired = !reached && daysLeft === 0;

	let dailyNew = 0;
	let dailyGain = 0;
	let finish: string | null = dateOf(today);
	if (!reached) {
		const words = wordsFor(m, gap);
		// A run-out plan keeps a steady pace, rather than ask for the whole gap every day.
		const span = expired ? 1 : daysLeft;
		dailyNew = expired ? DEFAULT_DAILY_NEW : Math.min(MAX_DAILY_NEW, Math.max(1, Math.ceil(words / span)));
		dailyGain = Math.max(1, Math.min(Math.ceil(gap / span), Math.round(gainOf(m, dailyNew * span) / span)));
		finish = Number.isFinite(words) ? dateOf(today + Math.ceil(words / dailyNew)) : null;
	}

	const deadline = dateOf(end);
	// The quota absorbs any shortfall day by day, so judge the last day by what it asked, not the
	// days behind by today's pace: that counted every shortfall twice.
	const yesterday = state.days[dateOf(today - 1)];
	const keptUp = today - 1 < from || (yesterday !== undefined && yesterday[0] >= 0.9 * (yesterday[5] ?? 0));
	const reachable = finish !== null && finish <= deadline && dailyNew < MAX_DAILY_NEW;
	const onTrack = reached || (!expired && (today <= from || (reachable && keptUp)));
	return {
		plan,
		estimate,
		daysLeft,
		dailyGain,
		dailyNew,
		minutes: studyMinutes(dailyNew),
		finish,
		deadline,
		reached,
		expired,
		onTrack
	};
}

// ---- Learn mode ----

/** 'probe': a word from a band far above the frontier, asked for evidence only (see Course). */
export type DrawKind = 'review' | 'new' | 'relearn' | 'check' | 'probe';

export interface Draw {
	question: Question;
	kind: DrawKind;
}

export interface CourseStats {
	/** Words introduced today (all sessions). */
	newToday: number;
	/** Today's new-word quota (the plan's daily figure, or DEFAULT_DAILY_NEW), plus keep-going extensions. */
	quota: number;
	/** Due reviews not answered yet (relearn steps not included). */
	due: number;
	/** Items answered in this session, and how many correctly. */
	items: number;
	correct: number;
	accuracy: number | null;
	/** New words are held back because recent reviews went badly; they resume once accuracy recovers. */
	throttled: boolean;
	/** Nothing is left for today and nothing is waiting for an answer. */
	done: boolean;
}

/** Within-session steps: 1 and 2 relearn a miss; 'check' verifies a new word once. */
interface Step {
	/** Draw index from which the step may be drawn. */
	at: number;
	step: 1 | 2 | 'check';
}

interface Pending {
	index: number;
	kind: DrawKind;
}

const isNew = (kind: DrawKind) => kind === 'new' || kind === 'probe';

/** Items between a miss and its first relearn step, and between the first and second. */
const RELEARN_GAPS = [4, 20] as const;
/** Items before a new word answered Hard, or fast where guessing is likely, is checked again. */
const CHECK_GAP = 12;
/** A word does not come back within this many items. */
const SPACING = 3;
/** New words are picked at random among the next this many unseen words of a band. */
const NEW_POOL = 30;
/** Every this many new words, one comes from below the frontier (gap filling). */
const GAP_FILL_EVERY = 10;
/**
 * One new word in PROBE_EVERY is a probe from a band at least PROBE_ABOVE above the frontier:
 * those bands otherwise get no answers after the level test, and their estimate would rest on
 * the shape of the curve alone. The first comes early (PROBE_SLOT, clear of the gap-filling
 * slots), so even a session with a small quota asks one.
 */
const PROBE_EVERY = 25;
const PROBE_SLOT = 2;
const PROBE_ABOVE = 3;
/** Reviews between new words, and with a large backlog. */
const REVIEWS_PER_NEW = 2;
const BACKLOG = 100;
const BACKLOG_REVIEWS_PER_NEW = 4;
/**
 * Adaptive challenge over the last ROLLING answers to reviews, checks and relearn steps (from
 * ROLLING_MIN on). First encounters are left out: at the frontier their accuracy is low by
 * design, and they must not throttle themselves. So is the first relearn step, the word's
 * return a few items after a miss: its outcome mostly echoes that miss, which would then weigh
 * twice.
 */
const ROLLING = 20;
const ROLLING_MIN = 10;
const THROTTLE_BELOW = 0.8;
const THROTTLE_UNTIL = 0.86;
const SKIP_AHEAD_ABOVE = 0.95;
/**
 * Two new words are not introduced within this many draws of each other when one is among the
 * other's distractors: such words are usually near neighbours in meaning, which interfere.
 */
const INTERFERENCE_WINDOW = 20;
/** A word's sentence avoids its last this many sentences. */
const SENTENCE_MEMORY = 2;
/** Cards below this stability (days) are still fragile: kept out of distractors where possible. */
const FRAGILE_DAYS = 1;
/** New words added by each keepGoing(). */
export const KEEP_GOING_NEW = 20;
/** Seconds between rescans for cards that have fallen due, and between full censuses. */
const DUE_RESCAN_SEC = 60;
const CENSUS_REFRESH_SEC = 60;

/**
 * A learn-mode session over the built-in bank. Each next() picks, in priority order:
 * relearn steps that are due (a missed word comes back after 4 items, then 20 more once
 * right; a new word answered Hard, or fast where a guess is likely, gets one check after 12),
 * due reviews by lowest recall probability, interleaved about 2:1 with new words (4:1 with a
 * backlog over 100), and new words from the frontier band (random among the next 30 unseen,
 * every tenth from below the frontier) up to today's quota. A new word that appears among the
 * distractors of a word introduced in the last 20 draws, or the other way round, waits while
 * another candidate exists.
 *
 * One new word in 25, the third of a session first, is a probe: a random unseen word from the
 * least-answered band at least three above the frontier. It is a first answer like any other, but only gets a card where a
 * correct answer is unlikely to be a guess (as outside learn mode); a missed probe is not
 * drilled, since the word lies far beyond what the learner is working on.
 *
 * Rolling accuracy on reviews, checks and relearn steps (but the first after a miss) below 80%
 * holds new words back until it is 86% again: reviews first, then easier words from below the
 * frontier, then relearn steps brought forward; only with none of those left does a frontier
 * word come in. Above 95%, some new words come from the next band. A word never returns within
 * 3 items unless nothing else is left, and never right after itself: a step left only for the
 * word just answered is dropped, and the card's own again-delay brings the word back later.
 * Each return avoids the word's last two sentences (the log included) and prefers one whose
 * distractors are not words still being learned.
 *
 * Counters are draw-based and next() may run ahead of answer(): a drawn word is not drawn
 * again until answered. next() returns null when nothing can be drawn right now; answering
 * the items still in flight may add relearn steps, so call next() again after each answer
 * and treat the session as finished once it returns null with `stats.done`.
 *
 * answer() records into `state` in place (as learn mode: introduced words get cards, the day is
 * tallied) and updates today's estimate snapshot; the caller persists with saveLearner(state).
 */
export class Course {
	#state: LearnerState;
	#lex: Lexicon;
	#random: () => number;
	#now: () => number;
	#questions = new Map<string, Question[]>();
	/** Per band (index band − 1): words with at least one question, in rank order. */
	#bands: string[][];
	/** Per band: every word before this index has a card. */
	#cursor: number[];
	#steps = new Map<string, Step>();
	#pending = new Map<string, Pending>();
	#pendingNew = 0;
	/** Lemmas of the last SPACING draws. */
	#recent: string[] = [];
	/** Per word: ids of its last SENTENCE_MEMORY sentences, oldest first. */
	#sentences = new Map<string, string[]>();
	/** Per word: the distractors of all its sentences, built on first use. */
	#distractors = new Map<string, Set<string>>();
	/** New words drawn within the last INTERFERENCE_WINDOW draws, with their draw index. */
	#introduced: { lemma: string; index: number }[] = [];
	#draws = 0;
	#newDrawn = 0;
	#reviewsSinceNew = 0;
	/** Due words, highest recall first: the queue is taken from the end. */
	#due: string[] = [];
	#dueScannedAt = -Infinity;
	/** Correctness of the last ROLLING answers that count towards the throttle (see ROLLING). */
	#rolling: boolean[] = [];
	#throttled = false;
	#skipAhead = false;
	#items = 0;
	#correct = 0;
	#quotaDay = '';
	#dailyQuota = 0;
	#extra = 0;
	/**
	 * Running census behind today's estimate snapshot, which is refreshed after every answer.
	 * A full census walks every word, so it runs at most once a minute; in between it is adjusted
	 * for the answered card alone, as other cards' recall barely moves within a minute.
	 */
	#census: { at: number; seen: number[]; recall: number } | null = null;

	constructor(
		state: LearnerState,
		lex: Lexicon,
		questions: Question[],
		opts: { random?: () => number; now?: () => number } = {}
	) {
		this.#state = state;
		this.#lex = lex;
		this.#random = opts.random ?? Math.random;
		this.#now = opts.now ?? Date.now;
		for (const q of questions) {
			if (!lex.words.has(q.lemma)) continue;
			const list = this.#questions.get(q.lemma);
			if (list) list.push(q);
			else this.#questions.set(q.lemma, [q]);
		}
		this.#bands = Array.from({ length: lex.bands }, () => [] as string[]);
		for (const w of lex.byRank) if (this.#questions.has(w.word)) this.#bands[w.band - 1]?.push(w.word);
		this.#cursor = new Array<number>(lex.bands).fill(0);
		// Each word's last sentences from earlier sessions: the log walked newest first, kept oldest first.
		for (let i = state.log.length - 1; i >= 0; i--) {
			const [lemma, , , , id] = state.log[i];
			if (!id || !this.#questions.has(lemma)) continue;
			const ids = this.#sentences.get(lemma) ?? [];
			if (ids.length < SENTENCE_MEMORY && !ids.includes(id)) this.#sentences.set(lemma, [id, ...ids]);
		}
	}

	next(): Draw | null {
		const now = this.#now();
		this.#scanDue(now / 1000);
		const pick = this.#choose(now);
		if (!pick) return null;
		const [lemma, kind] = pick;
		const question = this.#sentence(lemma);
		this.#pending.set(lemma, { index: this.#draws, kind });
		if (isNew(kind)) {
			this.#pendingNew++;
			this.#newDrawn++;
			this.#reviewsSinceNew = 0;
			this.#introduced.push({ lemma, index: this.#draws });
		} else if (kind === 'review') {
			this.#reviewsSinceNew++;
		}
		this.#draws++;
		while (this.#introduced.length && this.#introduced[0].index < this.#draws - INTERFERENCE_WINDOW) {
			this.#introduced.shift();
		}
		this.#recent.push(lemma);
		if (this.#recent.length > SPACING) this.#recent.shift();
		return { question, kind };
	}

	answer(question: Question, result: Result): Recorded {
		const lemma = question.lemma;
		const now = this.#now();
		const drawn = this.#pending.get(lemma);
		if (drawn) {
			this.#pending.delete(lemma);
			if (isNew(drawn.kind)) this.#pendingNew--;
		}
		const info = this.#lex.words.get(lemma);
		if (!info) return recordAnswer(this.#state, info, result, { introduce: true, now });
		const before = cardOf(this.#state.cards, lemma);
		const recallBefore = before ? forgetting(Math.max(0, now / 1000 - before[2]) / DAY, before[0]) : 0;
		// The word's last answer was a miss: this is its first relearn step.
		const afterMiss = this.#steps.get(lemma)?.step === 1;
		const recorded = record(this.#state, info, result, {
			introduce: drawn?.kind !== 'probe',
			learn: true,
			evidence: 'careful',
			now,
			lex: this.#lex,
			questionId: question.id
		});
		this.#remember(lemma, question.id);

		const correct = result.outcome === 'correct';
		this.#items++;
		if (correct) this.#correct++;
		if (!recorded.firstEncounter && !afterMiss) {
			this.#rolling.push(correct);
			if (this.#rolling.length > ROLLING) this.#rolling.shift();
			this.#adapt();
		}

		if (this.#questions.has(lemma)) this.#schedule(lemma, drawn?.index ?? this.#draws - 1, recorded);
		this.#snapshot(now, info, before !== undefined, recallBefore);
		return recorded;
	}

	/** Today's estimate snapshot after an answer to `info`, whose card had `recallBefore` (0 if new). */
	#snapshot(now: number, info: WordInfo, had: boolean, recallBefore: number): void {
		const sec = now / 1000;
		let census = this.#census;
		if (!census || sec - census.at >= CENSUS_REFRESH_SEC) {
			const full = censusOf(this.#state, this.#lex, now);
			census = this.#census = { at: sec, seen: full.seen, recall: full.recall };
		} else if (cardOf(this.#state.cards, info.word) && info.band >= 1 && info.band <= this.#lex.bands) {
			// Just answered, so its recall is 1 now.
			census.recall += 1 - recallBefore;
			if (!had) census.seen[info.band - 1]++;
		}
		const p = posteriorFor(this.#state, this.#lex).mean;
		const estimate = census.recall + unseenKnown(p, unseenOf(bandSizes(this.#lex), census.seen));
		dayOf(this.#state, now)[4] = Math.round(estimate);
	}

	/** Allow KEEP_GOING_NEW more new words today beyond the quota. */
	keepGoing(): void {
		const now = this.#now();
		const used = todayTally(this.#state, now).newIntroduced + this.#pendingNew;
		this.#extra += Math.max(0, used - this.#quota(now)) + KEEP_GOING_NEW;
	}

	get stats(): CourseStats {
		const now = this.#now();
		const sec = now / 1000;
		this.#scanDue(sec);
		const newToday = todayTally(this.#state, now).newIntroduced;
		const quota = this.#quota(now);
		const due = this.#dueLeft(sec);
		// With nothing in flight, a step can still be drawn unless it is for the word just answered.
		const last = this.#recent[this.#recent.length - 1];
		const stepsLeft = [...this.#steps.keys()].some((lemma) => lemma !== last);
		const done =
			this.#pending.size === 0 &&
			!stepsLeft &&
			due === 0 &&
			!(newToday < quota && this.#bands.some((_, b) => this.#open(b)));
		return {
			newToday,
			quota,
			due,
			items: this.#items,
			correct: this.#correct,
			accuracy: this.#items ? this.#correct / this.#items : null,
			throttled: this.#throttled,
			done
		};
	}

	#choose(now: number): [string, DrawKind] | null {
		const sec = now / 1000;
		// 1. Relearn steps whose turn has come.
		const step = this.#step(true, SPACING);
		if (step) return step;

		// 2–3. Due reviews, interleaved with new words while the quota lasts.
		const room = this.#quota(now) - todayTally(this.#state, now).newIntroduced - this.#pendingNew > 0;
		let review = this.#review(sec, SPACING);
		if (room && !this.#throttled) {
			const ratio = this.#dueLeft(sec) > BACKLOG ? BACKLOG_REVIEWS_PER_NEW : REVIEWS_PER_NEW;
			if (review < 0 || this.#reviewsSinceNew >= ratio) {
				const word = this.#pickNew();
				if (word) return word;
			}
		}
		if (review >= 0) return [this.#due.splice(review, 1)[0], 'review'];

		// 4. Held back by the throttle with nothing due: an easier word from below the frontier.
		if (room && this.#throttled) {
			const word = this.#pickNew(true);
			if (word) return word;
		}
		// 5. Nothing due: bring relearn steps forward rather than stop.
		const early = this.#step(false, SPACING);
		if (early) return early;
		// 6. Still under quota with nothing else to practise: a frontier word after all.
		if (room) {
			const word = this.#pickNew();
			if (word) return word;
		}
		// 7. Only recently seen words are left: one may come back with another item in between,
		// never twice in a row, which would only test whether the answer is still on screen.
		const late = this.#step(false, 1);
		if (late) return late;
		review = this.#review(sec, 1);
		if (review >= 0) return [this.#due.splice(review, 1)[0], 'review'];
		return null;
	}

	/** The step to draw next, earliest first: only those whose turn has come if `due`, none for the last `spacing` draws. */
	#step(due: boolean, spacing: number): [string, DrawKind] | null {
		const recent = this.#recent.slice(-spacing);
		let best: string | null = null;
		let at = Infinity;
		for (const [lemma, step] of this.#steps) {
			if (step.at >= at || (due && step.at > this.#draws) || this.#pending.has(lemma)) continue;
			if (recent.includes(lemma)) continue;
			best = lemma;
			at = step.at;
		}
		if (best === null) return null;
		return [best, this.#steps.get(best)?.step === 'check' ? 'check' : 'relearn'];
	}

	/** Index in the due queue of the review to draw next (none for the last `spacing` draws), or −1. Drops stale entries. */
	#review(sec: number, spacing: number): number {
		const cards = this.#state.cards;
		const recent = this.#recent.slice(-spacing);
		for (let i = this.#due.length - 1; i >= 0; i--) {
			const lemma = this.#due[i];
			if (!own(cards, lemma) || cards[lemma][3] > sec || this.#steps.has(lemma)) {
				this.#due.splice(i, 1);
				continue;
			}
			if (this.#pending.has(lemma) || recent.includes(lemma)) continue;
			return i;
		}
		return -1;
	}

	/** Due reviews not answered yet, in flight included. */
	#dueLeft(sec: number): number {
		const cards = this.#state.cards;
		let n = 0;
		for (const lemma of this.#due) {
			if (own(cards, lemma) && cards[lemma][3] <= sec && !this.#steps.has(lemma)) n++;
		}
		return n;
	}

	#scanDue(sec: number): void {
		if (sec - this.#dueScannedAt < DUE_RESCAN_SEC) return;
		this.#dueScannedAt = sec;
		const due: [string, number][] = [];
		for (const words of this.#bands) {
			for (const lemma of words) {
				const t = cardOf(this.#state.cards, lemma);
				if (!t || t[3] > sec || this.#steps.has(lemma)) continue;
				due.push([lemma, forgetting(Math.max(0, sec - t[2]) / DAY, t[0])]);
			}
		}
		due.sort((a, b) => b[1] - a[1]);
		this.#due = due.map(([lemma]) => lemma);
	}

	#quota(now: number): number {
		const day = dayKey(new Date(now));
		if (day !== this.#quotaDay) {
			this.#quotaDay = day;
			this.#extra = 0;
			this.#dailyQuota = this.#state.plan
				? planSummary(this.#state, this.#lex, now).dailyNew
				: DEFAULT_DAILY_NEW;
			// What the day asked, for judging tomorrow whether the plan was kept up.
			dayOf(this.#state, now)[5] = this.#dailyQuota;
		}
		return this.#dailyQuota + this.#extra;
	}

	/** The next new word: from the frontier band, or only from below it when `easier`; now and then a probe. */
	#pickNew(easier = false): [string, DrawKind] | null {
		const bands = this.#bands.length;
		const p = posteriorFor(this.#state, this.#lex).mean;
		const frontier = frontierFor(this.#state, this.#lex, p, (b) => this.#open(b)) - 1;
		const fresh = (word: string | null): [string, DrawKind] | null => (word ? [word, 'new'] : null);
		if (easier) {
			for (let b = frontier - 1; b >= 0; b--) {
				const word = this.#pickIn(b);
				if (word) return fresh(word);
			}
			return null;
		}
		if (this.#newDrawn % PROBE_EVERY === PROBE_SLOT) {
			const word = this.#probe(frontier + PROBE_ABOVE);
			if (word) return [word, 'probe'];
		}
		if (this.#newDrawn % GAP_FILL_EVERY === GAP_FILL_EVERY - 1) {
			for (let b = 0; b < frontier; b++) {
				const word = this.#pickIn(b);
				if (word) return fresh(word);
			}
		}
		if (this.#skipAhead && frontier + 1 < bands && this.#random() < 0.5) {
			const word = this.#pickIn(frontier + 1);
			if (word) return fresh(word);
		}
		for (let b = frontier; b < bands; b++) {
			const word = this.#pickIn(b);
			if (word) return fresh(word);
		}
		for (let b = frontier - 1; b >= 0; b--) {
			const word = this.#pickIn(b);
			if (word) return fresh(word);
		}
		return null;
	}

	/**
	 * A probe: a random word, neither met nor in flight, from the band index `from` or above with
	 * the fewest first answers (ties at random). Null without such a band.
	 */
	#probe(from: number): string | null {
		const [careful, scored] = samplesOf(this.#state, this.#lex.bands);
		let best: string[] = [];
		let fewest = Infinity;
		let ties = 0;
		for (let b = Math.max(0, from); b < this.#bands.length; b++) {
			const answered = careful.n[b] + scored.n[b];
			if (answered > fewest) continue;
			const words = this.#bands[b].filter(
				(w) => !own(this.#state.cards, w) && !own(this.#state.met, w) && !this.#pending.has(w)
			);
			if (!words.length) continue;
			ties = answered < fewest ? 1 : ties + 1;
			fewest = answered;
			// Each tied band is kept with probability 1/ties, so all of them are equally likely.
			if (ties === 1 || this.#random() * ties < 1) best = words;
		}
		return best.length ? best[Math.floor(this.#random() * best.length)] : null;
	}

	/** Moves band index `b`'s cursor past the words that have cards; returns it. */
	#advance(b: number): number {
		const words = this.#bands[b] ?? [];
		let i = this.#cursor[b] ?? 0;
		while (i < words.length && own(this.#state.cards, words[i])) i++;
		this.#cursor[b] = i;
		return i;
	}

	/** Band index `b` has a word that could be introduced now. */
	#open(b: number): boolean {
		const words = this.#bands[b] ?? [];
		for (let i = this.#advance(b); i < words.length; i++) {
			if (!own(this.#state.cards, words[i]) && !this.#pending.has(words[i])) return true;
		}
		return false;
	}

	/**
	 * A random word among the next NEW_POOL unseen words of band index `b`, leaving out words
	 * confusable with one introduced recently unless nothing else is left.
	 */
	#pickIn(b: number): string | null {
		const words = this.#bands[b] ?? [];
		const cards = this.#state.cards;
		const pool: string[] = [];
		for (let i = this.#advance(b); i < words.length && pool.length < NEW_POOL; i++) {
			if (!own(cards, words[i]) && !this.#pending.has(words[i])) pool.push(words[i]);
		}
		if (!pool.length) return null;
		const clear = pool.filter((word) => !this.#confusable(word));
		const options = clear.length ? clear : pool;
		return options[Math.floor(this.#random() * options.length)];
	}

	/** A word introduced within INTERFERENCE_WINDOW draws is among this word's distractors, or the reverse. */
	#confusable(word: string): boolean {
		const mine = this.#distractorsOf(word);
		return this.#introduced.some(
			({ lemma }) => lemma !== word && (mine.has(lemma) || this.#distractorsOf(lemma).has(word))
		);
	}

	#distractorsOf(lemma: string): Set<string> {
		let set = this.#distractors.get(lemma);
		if (!set) {
			set = new Set<string>();
			for (const q of this.#questions.get(lemma) ?? []) {
				for (const d of DIRECTIONS) if (d !== q.answer) set.add(q.choices[d]);
			}
			this.#distractors.set(lemma, set);
		}
		return set;
	}

	#hasFragileDistractor(q: Question): boolean {
		const cards = this.#state.cards;
		return DIRECTIONS.some((d) => {
			if (d === q.answer) return false;
			const word = q.choices[d];
			return own(cards, word) && cards[word][0] < FRAGILE_DAYS;
		});
	}

	/**
	 * The word's next sentence, at random among those not used for its last two draws (or at
	 * least not the last one), preferring sentences whose distractors are not fragile words.
	 */
	#sentence(lemma: string): Question {
		const list = this.#questions.get(lemma) ?? [];
		const used = this.#sentences.get(lemma) ?? [];
		let options = list.filter((q) => !used.includes(q.id));
		if (!options.length) options = list.filter((q) => q.id !== used[used.length - 1]);
		if (!options.length) options = list;
		const calm = options.filter((q) => !this.#hasFragileDistractor(q));
		if (calm.length) options = calm;
		const question = options[Math.floor(this.#random() * options.length)];
		this.#remember(lemma, question.id);
		return question;
	}

	#remember(lemma: string, id: string): void {
		const used = this.#sentences.get(lemma) ?? [];
		if (used[used.length - 1] === id) return;
		this.#sentences.set(lemma, [...used.filter((x) => x !== id), id].slice(-SENTENCE_MEMORY));
	}

	#schedule(lemma: string, index: number, { grade, firstEncounter, created, verify }: Recorded): void {
		// A probe that got no card is not being learned: nothing to bring back.
		if (firstEncounter && !created) return;
		const step = this.#steps.get(lemma);
		if (grade === 1) this.#steps.set(lemma, { at: index + RELEARN_GAPS[0] + 1, step: 1 });
		else if (step?.step === 1) this.#steps.set(lemma, { at: index + RELEARN_GAPS[1] + 1, step: 2 });
		else if (step) this.#steps.delete(lemma);
		else if (created && (grade === 2 || verify)) this.#steps.set(lemma, { at: index + CHECK_GAP + 1, step: 'check' });
	}

	#adapt(): void {
		const n = this.#rolling.length;
		if (n < ROLLING_MIN) return;
		const accuracy = this.#rolling.filter(Boolean).length / n;
		if (accuracy < THROTTLE_BELOW) this.#throttled = true;
		else if (accuracy >= THROTTLE_UNTIL) this.#throttled = false;
		this.#skipAhead = !this.#throttled && accuracy > SKIP_AHEAD_ABOVE;
	}
}

// ---- Level test ----

/** Test length: at most PLACEMENT_MAX items; from PLACEMENT_MIN on it stops once precise enough. */
const PLACEMENT_MAX = 40;
const PLACEMENT_MIN = 20;
/** Precise enough: the posterior SD of the vocabulary size is below this many words. */
const PLACEMENT_SD = 700;
/** Items per band at most. */
const PLACEMENT_PER_BAND = 5;
/** Items are picked among at least this many of a band's shortest eligible sentences. */
const SHORT_POOL = 24;

export interface PlacementSummary {
	/** Estimated vocabulary right after the test. */
	estimate: number;
	/** p_known per band, index band − 1. */
	perBand: number[];
	/** 90% credible interval of the estimate (see estimateRange). */
	low: number;
	high: number;
}

function median(xs: number[]): number {
	if (!xs.length) return Infinity;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * The level test, a vocabulary-size test that adapts to the learner. It opens with a sweep of
 * one item at every other band (1, 3, 5, …), easy to hard, then asks each next item in the band
 * whose answer the band model can predict least well (largest posterior variance of
 * P(correct)), at most five per band. It stops after 40 items, or from 20 on once the posterior
 * SD of the vocabulary size is below 700 words. Items use short sentences whose difficulty is
 * at most the band's typical one, so distractors are not rarer than the answer, and never the
 * same word twice. Given a learner (`opts.state`), words they have already met come last.
 *
 * next() may run ahead of answer(): it chooses from the answers so far, a band with an answer
 * outstanding goes after the others, and every drawn item can still be answered and counted.
 * An abandoned test records nothing: finish() applies it to the learner.
 */
export class Placement {
	#lex: Lexicon;
	#random: () => number;
	#now: () => number;
	#met: (lemma: string) => boolean;
	/** Per band (index band − 1): eligible questions, shortest first. */
	#pools: Question[][];
	/** Words drawn so far. */
	#used = new Set<string>();
	/** Sweep bands (index band − 1) not drawn yet. */
	#sweep: number[] = [];
	#drawn: { question: Question; b: number }[] = [];
	#answers = new Map<string, { result: Result; at: number }>();
	/** Items the bank can supply at most. */
	#capacity: number;
	#stopped = false;
	#finished: PlacementSummary | null = null;

	constructor(
		lex: Lexicon,
		questions: Question[],
		opts: { random?: () => number; now?: () => number; state?: LearnerState } = {}
	) {
		this.#lex = lex;
		this.#random = opts.random ?? Math.random;
		this.#now = opts.now ?? Date.now;
		const state = opts.state;
		this.#met = state ? (lemma) => own(state.cards, lemma) || own(state.met, lemma) : () => false;
		const byBand: Question[][] = Array.from({ length: lex.bands }, () => []);
		for (const q of questions) {
			const band = lex.words.get(q.lemma)?.band;
			if (band !== undefined) byBand[band - 1]?.push(q);
		}
		this.#pools = byBand.map((list) => {
			const typical = median(list.map((q) => q.difficulty));
			const easy = list.filter((q) => q.difficulty <= typical);
			const pool = new Set(easy.map((q) => q.lemma)).size >= PLACEMENT_PER_BAND ? easy : list;
			return pool.sort((a, b) => a.sentence.length - b.sentence.length);
		});
		for (let b = 0; b < lex.bands && this.#sweep.length < PLACEMENT_MAX; b += 2) this.#sweep.push(b);
		this.#capacity = this.#pools.reduce(
			(sum, pool) => sum + Math.min(PLACEMENT_PER_BAND, new Set(pool.map((q) => q.lemma)).size),
			0
		);
	}

	next(): Question | null {
		if (this.#stopped) return null;
		while (this.#sweep.length) {
			const b = this.#sweep.shift()!;
			const question = this.#pick(b);
			if (question) return this.#draw(question, b);
		}
		const b = this.#shouldStop() ? -1 : this.#nextBand();
		const question = b >= 0 ? this.#pick(b) : null;
		if (!question) {
			this.#stopped = true;
			return null;
		}
		return this.#draw(question, b);
	}

	answer(question: Question, result: Result): void {
		if (this.#answers.has(question.id)) return;
		if (!this.#drawn.some((d) => d.question.id === question.id)) return;
		this.#answers.set(question.id, { result, at: this.#now() });
	}

	get progress(): { asked: number; expected: number } {
		const expected = this.#stopped
			? this.#drawn.length
			: Math.max(this.#drawn.length, Math.min(PLACEMENT_MAX, this.#capacity));
		return { asked: this.#answers.size, expected };
	}

	get done(): boolean {
		if (this.#answers.size < this.#drawn.length) return false;
		if (!this.#stopped && !this.#sweep.length && (this.#shouldStop() || this.#nextBand() < 0)) {
			this.#stopped = true;
		}
		return this.#stopped;
	}

	/**
	 * Apply the test to the learner (mutates `state`). Answers to words met for the first time
	 * join the band evidence (`firsts`) first, so each first answer is graded against the whole
	 * test; correct ones then create cards where a correct answer is unlikely to be a guess (a
	 * fast answer is held at Good where guessing is likely), the rest stay met words without a
	 * card. Words that already have cards get a review; met words without one count no further
	 * evidence. Every answer is logged at the time it was given, outside learn mode's tally. The
	 * result is stored in `placement` and becomes today's starting point for the plan (see
	 * Morning). Idempotent; the caller persists with saveLearner(state).
	 */
	finish(state: LearnerState, now = this.#now()): PlacementSummary {
		if (this.#finished) return this.#finished;
		const thresholds = gradeThresholds(state);
		const answered = this.#drawn.flatMap(({ question }) => {
			const answer = this.#answers.get(question.id);
			const info = this.#lex.words.get(question.lemma);
			return answer && info ? [{ question, info, ...answer }] : [];
		});
		const counted = new Set<string>();
		for (const { info, result } of answered) {
			if (own(state.cards, info.word) || own(state.met, info.word)) continue;
			addFirst(state.firsts, info, result.outcome === 'correct', this.#lex.bandSize);
			counted.add(info.word);
		}
		const p = posteriorFor(state, this.#lex).mean;
		for (const { question, info, result, at } of answered) {
			applyAnswer(state, info, result, { introduce: false, learn: false, now: at, questionId: question.id, p, thresholds });
			settle(state, info.word, counted.has(info.word));
		}
		const perBand = p.map((x) => Math.round(x * 1000) / 1000);
		state.placement = { at: now, estimate: 0, perBand };
		const estimate = recordEstimate(state, this.#lex, now);
		state.placement.estimate = estimate;
		state.morning = standing(state, this.#lex, now);
		this.#finished = { estimate, perBand, ...estimateRange(state, this.#lex, now) };
		return this.#finished;
	}

	#draw(question: Question, b: number): Question {
		this.#used.add(question.lemma);
		this.#drawn.push({ question, b });
		return question;
	}

	/** The band model's posterior from the answers so far. */
	#posterior(): Posterior {
		const sample = emptySample(this.#lex.bands);
		for (const { question, b } of this.#drawn) {
			const answer = this.#answers.get(question.id);
			if (!answer) continue;
			sample.n[b]++;
			if (answer.result.outcome === 'correct') sample.c[b]++;
			const info = this.#lex.words.get(question.lemma);
			sample.x[b] += info ? positionOf(info, this.#lex.bandSize) : 0.5;
		}
		return posteriorOf(sample, emptySample(this.#lex.bands), shapeOf(this.#lex));
	}

	#shouldStop(): boolean {
		if (this.#drawn.length >= PLACEMENT_MAX) return true;
		if (this.#answers.size < PLACEMENT_MIN) return false;
		return sizeSpread(this.#posterior(), bandSizes(this.#lex)).sd < PLACEMENT_SD;
	}

	/**
	 * Band index whose next answer is least predictable, i.e. the largest posterior variance of
	 * P(correct) for a word in the middle of the band. Bands with an answer outstanding go last,
	 * since that answer is about to narrow them. −1 when no band can take another item.
	 */
	#nextBand(): number {
		const { grid, weights } = this.#posterior();
		const drawn = new Array<number>(grid.bands).fill(0);
		const waiting = new Array<boolean>(grid.bands).fill(false);
		for (const { question, b } of this.#drawn) {
			drawn[b]++;
			if (!this.#answers.has(question.id)) waiting[b] = true;
		}
		let best = -1;
		let bestKey = -Infinity;
		for (let b = 0; b < grid.bands; b++) {
			if (drawn[b] >= PLACEMENT_PER_BAND || !this.#available(b)) continue;
			let mean = 0;
			let square = 0;
			for (let k = 0; k < grid.points; k++) {
				const w = weights[k];
				if (w < NEGLIGIBLE) continue;
				const right = GUESS + (1 - GUESS) * knownAt(grid, k, b + 1) * (1 - SLIP);
				mean += w * right;
				square += w * right * right;
			}
			// Variance is at most 0.25, so the +1 for an idle band outranks any variance.
			const key = square - mean * mean + (waiting[b] ? 0 : 1);
			if (key > bestKey) {
				best = b;
				bestKey = key;
			}
		}
		return best;
	}

	/**
	 * A random undrawn word's sentence from band index `b`, among the band's shortest eligible
	 * sentences if possible, and among words the learner has not met if possible.
	 */
	#pick(b: number): Question | null {
		const pool = this.#pools[b] ?? [];
		const short = Math.min(pool.length, Math.max(SHORT_POOL, Math.ceil(pool.length / 3)));
		for (const fresh of [true, false]) {
			for (const size of [short, pool.length]) {
				const options = pool
					.slice(0, size)
					.filter((q) => !this.#used.has(q.lemma) && !(fresh && this.#met(q.lemma)));
				if (options.length) return options[Math.floor(this.#random() * options.length)];
			}
		}
		return null;
	}

	/** Band index `b` has a word not drawn yet. */
	#available(b: number): boolean {
		return (this.#pools[b] ?? []).some((q) => !this.#used.has(q.lemma));
	}
}
