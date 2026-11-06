"""Stage 3: keep LM-validated items, categorise them, and write the static question bank.

An item survives when at least three of its candidate distractors trail the answer by
`MARGIN` nats of sentence log-likelihood; the three closest such distractors become the
choices, which keeps them as hard as the validation allows. Items that give the answer away
(the sentence repeats its stem, "a princess and a ___") or read as fragments are dropped. Every
validated lemma is kept, ranked by frequency and split into bands of `BAND_SIZE` words, with
its sentences mostly in the part of speech the corpus uses it in. Output follows the format-2
contract read by the app: `static/data/manifest.json` plus compact `bands/NN.json` files
holding each band's words (with glosses from `glosses.py`) and questions.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import shutil
from collections import Counter, defaultdict
from functools import lru_cache

import numpy as np
from wordfreq import zipf_frequency

from common import (
    CATEGORIES,
    DIRECTIONS,
    EMBED_NAME,
    GLOSSES,
    ITEMS,
    OUT,
    SCORES,
    SCORES2,
    SENTENCES,
    TARGET_TAGS,
    WORDNET_POS,
    cross_key,
    difficulty_for,
    item_key,
    question_id,
    vowel_sound,
)

SEED = 20261103
MARGIN = 7.0  # nats: the answer must be >= e^7 (~1100x) likelier than every distractor
MAX_DISTRACTOR_MARGIN = 30.0  # distractors far beyond this are trivially wrong; avoid when possible
# nats: the second model (crosscheck.py) must also prefer the answer to every chosen distractor
# by this much, frequency gap credited back as in margin(). In a hand-checked sample, items below
# it were often genuinely ambiguous ("a large number of [monarchs / heirs] ... have been
# bloodthirsty monsters"); it drops about 7% of validated items, which spares replace.
CROSS_MARGIN = 5.0
QUESTIONS_PER_LEMMA = 6  # contexts per word, so reviews can show a sentence not seen before
# A part of speech other than the word's main one gets sentences in proportion to how often the
# corpus uses it, none below MIN_MINOR_SHARE ("long" the verb, "time" the verb), at most half.
MIN_MINOR_SHARE = 0.03
# Zipf: a lemma whose own use is this much rarer than its spelling is ranked by its own use.
# The spelling's frequency then belongs to another word ("going" the noun, "better" the verb,
# "best" against "good"), and a beginner who misses "goings" does not lack a common word.
OWN_USE_GAP = 2.0
MIN_QUESTIONS_PER_LEMMA = 3  # floor when the size budget forces rare bands to keep fewer
MAX_BANK_BYTES = 14_000_000  # raw size budget for all band files together
BAND_SIZE = 1000  # words per frequency band
EXTRA_BLOCKED = {
    "vagina", "vaginas", "penis", "penises", "rape", "raped", "rapist", "suicide", "porn", "nazi",
    "flasher", "masturbate", "orgasm", "erection", "condom", "condoms", "prostitute", "prostitutes",
    "hooker", "whore", "slut", "genitals", "semen", "sperm", "brothel", "pedophile", "incest",
    "erectile", "spank", "spanked", "bonk", "bonked", "cunnilingus",
}
# Question ids a hand review rejected: a distractor fits as well as the answer ("We ___ to
# decide": need, hope) or the sentence is broken. Ids hash the sentence, so they stay valid.
REVIEWED_OUT = {
    "836c0d57", "2b008f8c", "20319ab8", "bb8f82b2", "5b2b7410",
    "fa5e9b8d", "70c47190", "7ce9f0e9", "c62af341", "dc020dd0",
}
WORD = re.compile(r"[a-z]+")
FINITE = {"VBD", "VBP", "VBZ", "MD"}
POS_ORDER = ("n", "v", "adj", "adv")
ARTICLE = re.compile(r"\ban? $", re.IGNORECASE)

# Short sentences describing each category; an item joins the category whose prototypes it
# resembles most, provided the resemblance clears CATEGORY_THRESHOLD. Everything else is
# general conversation.
CATEGORY_THRESHOLD = 0.26
PROTOTYPES = {
    "travel": [
        "We missed our flight and had to wait at the airport.",
        "I booked a hotel room near the station for two nights.",
        "Could you tell me how to get to the museum from here?",
        "Don't forget your passport and luggage before you leave for the trip.",
        "The train to the coast was crowded with tourists on vacation.",
        "We rented a car and drove along the mountain road to the village.",
        "The waiter brought us the menu and we ordered dinner at the restaurant.",
        "The beach was beautiful and the sea was warm during our holiday.",
        "The bus to the city centre leaves every twenty minutes.",
        "We went sightseeing in the old town and took lots of photos.",
        "The customs officer checked our bags at the border.",
        "Our cruise ship stopped at several islands.",
        "We hiked through the forest and camped by the lake.",
        "The guide showed us around the ancient castle and cathedral.",
        "How much is a single ticket to the next town?",
        "We exchanged money and bought souvenirs at the market.",
    ],
    "conversation": [
        "I'm so tired today, I think I'll stay home and rest.",
        "My sister called me last night to talk about her new boyfriend.",
        "What do you usually do on weekends with your friends?",
        "I really like this song, it makes me happy.",
        "Don't worry, everything will be fine.",
        "He was angry because I forgot his birthday.",
        "It's raining again, so let's watch a movie at home.",
        "She cooked a delicious meal for the whole family.",
    ],
    "networking": [
        "It was nice to meet you at the conference; let's keep in touch.",
        "She introduced me to a manager at the company who was hiring.",
        "Our team has a meeting with the client tomorrow morning.",
        "He applied for the job and got an interview next week.",
        "I sent an email to my colleague about the project deadline.",
        "The business partners negotiated a new contract.",
        "She was promoted to a senior position in the firm.",
        "Our boss asked us to prepare a report for the customers.",
        "The company's profits rose sharply this quarter.",
        "He works as a consultant for several investors.",
        "The marketing department launched a new campaign.",
        "We should hire more staff to handle the workload.",
        "The startup is looking for funding from venture capitalists.",
        "Let me give you my business card so we can discuss a partnership.",
        "The board of directors approved the budget.",
        "She is an experienced lawyer who advises corporations.",
    ],
    "academic": [
        "The results suggest that the method is effective.",
        "Scientists conducted an experiment to test the hypothesis.",
        "The theory explains how the economy responds to change.",
        "Students must analyze the evidence before writing their essays.",
        "The study examines the causes of climate change.",
        "Historians disagree about the significance of the revolution.",
        "The professor's lecture focused on the structure of language.",
        "The data indicate a strong relationship between the two variables.",
        "The philosopher argued that knowledge depends on experience.",
        "Cells divide and replicate their genetic material.",
        "The equation describes the motion of particles in a field.",
        "The author's argument rests on several questionable assumptions.",
        "The ancient civilization developed a complex system of writing.",
        "The species evolved to survive in a harsh environment.",
        "The researchers published their findings in a scientific journal.",
        "This chemical reaction releases a large amount of energy.",
    ],
}


def load() -> list[dict]:
    """Items of `items.jsonl` that have LM scores in the content-keyed cache."""
    scores: dict[str, list[float]] = {}
    with open(SCORES, encoding="utf-8") as f:
        for line in f:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line cut short by an interrupted scoring run
            scores[row["k"]] = row["s"]
    items = [json.loads(l) for l in open(ITEMS, encoding="utf-8")]
    for it in items:
        s = scores.get(item_key(it))
        if s is not None and len(s) == 1 + len(it["cands"]):
            it["scores"] = s
    return [it for it in items if "scores" in it]


def load_cross() -> dict[str, list[float]]:
    """Second-model scores by cross_key; empty when crosscheck.py has not run."""
    cross: dict[str, list[float]] = {}
    if SCORES2.exists():
        with open(SCORES2, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cross[row["k"]] = row["s"]
    return cross


def cross_margin(item: dict, scores: list[float]) -> float:
    """The second model's smallest lead of the answer over a chosen distractor."""
    answer_score, *cand_scores = scores
    return min(margin(item["answer"], answer_score, c, s) for c, s in zip(item["chosen"], cand_scores))


