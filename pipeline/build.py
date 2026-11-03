"""Stage 3: keep LM-validated items, categorise them, and write the static question bank.

An item survives when at least three of its candidate distractors trail the answer by
`MARGIN` nats of sentence log-likelihood; the three closest such distractors become the
choices, which keeps them as hard as the validation allows. Output follows the contract
read by the app (`static/data/manifest.json`, `questions/<category>.json`,
`vocabulary.json`).
"""

from __future__ import annotations

import json
import math
import random
import re
from collections import Counter, defaultdict
from datetime import date
from functools import lru_cache

import numpy as np
from wordfreq import zipf_frequency

from common import CATEGORIES, DIRECTIONS, EMBED_NAME, ITEMS, OUT, SCORED, TARGET_TAGS, WORDNET_POS, difficulty_for

SEED = 20261103
MARGIN = 7.0  # nats: the answer must be >= e^7 (~1100x) likelier than every distractor
MAX_DISTRACTOR_MARGIN = 30.0  # distractors far beyond this are trivially wrong; avoid when possible
TARGET_VOCAB = 12_000  # most frequent validated lemmas kept in the bank
QUESTIONS_PER_LEMMA = 2
EXTRA_BLOCKED = {
    "vagina", "vaginas", "penis", "penises", "rape", "raped", "rapist", "suicide", "porn", "nazi",
    "flasher", "masturbate", "orgasm", "erection", "condom", "condoms", "prostitute", "prostitutes",
    "hooker", "whore", "slut", "genitals", "semen", "sperm", "brothel", "pedophile", "incest",
    "erectile", "spank", "spanked", "bonk", "bonked", "cunnilingus",
}
WORD = re.compile(r"[a-z]+")

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
    items = [json.loads(l) for l in open(ITEMS, encoding="utf-8")]
    for line in open(SCORED, encoding="utf-8"):
        row = json.loads(line)
        items[row["i"]]["scores"] = row["s"]
    return [it for it in items if "scores" in it]


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


def validate(item: dict, blocklist: set[str]) -> list[str] | None:
    """Return the three chosen distractors, or None when the item is ambiguous or unsuitable."""
    text = item["prefix"] + item["answer"] + item["suffix"]
    if any(blocked(w, blocklist) for w in WORD.findall(text.lower())):
        return None
    # Names the tagger missed ("Layla needs to ...") read as noise; keep sentence-initial
    # capitals and the pronoun I only.
    if any(w[0].isupper() and w != "I" for w in re.findall(r"[A-Za-z]+", text)[1:]):
        return None
    if item["lemma"] not in wordnet_lemmas(item["pos"]):
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
    )
    if len(margins) < 3:
        return None
    item["min_margin"] = margins[0][0]
    # Prefer the closest distractors that still pass, but skip absurd ones if others exist.
    plausible = [c for m, c in margins if m <= MAX_DISTRACTOR_MARGIN]
    chosen = plausible[:3] if len(plausible) >= 3 else [c for _, c in margins[:3]]
    return chosen


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

    # Keep the most frequent validated lemmas, up to N items each, preferring Tatoeba
    # sentences and moderate margins.
    by_lemma: dict[str, list[dict]] = defaultdict(list)
    for it in passed:
        by_lemma[it["lemma"]].append(it)
    ranked = sorted(by_lemma, key=lambda l: -max(it["zipf"] for it in by_lemma[l]))[:TARGET_VOCAB]
    print(f"{len(by_lemma)} validated lemmas; keeping {len(ranked)} down to Zipf "
          f"{max(it['zipf'] for it in by_lemma[ranked[-1]]):.2f}")
    kept: list[dict] = []
    for lemma in ranked:
        group = by_lemma[lemma]
        rng.shuffle(group)
        group.sort(key=lambda it: (it["src"] != "tatoeba", it["min_margin"] > 15))
        kept.extend(group[:QUESTIONS_PER_LEMMA])
    rng.shuffle(kept)

    filled = [it["prefix"] + it["answer"] + it["suffix"] for it in kept]
    cats = categorise(filled)

    directions = [DIRECTIONS[i % 4] for i in range(len(kept))]
    rng.shuffle(directions)

    questions: dict[str, list[dict]] = {c: [] for c in CATEGORIES}
    lemma_pos: dict[str, Counter] = defaultdict(Counter)
    lemma_zipf: dict[str, float] = {}
    for n, (it, cat, ans_dir) in enumerate(zip(kept, cats, directions), 1):
        others = [d for d in DIRECTIONS if d != ans_dir]
        rng.shuffle(others)
        choices = {ans_dir: it["answer"], **dict(zip(others, it["chosen"]))}
        questions[cat].append({
            "id": f"q{n:05d}",
            "sentence": it["prefix"] + "___" + it["suffix"],
            "choices": {d: choices[d] for d in DIRECTIONS},
            "answer": ans_dir,
            "category": cat,
            "difficulty": difficulty_for(it["zipf"]),
            "lemma": it["lemma"],
        })
        lemma_pos[it["lemma"]][it["pos"]] += 1
        lemma_zipf[it["lemma"]] = it["zipf"]

    entries = sorted(
        (
            {
                "word": lemma,
                "pos": lemma_pos[lemma].most_common(1)[0][0],
                "zipf": lemma_zipf[lemma],
                "difficulty": difficulty_for(lemma_zipf[lemma]),
            }
            for lemma in lemma_pos
        ),
        key=lambda e: (-e["zipf"], e["word"]),
    )

    (OUT / "questions").mkdir(parents=True, exist_ok=True)
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    for cat, qs in questions.items():
        qs.sort(key=lambda q: q["id"])
        (OUT / "questions" / f"{cat}.json").write_text(dump(qs), encoding="utf-8")
    (OUT / "vocabulary.json").write_text(dump({"count": len(entries), "entries": entries}), encoding="utf-8")
    manifest = {
        "version": date.today().isoformat(),
        "questionCount": len(kept),
        "vocabularyCount": len(entries),
        "categories": {c: {"file": f"questions/{c}.json", "count": len(questions[c])} for c in CATEGORIES},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
