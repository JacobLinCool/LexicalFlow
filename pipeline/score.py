"""Stage 2: score every candidate item with a causal LM.

For each item the answer and each candidate distractor are substituted into the sentence
and the full-sentence log-likelihood is recorded. `build.py` keeps an item only when the
answer beats every chosen distractor by a clear margin. Scores are keyed by item content
(`common.item_key`) and appended to `.cache/scores.jsonl`, so only items that are new since
the last run get scored, regenerating `items.jsonl` reuses earlier work, and an interrupted
run resumes where it stopped.
"""

from __future__ import annotations

import json
import os
import sys

import torch
from tqdm import tqdm
from transformers import AutoModelForCausalLM, AutoTokenizer

from common import ITEMS, LM_NAME, SCORED_V1, SCORES, item_key

BATCH = 192


@torch.inference_mode()
def score_batch(model, tok, enc: list[list[int]], starts: list[int], device: str) -> list[float]:
    """Sum of token log-probs for positions >= start (earlier tokens are shared by all variants)."""
    width = max(len(e) for e in enc)
    ids = torch.full((len(enc), width), tok.pad_token_id, dtype=torch.long)
    mask = torch.zeros((len(enc), width), dtype=torch.long)
    want = torch.zeros((len(enc), width), dtype=torch.bool)  # positions whose next token is scored
    for i, (e, s) in enumerate(zip(enc, starts)):
        ids[i, : len(e)] = torch.tensor(e)
        mask[i, : len(e)] = 1
        want[i, max(s, 1) - 1 : len(e) - 1] = True
    ids, mask, want = ids.to(device), mask.to(device), want.to(device)
    hidden = model.model(input_ids=ids, attention_mask=mask).last_hidden_state
    rows, cols = want.nonzero(as_tuple=True)
    # Project only the needed positions onto the vocabulary instead of the full sequence.
    logits = model.lm_head(hidden[rows, cols]).float()
    target = ids[rows, cols + 1]
    logp = logits.gather(-1, target[:, None]).squeeze(-1) - torch.logsumexp(logits, dim=-1)
    out = torch.zeros(len(enc), device=device).index_add_(0, rows, logp)
    return out.tolist()


def shared_prefix(seqs: list[list[int]]) -> int:
    k = 0
    while all(len(s) > k for s in seqs) and len({s[k] for s in seqs}) == 1:
        k += 1
    return k


def migrate_v1(items: list[dict]) -> None:
    """Convert the legacy index-keyed `scored.jsonl` into the content-keyed cache.

    Legacy rows name a line of `items.jsonl`, so they are only meaningful against the exact
    file they were scored from; the conversion runs once, when no keyed cache exists yet and
    the legacy file covers the current items line for line. The legacy file is then renamed
    so it can never be paired with a regenerated `items.jsonl`.
    """
    if SCORES.exists() or not SCORED_V1.exists():
        return
    rows = [json.loads(l) for l in open(SCORED_V1, encoding="utf-8")]
    if not rows or max(r["i"] for r in rows) >= len(items) or len(rows) != len(items):
        print(f"not migrating {SCORED_V1.name}: it does not match {ITEMS.name} line for line")
        return
    tmp = SCORES.with_suffix(".tmp")
    seen: set[str] = set()
    with open(tmp, "w", encoding="utf-8") as out:
        for r in rows:
            it = items[r["i"]]
            if len(r["s"]) != 1 + len(it["cands"]):
                raise SystemExit(f"legacy row {r['i']} has {len(r['s'])} scores for {1 + len(it['cands'])} choices")
            key = item_key(it)
            if key in seen:
                continue
            seen.add(key)
            out.write(json.dumps({"k": key, "s": r["s"]}) + "\n")
    os.replace(tmp, SCORES)
    SCORED_V1.rename(SCORED_V1.with_name("scored.v1-migrated.jsonl"))
    print(f"migrated {len(rows)} legacy scores to {len(seen)} keyed rows in {SCORES.name}")


def load_done() -> set[str]:
    done: set[str] = set()
    if SCORES.exists():
        with open(SCORES, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["k"])
                except (json.JSONDecodeError, KeyError):
                    pass  # a line cut short by an interruption; its item is scored again
    return done


def main() -> None:
    items = [json.loads(l) for l in open(ITEMS, encoding="utf-8")]
    migrate_v1(items)
    done = load_done()
    todo: list[tuple[str, dict]] = []
    queued: set[str] = set()
    for it in items:
        key = item_key(it)
        if key not in done and key not in queued:
            queued.add(key)
            todo.append((key, it))
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(todo)
    todo = todo[:limit]
    print(f"{len(items)} items, {len(items) - len(queued)} already scored, scoring {len(todo)}", flush=True)
    if not todo:
        return

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(LM_NAME)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(LM_NAME, torch_dtype=torch.float16).to(device).eval()
    print(f"scoring with {LM_NAME} on {device}", flush=True)

    # A cut-short last line would otherwise glue onto the next appended row.
    if SCORES.exists() and SCORES.stat().st_size:
        with open(SCORES, "rb+") as f:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.write(b"\n")

    with open(SCORES, "a", encoding="utf-8") as out:
        chunk = 256  # items per write; each expands to ~9 sentences
        for start in tqdm(range(0, len(todo), chunk), unit="chunk", mininterval=10):
            group = todo[start : start + chunk]
            enc, starts, owner = [], [], []
            for k, (_, it) in enumerate(group):
                variants = [
                    tok("\n" + it["prefix"] + word + it["suffix"], add_special_tokens=False)["input_ids"]
                    for word in [it["answer"], *it["cands"]]
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
            for (key, _), s in zip(group, per_item):
                out.write(json.dumps({"k": key, "s": s}) + "\n")
            out.flush()


if __name__ == "__main__":
    main()