def load_blocklist() -> set[str]:
    import better_profanity
    from pathlib import Path

    path = Path(better_profanity.__file__).parent / "profanity_wordlist.txt"
    words = {w.strip().lower() for w in path.read_text().splitlines() if w.strip() and " " not in w}
    return words | EXTRA_BLOCKED


def blocked(word: str, blocklist: set[str]) -> bool:
    word = word.lower()
    stems = {word, word.removesuffix("s"), word.removesuffix("es"), word.removesuffix("ed"),
             word.removesuffix("d"), word.removesuffix("ing"), word.removesuffix("ers")}
    return bool(stems & blocklist)


@lru_cache(maxsize=None)
def surface_pos(form: str) -> frozenset[str]:
    from nltk.corpus import wordnet as wn

    return frozenset(p for p, w in (("n", "n"), ("v", "v"), ("adj", "a")) if wn._morphy(form, w))


UPOS = {"n": "NOUN", "v": "VERB", "adj": "ADJ", "adv": "ADV"}


@lru_cache(maxsize=None)
def wordnet_lemmas(pos: str) -> frozenset[str]:
    from nltk.corpus import wordnet as wn

    return frozenset(wn.all_lemma_names(WORDNET_POS[pos]))


@lru_cache(maxsize=None)
def well_formed(form: str, tag: str) -> bool:
    """`form` is the `tag` inflection of a genuine WordNet lemma (rejects "waving" as a base verb)."""
    from lemminflect import getLemma

    pos = TARGET_TAGS[tag]
    if tag in ("NN", "VB", "JJ", "RB"):
        return form in wordnet_lemmas(pos)
    return any(
        lemma in wordnet_lemmas(pos) and inflect(lemma, tag) == form
        for lemma in getLemma(form, UPOS[pos])
    )


