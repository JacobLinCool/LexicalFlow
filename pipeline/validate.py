"""Check the static question bank against the contract the app relies on. Exits non-zero on failure."""

from __future__ import annotations

import json
import sys
from collections import Counter

from common import CATEGORIES, DIRECTIONS, OUT

MIN_VOCAB = 10_000


def main() -> int:
    errors: list[str] = []
    manifest = json.loads((OUT / "manifest.json").read_text())
    ids: set[str] = set()
    lemmas_with_questions: set[str] = set()
    answer_dirs: Counter = Counter()
    total = 0

    if set(manifest["categories"]) != set(CATEGORIES):
        errors.append(f"manifest categories {sorted(manifest['categories'])} != {sorted(CATEGORIES)}")
    for cat, meta in manifest["categories"].items():
        qs = json.loads((OUT / meta["file"]).read_text())
        if len(qs) != meta["count"]:
            errors.append(f"{cat}: manifest count {meta['count']} != {len(qs)}")
        for q in qs:
            where = f"{cat}/{q.get('id')}"
            keys = {"id", "sentence", "choices", "answer", "category", "difficulty", "lemma"}
            if set(q) != keys:
                errors.append(f"{where}: keys {sorted(q)}")
                continue
            if q["id"] in ids:
                errors.append(f"{where}: duplicate id")
            ids.add(q["id"])
            if q["sentence"].count("___") != 1:
                errors.append(f"{where}: sentence must contain exactly one blank")
            if set(q["choices"]) != set(DIRECTIONS):
                errors.append(f"{where}: choices must be keyed by {DIRECTIONS}")
            words = list(q["choices"].values())
            if len(set(words)) != 4 or not all(isinstance(w, str) and w for w in words):
                errors.append(f"{where}: choices must be four distinct words")
            if q["answer"] not in DIRECTIONS:
                errors.append(f"{where}: bad answer {q['answer']}")
            if q["category"] != cat:
                errors.append(f"{where}: category {q['category']} in {cat} file")
            if q["difficulty"] not in range(1, 6):
                errors.append(f"{where}: difficulty {q['difficulty']}")
            answer_dirs[q["answer"]] += 1
            lemmas_with_questions.add(q["lemma"])
            total += 1
        if len(qs) < 300:
            errors.append(f"{cat}: only {len(qs)} questions")

    if manifest["questionCount"] != total:
        errors.append(f"manifest questionCount {manifest['questionCount']} != {total}")
    expected = total / 4
    for d in DIRECTIONS:
        if abs(answer_dirs[d] - expected) > max(5, 0.02 * expected):
            errors.append(f"answer direction {d} is unbalanced: {answer_dirs[d]} vs ~{expected:.0f}")

    vocab = json.loads((OUT / "vocabulary.json").read_text())
    words = [e["word"] for e in vocab["entries"]]
    if vocab["count"] != len(words) or manifest["vocabularyCount"] != len(words):
        errors.append("vocabulary count mismatch")
    if len(set(words)) != len(words):
        errors.append("duplicate vocabulary entries")
    if len(words) < MIN_VOCAB:
        errors.append(f"vocabulary has {len(words)} entries, need >= {MIN_VOCAB}")
    missing = set(words) - lemmas_with_questions
    if missing:
        errors.append(f"{len(missing)} vocabulary entries have no question, e.g. {sorted(missing)[:5]}")
    for e in vocab["entries"]:
        if e["pos"] not in ("n", "v", "adj", "adv") or e["difficulty"] not in range(1, 6):
            errors.append(f"bad vocabulary entry {e}")
            break

    size = sum(p.stat().st_size for p in (OUT / "questions").glob("*.json"))
    print(f"{total} questions, {len(words)} vocabulary entries, answers {dict(answer_dirs)}, {size / 1e6:.2f} MB")
    for err in errors[:50]:
        print("ERROR", err)
    if errors:
        print(f"{len(errors)} error(s)")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
