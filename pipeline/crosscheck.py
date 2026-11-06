"""Stage 2c: a second opinion on validated items from an independent model family.

`score.py` validates items with Qwen, and `build.validate()` then picks the three distractors
Qwen finds clearly worse than the answer. A distractor that only fools Qwen's quirks would slip
through, and in a learning game an ambiguous item teaches a wrong lesson. So every item that
passes validation is scored again by SmolLM3-3B-Base on its answer and three chosen distractors;
`build.py` drops items this model does not also clearly resolve (see `CROSS_MARGIN` there).

Scores are cached by item content plus the chosen distractors in `.cache/scores2.jsonl` and the
run resumes after an interruption. Items are checked in each lemma's preference order, up to
`PER_LEMMA` per lemma, which leaves spares for the ones that fail.
"""

from __future__ import annotations

import json
from collections import defaultdict

import torch
from tqdm import tqdm
from transformers import AutoModelForCausalLM, AutoTokenizer

import build
from common import CROSS_LM_NAME, SCORES2, cross_key
from score import BATCH, score_batch, shared_prefix

PER_LEMMA = build.QUESTIONS_PER_LEMMA + 3


def candidates() -> list[tuple[str, dict, list[str]]]:
    """(key, item, chosen) for validated items, at most PER_LEMMA per lemma, preferred first."""
    blocklist = build.load_blocklist()
    by_lemma: dict[str, list[tuple[dict, list[str]]]] = defaultdict(list)
    for it in build.load():
        chosen = build.validate(it, blocklist)
        if chosen:
            by_lemma[it["lemma"]].append((it, chosen))
    out = []
    for group in by_lemma.values():
        group.sort(key=lambda p: (p[0]["src"] != "tatoeba", p[0]["min_margin"] > 15))
        out.extend((cross_key(it, chosen), it, chosen) for it, chosen in group[:PER_LEMMA])
    return out


def main() -> None:
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    todo = candidates()
    done: set[str] = set()
    if SCORES2.exists():
        with open(SCORES2, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["k"])
                except json.JSONDecodeError:
                    pass  # a line cut short by an interrupted run; it is rescored
    todo = [t for t in todo if t[0] not in done]
    print(f"{len(done)} items already cross-checked, checking {len(todo)} with {CROSS_LM_NAME} on {device}", flush=True)
    if not todo:
        return

    tok = AutoTokenizer.from_pretrained(CROSS_LM_NAME)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(CROSS_LM_NAME, dtype=torch.float16).to(device).eval()

    # A run killed mid-write leaves a partial last line; start appending on a fresh line.
    if SCORES2.exists() and SCORES2.stat().st_size:
        with open(SCORES2, "rb+") as f:
            f.seek(-1, 2)
            if f.read(1) != b"\n":
                f.write(b"\n")

    with open(SCORES2, "a", encoding="utf-8") as out:
        chunk = 256
        for start in tqdm(range(0, len(todo), chunk), unit="chunk"):
            group = todo[start : start + chunk]
            enc, starts, owner = [], [], []
            for k, (_, it, chosen) in enumerate(group):
                variants = [
                    tok("\n" + it["prefix"] + word + it["suffix"], add_special_tokens=False)["input_ids"]
                    for word in [it["answer"], *chosen]
                ]
                shared = shared_prefix(variants)
                for v in variants:
                    enc.append(v)
                    starts.append(shared)
                    owner.append(k)
            order = sorted(range(len(enc)), key=lambda i: len(enc[i]))
            scores = [0.0] * len(enc)
            for i in range(0, len(order), BATCH):
                batch = order[i : i + BATCH]
                result = score_batch(model, tok, [enc[b] for b in batch], [starts[b] for b in batch], device)
                for j, sc in zip(batch, result):
                    scores[j] = sc
            per_item: list[list[float]] = [[] for _ in group]
            for j, k in enumerate(owner):
                per_item[k].append(round(scores[j], 3))
            for (key, _, chosen), s in zip(group, per_item):
                out.write(json.dumps({"k": key, "c": chosen, "s": s}) + "\n")
            out.flush()


if __name__ == "__main__":
    main()