def inflect(lemma: str, tag: str) -> str | None:
    from lemminflect import getInflection

    forms = getInflection(lemma, tag)
    return forms[0] if forms else None


def margin(answer: str, answer_score: float, cand: str, cand_score: float) -> float:
    """Log-likelihood lead of the answer, also after discounting a rarer distractor's prior.

    A rare distractor scores low partly because it is rare, not because it misfits the
    context, so the lead must also hold once the frequency gap is credited back.
    """
    raw = answer_score - cand_score
    prior_gap = (zipf_frequency(answer, "en") - zipf_frequency(cand, "en")) * math.log(10)
    return min(raw, raw - prior_gap)


@lru_cache(maxsize=None)
def common_senses(lemma: str, pos: str) -> bool:
    """Whether WordNet has the lemma as `pos` in a sense other than a person or place."""
    from glosses import wordnet_senses

    return bool(wordnet_senses(lemma, pos))


@lru_cache(maxsize=1)
def stemmer():
    from nltk.stem.snowball import SnowballStemmer

    return SnowballStemmer("english")


def gives_away(item: dict) -> bool:
    """Whether another word of the sentence shares the answer's stem ("a princess and a ___").

    Such a sentence hints at the answer by its form, whatever the choices.
    """
    answer = item["answer"].lower()
    stems = {stemmer().stem(answer), stemmer().stem(item["lemma"])}
    for word in WORD.findall((item["prefix"] + " " + item["suffix"]).lower()):
        if len(word) < 3:
            continue
        short, longer = sorted((word, answer), key=len)
        if stemmer().stem(word) in stems or (
            len(short) >= 4 and longer.startswith(short) and len(short) >= 0.75 * len(longer)
        ):
            return True
    return False


