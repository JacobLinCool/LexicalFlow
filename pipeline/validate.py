"""Check the static question bank against the format-2 contract the app relies on. Exits non-zero on failure."""

from __future__ import annotations

import gzip
import json
import re
import sys
from collections import Counter

import common  # noqa: F401  (sets NLTK_DATA)
from common import CATEGORIES, DIRECTIONS, OUT, TARGET_TAGS

MIN_VOCAB = 10_000
MAX_RAW_BYTES = 14_000_000
POS = ("n", "v", "adj", "adv")
HEX8 = re.compile(r"^[0-9a-f]{8}$")
# ECDICT's British notation, which glosses.py rewrites in the General American symbols of the rest.
LEGACY_IPA = re.compile(r"ː|ɒ|əu|\(")


def main() -> int:
    errors: list[str] = []
    manifest = json.loads((OUT / "manifest.json").read_text())
    if manifest.get("format") != 2:
        errors.append(f"manifest format {manifest.get('format')} != 2")
    band_size = manifest["bandSize"]
    ids: set[str] = set()
    vocabulary: list[str] = []
    lemmas_with_questions: set[str] = set()
    answer_dirs: Counter = Counter()
    categories: Counter = Counter()
    total = raw = packed = 0
    prev_zipf = float("inf")
    by_instance = instance_glosses()

    if [b["band"] for b in manifest["bands"]] != list(range(1, len(manifest["bands"]) + 1)):
        errors.append(f"bands are not contiguous from 1: {[b['band'] for b in manifest['bands']]}")
    if set(manifest["categories"]) != set(CATEGORIES):
        errors.append(f"manifest categories {sorted(manifest['categories'])} != {sorted(CATEGORIES)}")
    if (OUT / "questions").exists() or (OUT / "vocabulary.json").exists():
        errors.append("format-1 files (questions/, vocabulary.json) are still present")
    listed = {b["file"] for b in manifest["bands"]}
    for path in (OUT / "bands").glob("*.json"):
        if f"bands/{path.name}" not in listed:
            errors.append(f"bands/{path.name} is not listed in the manifest")

    for n, meta in enumerate(manifest["bands"]):
        last = n == len(manifest["bands"]) - 1
        if meta["file"] != f"bands/{meta['band']:02d}.json":
            errors.append(f"band {meta['band']}: file {meta['file']}")
        data = (OUT / meta["file"]).read_bytes()
        raw += len(data)
        packed += len(gzip.compress(data, 9))
        band = json.loads(data)
        words, questions = band["words"], band["questions"]
        where = f"band {meta['band']}"
        if band["band"] != meta["band"] or set(band) != {"band", "words", "questions"}:
            errors.append(f"{where}: header {band.get('band')} / keys {sorted(band)}")
        if len(words) != meta["words"] or len(questions) != meta["questions"]:
            errors.append(f"{where}: manifest counts {meta['words']}/{meta['questions']} != {len(words)}/{len(questions)}")
        if len(words) > band_size or (not last and len(words) != band_size) or not words:
            errors.append(f"{where}: {len(words)} words with band size {band_size}")

        for w in words:
            # [word, pos, zipf, ipa, en, zh] plus, optionally, [[pos, en, zh], ...]: the other senses
            # its sentences use, each distinct from the main one and from each other.
            ok = (
                isinstance(w, list) and len(w) in (6, 7) and isinstance(w[0], str) and w[0]
                and w[1] in POS and isinstance(w[2], (int, float)) and all(isinstance(x, str) for x in w[3:6])
                and (len(w) == 6 or (
                    isinstance(w[6], list) and w[6] and all(
                        isinstance(v, list) and len(v) == 3 and v[0] in POS and all(isinstance(x, str) for x in v)
                        for v in w[6]
                    )
                    and len({tuple(v) for v in w[6]} | {(w[1], w[4], w[5])}) == len(w[6]) + 1
                ))
            )
            if not ok:
                errors.append(f"{where}: bad word row {w}")
                continue
            if w[2] > prev_zipf:
                errors.append(f"{where}: {w[0]} (Zipf {w[2]}) breaks the descending frequency order")
            for en in [w[4], *(v[1] for v in (w[6] if len(w) == 7 else []))]:
                if en in by_instance:
                    errors.append(f"{where}: {w[0]} is glossed as a person or place: {en!r}")
            if LEGACY_IPA.search(w[3]):
                errors.append(f"{where}: {w[0]} has IPA in British dictionary notation: {w[3]!r}")
            prev_zipf = w[2]
            vocabulary.append(w[0])

        for q in questions:
            qw = f"{where}/{q[0] if q else '?'}"
            # Ten fields, plus the index of the word's other sense the sentence uses, if any.
            if not (isinstance(q, list) and len(q) in (10, 11)):
                errors.append(f"{qw}: question row must have 10 or 11 fields")
                continue
            qid, sentence, *choices, answer_index, category_index, difficulty, word_index = q[:10]
            if len(q) == 11 and (
                not isinstance(word_index, int) or word_index not in range(len(words))
                or len(words[word_index]) != 7 or not isinstance(q[10], int)
                or q[10] not in range(len(words[word_index][6]))
            ):
                errors.append(f"{qw}: sense {q[10]!r} is not one of the word's other senses")
            if not (isinstance(qid, str) and HEX8.match(qid)):
                errors.append(f"{qw}: id must be 8 hex digits")
            if qid in ids:
                errors.append(f"{qw}: duplicate id")
            ids.add(qid)
            if not isinstance(sentence, str) or sentence.count("___") != 1:
                errors.append(f"{qw}: sentence must contain exactly one blank")
            if len(set(choices)) != 4 or not all(isinstance(c, str) and c for c in choices):
                errors.append(f"{qw}: choices must be four distinct words")
            if answer_index not in range(4) or category_index not in range(len(CATEGORIES)):
                errors.append(f"{qw}: answerIndex {answer_index} / categoryIndex {category_index}")
                continue
            if difficulty not in range(1, 6):
                errors.append(f"{qw}: difficulty {difficulty}")
            if not isinstance(word_index, int) or word_index not in range(len(words)):
                errors.append(f"{qw}: wordIndex {word_index} outside the band's {len(words)} words")
                continue
            lemma = words[word_index][0]
            answer = choices[answer_index]
            # The answer must be an inflection of the lemma wordIndex names (ran → run).
            if answer not in forms(lemma):
                errors.append(f"{qw}: answer {answer!r} is not a form of word {word_index} ({lemma!r})")
            answer_dirs[DIRECTIONS[answer_index]] += 1
            categories[CATEGORIES[category_index]] += 1
            lemmas_with_questions.add(lemma)
            total += 1

    if manifest["questionCount"] != total:
        errors.append(f"manifest questionCount {manifest['questionCount']} != {total}")
    if manifest["vocabularyCount"] != len(vocabulary):
        errors.append(f"manifest vocabularyCount {manifest['vocabularyCount']} != {len(vocabulary)}")
    if dict(categories) != {c: n for c, n in manifest["categories"].items() if n}:
        errors.append(f"manifest categories {manifest['categories']} != {dict(categories)}")
    for c in CATEGORIES:
        if categories[c] < 300:
            errors.append(f"{c}: only {categories[c]} questions")
    expected = total / 4
    for d in DIRECTIONS:
        if abs(answer_dirs[d] - expected) > max(5, 0.02 * expected):
            errors.append(f"answer direction {d} is unbalanced: {answer_dirs[d]} vs ~{expected:.0f}")
    if len(set(vocabulary)) != len(vocabulary):
        errors.append("duplicate vocabulary entries")
    if len(vocabulary) < MIN_VOCAB:
        errors.append(f"vocabulary has {len(vocabulary)} entries, need >= {MIN_VOCAB}")
    missing = set(vocabulary) - lemmas_with_questions
    if missing:
        errors.append(f"{len(missing)} vocabulary entries have no question, e.g. {sorted(missing)[:5]}")
    if raw > MAX_RAW_BYTES:
        errors.append(f"band files total {raw / 1e6:.2f} MB, budget {MAX_RAW_BYTES / 1e6:.0f} MB")

    print(
        f"{total} questions, {len(vocabulary)} words in {len(manifest['bands'])} bands, "
        f"answers {dict(answer_dirs)}, {raw / 1e6:.2f} MB raw, {packed / 1e6:.2f} MB gzip"
    )
    for err in errors[:50]:
        print("ERROR", err)
    if errors:
        print(f"{len(errors)} error(s)")
        return 1
    print("OK")
    return 0


def instance_glosses() -> set[str]:
    """English glosses glosses.py would make from WordNet instance synsets: people and places by
    name ("Villa": a Mexican revolutionary), never a sense of the common word."""
    from nltk.corpus import wordnet as wn

    from glosses import clause

    common, named = set(), set()
    for ss in wn.all_synsets():
        (named if ss.instance_hypernyms() else common).add(clause(ss.definition()))
    return named - common


def forms(lemma: str) -> set[str]:
    """The lemma and its regular inflections for every tag the pipeline blanks."""
    from lemminflect import getInflection

    out = {lemma}
    for tag in TARGET_TAGS:
        out.update(getInflection(lemma, tag))
    return out


if __name__ == "__main__":
    sys.exit(main())