@lru_cache(maxsize=1)
def sentence_tags() -> dict[int, tuple[str, list[str]]]:
    """Source and Penn tags of every tagged sentence, by sentence id."""
    out = {}
    with open(SENTENCES, encoding="utf-8") as f:
        for line in f:
            s = json.loads(line)
            out[s["id"]] = (s["src"], [t[1] for t in s["toks"]])
    return out


def fragment(item: dict) -> bool:
    """A WordNet usage example without a finite verb that is not an imperative.

    These are noun phrases ("The quiet waters of a lagoon.") that read as broken sentences.
    Tatoeba sentences are kept: the tagger misses more of their verbs than they lack.
    """
    src, tags = sentence_tags().get(item["sid"], ("", []))
    return src == "wordnet" and bool(tags) and tags[0] != "VB" and not FINITE & set(tags)


def fits_article(prefix: str, answer: str, cand: str) -> bool:
    """After "a" or "an", a distractor must take the same article, or the article gives it away.

    Items drafted while prepare.py judged this by spelling offer "recognizable" beside
    "unidentified" in "an ___ flying object".
    """
    if not ARTICLE.search(prefix):
        return True
    return vowel_sound(cand) == vowel_sound(answer)


def validate(item: dict, blocklist: set[str]) -> list[str] | None:
    """Return the three chosen distractors, or None when the item is ambiguous or unsuitable."""
    text = item["prefix"] + item["answer"] + item["suffix"]
    if any(blocked(w, blocklist) for w in WORD.findall(text.lower())):
        return None
    # Names the tagger missed ("Layla needs to ...") read as noise; keep sentence-initial
    # capitals and the pronoun I only.
    if any(w[0].isupper() and w != "I" for w in re.findall(r"[A-Za-z]+", text)[1:]):
        return None
    if not common_senses(item["lemma"], item["pos"]):
        return None  # only people or places by that name: the tagger misread the word
    if gives_away(item) or fragment(item) or question_id(item["prefix"] + "___" + item["suffix"]) in REVIEWED_OUT:
        return None
    # A noun-tagged answer that can also be an adjective ("affine transformations") may sit in
    # an adjective slot, so its distractors must be able to fill either role.
    need = surface_pos(item["answer"]) & {"n", "adj"} if item["tag"] in ("NN", "NNS") else set()
    if len(need) < 2:
        need = set()
    answer_score, *cand_scores = item["scores"]
    margins = sorted(
        (m, c)
        for c, s in zip(item["cands"], cand_scores)
        if (m := margin(item["answer"], answer_score, c, s)) >= MARGIN
        and not blocked(c, blocklist)
        and need <= surface_pos(c)
        and well_formed(c, item["tag"])
        and fits_article(item["prefix"], item["answer"], c)
    )
    if len(margins) < 3:
        return None
    item["min_margin"] = margins[0][0]
    # Prefer the closest distractors that still pass, but skip absurd ones if others exist.
    plausible = [c for m, c in margins if m <= MAX_DISTRACTOR_MARGIN]
    chosen = plausible[:3] if len(plausible) >= 3 else [c for _, c in margins[:3]]
    return chosen


def sense_gloss(pos: str, qid: str | None, g: dict, main: str | None = None) -> tuple[str, str, str]:
    """(pos, en, zh) a sentence is glossed with: its part of speech's gloss, or the main one's when
    that part of speech has none (a tagging slip: "pierces" as a noun), with the English of the
    sense the sentence itself uses when glosses.py found one."""
    senses = g.get("senses", {})
    if pos not in senses and main is not None:
        pos = main
    en, zh = senses.get(pos, ["", ""])
    variant = g.get("variants", {}).get(qid) if qid else None
    if variant and variant[0] == pos:
        en = variant[1]
    return pos, en, zh


def main_sense(present: Counter, usage: dict[str, int], senses: dict) -> str:
    """The part of speech a word is taught in: the one the corpus uses most, among those with a
    gloss and validated sentences ("long" the adjective, though its sentences may be verbs)."""
    return max(present, key=lambda p: (p in senses, usage.get(p, 0), present[p]))


def pos_quota(present: set[str], usage: dict[str, int], main: str) -> dict[str, int]:
    """How many sentences each part of speech may have: the main one all of them, the others by
    the corpus's share of that use, so a common word is not drilled in a rare sense."""
    total = sum(usage.get(p, 0) for p in present)
    quota = {}
    for p in present:
        share = usage.get(p, 0) / total if total else 1.0
        if p == main or not total:
            quota[p] = QUESTIONS_PER_LEMMA
        elif share < MIN_MINOR_SHARE:
            quota[p] = 0
        else:
            quota[p] = min(QUESTIONS_PER_LEMMA // 2, max(1, round(QUESTIONS_PER_LEMMA * share)))
    return quota


def categorise(sentences: list[str]) -> list[str]:
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(EMBED_NAME, device="mps")
    emb = model.encode(sentences, batch_size=512, normalize_embeddings=True, show_progress_bar=True)
    scores = []
    for c in CATEGORIES:
        proto = model.encode(PROTOTYPES[c], normalize_embeddings=True)
        scores.append(np.sort(emb @ proto.T, axis=1)[:, -2:].mean(1))  # mean of the two best matches
    scores = np.stack(scores, 1)
    labels = []
    for row in scores:
        best = CATEGORIES[int(row.argmax())]
        labels.append(best if row.max() >= CATEGORY_THRESHOLD else "conversation")
    return labels


def fit_budget(kept: list[dict], ranked: list[str]) -> list[dict]:
    """Drop the least preferred contexts of the rarest bands until the bank fits MAX_BANK_BYTES.

    `kept` lists each lemma's items in preference order. Caps fall one step at a time, always
    in the highest band still above MIN_QUESTIONS_PER_LEMMA, so common words keep every context.
    """
    band_of = {l: i // BAND_SIZE for i, l in enumerate(ranked)}
    n_bands = math.ceil(len(ranked) / BAND_SIZE)
    nth: dict[str, int] = Counter()
    order = []  # (band, position within its lemma, estimated bytes)
    for it in kept:
        row = [it["id"], it["prefix"] + "___" + it["suffix"], it["answer"], *it["chosen"], 0, 0, 0, 999]
        order.append((band_of[it["lemma"]], nth[it["lemma"]], len(json.dumps(row, ensure_ascii=False).encode()) + 1))
        nth[it["lemma"]] += 1
    words_bytes = 250 * len(ranked)  # a word row with its glosses, generously
    caps = [QUESTIONS_PER_LEMMA] * n_bands

    def total() -> int:
        return words_bytes + sum(size for band, pos, size in order if pos < caps[band])

    while total() > MAX_BANK_BYTES:
        over = [b for b in range(n_bands) if caps[b] > MIN_QUESTIONS_PER_LEMMA]
        if not over:
            break
        caps[over[-1]] -= 1
    if any(c < QUESTIONS_PER_LEMMA for c in caps):
        print(f"size budget: questions per word by band {caps}")
    return [it for it, (band, pos, _) in zip(kept, order) if pos < caps[band]]


def main() -> None:
    rng = random.Random(SEED)
    items = load()
    print(f"{len(items)} scored items")

    blocklist = load_blocklist()
    passed = []
    for it in items:
        chosen = validate(it, blocklist)
        if chosen:
            it["chosen"] = chosen
            passed.append(it)
    print(f"{len(passed)} items pass the {MARGIN}-nat margin ({len(passed) / len(items):.1%})")

    # Items the second model also checked: drop the ones it finds ambiguous, and prefer checked
    # items over unchecked ones (without a crosscheck run every item counts as checked).
    cross = load_cross()
    if cross:
        survivors, checked = [], 0
        for it in passed:
            scores = cross.get(cross_key(it, it["chosen"]))
            it["crossed"] = scores is not None
            if scores is not None:
                checked += 1
                if cross_margin(it, scores) < CROSS_MARGIN:
                    continue
            survivors.append(it)
        print(f"crosscheck: {checked} items checked, {len(passed) - len(survivors)} dropped below "
              f"{CROSS_MARGIN} nats")
        passed = survivors

    glosses = json.loads(GLOSSES.read_text()) if GLOSSES.exists() else {}
    if not glosses:
        print(f"warning: {GLOSSES.name} missing; run glosses.py for word glosses and usage")

    # Keep every validated lemma, most frequent first, with up to N items each, preferring
    # sentences no other word uses yet, Tatoeba sentences and moderate margins.
    by_lemma: dict[str, list[dict]] = defaultdict(list)
    for it in passed:
        by_lemma[it["lemma"]].append(it)
    lemma_zipf = {}
    for lemma, group in by_lemma.items():
        zipf = max(it["zipf"] for it in group)
        own = glosses.get(lemma, {}).get("zipf")
        lemma_zipf[lemma] = own if own is not None and own < zipf - OWN_USE_GAP else zipf
    reranked = sum(lemma_zipf[l] < max(it["zipf"] for it in g) for l, g in by_lemma.items())
    print(f"{reranked} lemmas ranked by their own use, which is far rarer than their spelling")
    ranked = sorted(by_lemma, key=lambda l: (-lemma_zipf[l], l))
    print(f"{len(ranked)} validated lemmas, down to Zipf {lemma_zipf[ranked[-1]]:.2f}")
    kept: list[dict] = []
    used_sentences: set[int] = set()
    ids: set[str] = set()
    collisions = 0
    main_pos: dict[str, str] = {}

    def take(it: dict) -> bool:
        nonlocal collisions
        # Two source sentences that differ only in the blanked word would read as the same
        # question with two answers; an 8-hex id may also collide. Both keep the first.
        it["id"] = question_id(it["prefix"] + "___" + it["suffix"])
        if it["id"] in ids:
            collisions += 1
            return False
        ids.add(it["id"])
        used_sentences.add(it["sid"])
        kept.append(it)
        return True

    for lemma in ranked:
        group = by_lemma[lemma]
        rng.shuffle(group)
        group.sort(key=lambda it: (
            it["sid"] in used_sentences,
            not it.get("crossed", True),
            it["src"] != "tatoeba",
            it["min_margin"] > 15,
        ))
        g = glosses.get(lemma, {})
        present = Counter(it["pos"] for it in group)
        main_pos[lemma] = main = main_sense(present, g.get("usage", {}), g.get("senses", {}))
        quota = pos_quota(set(present), g.get("usage", {}), main)
        taken: Counter = Counter()
        spare = []
        for it in group:
            if sum(taken.values()) >= QUESTIONS_PER_LEMMA:
                break
            if taken[it["pos"]] >= quota[it["pos"]]:
                spare.append(it)
            elif take(it):
                taken[it["pos"]] += 1
        # Too few sentences in the word's common uses: fill up to the floor with the others.
        for it in spare:
            if sum(taken.values()) >= MIN_QUESTIONS_PER_LEMMA:
                break
            if take(it):
                taken[it["pos"]] += 1
    print(f"{len(kept)} questions kept ({collisions} dropped for a duplicate sentence or id)")
    with_questions = {it["lemma"] for it in kept}
    ranked = [l for l in ranked if l in with_questions]
    kept = fit_budget(kept, ranked)

    filled = [it["prefix"] + it["answer"] + it["suffix"] for it in kept]
    cats = categorise(filled)

    directions = [i % 4 for i in range(len(kept))]
    rng.shuffle(directions)

    by_word: dict[str, list[dict]] = defaultdict(list)
    for it in kept:
        by_word[it["lemma"]].append(it)
    words = []
    sense_of: dict[str, int] = {}  # question id → index into its word's other senses
    for lemma in ranked:
        g = glosses.get(lemma, {})
        if main_pos[lemma] not in {it["pos"] for it in by_word[lemma]}:
            main_pos[lemma] = Counter(it["pos"] for it in by_word[lemma]).most_common(1)[0][0]
        main = sense_gloss(main_pos[lemma], None, g)
        # Sentences that use the word as another part of speech ("to steal" beside "a steal") or
        # in another sense ("a major" in the army, not at university) need that gloss too.
        glossed = {it["id"]: sense_gloss(it["pos"], it["id"], g, main_pos[lemma]) for it in by_word[lemma]}
        # Each part of speech's own gloss before the senses single sentences use.
        other = sorted(
            {gl for gl in glossed.values() if gl != main},
            key=lambda gl: (POS_ORDER.index(gl[0]), gl != sense_gloss(gl[0], None, g), gl),
        )
        for qid, gl in glossed.items():
            if gl != main:
                sense_of[qid] = other.index(gl)
        row = [lemma, main[0], lemma_zipf[lemma], g.get("ipa", ""), main[1], main[2]]
        if other:
            row.append([list(gl) for gl in other])
        words.append(row)
    rank_of = {w[0]: i for i, w in enumerate(words)}

    bands: list[dict] = [
        {"band": b + 1, "words": words[b * BAND_SIZE : (b + 1) * BAND_SIZE], "questions": []}
        for b in range(math.ceil(len(words) / BAND_SIZE))
    ]
    category_counts = Counter()
    for it, cat, answer_index in zip(kept, cats, directions):
        others = it["chosen"][:]
        rng.shuffle(others)
        choices = others[:answer_index] + [it["answer"]] + others[answer_index:]
        rank = rank_of[it["lemma"]]
        bands[rank // BAND_SIZE]["questions"].append([
            it["id"],
            it["prefix"] + "___" + it["suffix"],
            *choices,
            answer_index,
            CATEGORIES.index(cat),
            # A question is as hard as its rarest choice: an obscure distractor makes it
            # feel hard even when the answer is common.
            difficulty_for(min([it["zipf"], *(zipf_frequency(w, "en") for w in it["chosen"])])),
            rank % BAND_SIZE,
            # The sense the sentence uses, when it is not the word's main one.
            *([sense_of[it["id"]]] if it["id"] in sense_of else []),
        ])
        category_counts[cat] += 1

    # Replace the previous bank: format-1 files and band files beyond the new last band.
    shutil.rmtree(OUT / "questions", ignore_errors=True)
    (OUT / "vocabulary.json").unlink(missing_ok=True)
    band_dir = OUT / "bands"
    band_dir.mkdir(parents=True, exist_ok=True)
    for old in band_dir.glob("*.json"):
        old.unlink()

    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    # The version is a hash of the bank's content: clients cache band files by it, so it must
    # change whenever (and only when) the bank does.
    digest = hashlib.sha256()
    entries = []
    for band in bands:
        band["questions"].sort(key=lambda q: (q[9], q[0]))
        text = dump(band)
        digest.update(text.encode("utf-8"))
        name = f"bands/{band['band']:02d}.json"
        (OUT / name).write_text(text, encoding="utf-8")
        entries.append({"band": band["band"], "file": name, "words": len(band["words"]), "questions": len(band["questions"])})
    manifest = {
        "format": 2,
        "version": digest.hexdigest()[:12],
        "questionCount": len(kept),
        "vocabularyCount": len(words),
        "bandSize": BAND_SIZE,
        "bands": entries,
        "categories": {c: category_counts[c] for c in CATEGORIES},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in manifest.items() if k != "bands"}, indent=2))
    for e in entries:
        print(f"  band {e['band']:2d}: {e['words']} words, {e['questions']} questions")


if __name__ == "__main__":
    main()
