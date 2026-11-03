"""Stage 2: score every candidate item with a causal LM.

For each item the answer and each candidate distractor are substituted into the sentence
and the full-sentence log-likelihood is recorded. `build.py` keeps an item only when the
answer beats every chosen distractor by a clear margin. Results are appended to
`.cache/scored.jsonl`, so an interrupted run resumes where it stopped.
"""

from __future__ import annotations

import json
import sys

import torch
from tqdm import tqdm
from transformers import AutoModelForCausalLM, AutoTokenizer

from common import ITEMS, LM_NAME, SCORED

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


def main() -> None:
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(LM_NAME)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(LM_NAME, torch_dtype=torch.float16).to(device).eval()

    items = [json.loads(l) for l in open(ITEMS, encoding="utf-8")]
    done = 0
    if SCORED.exists():
        done = sum(1 for _ in open(SCORED, encoding="utf-8"))
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(items)
    todo = list(range(done, min(limit, len(items))))
    print(f"{len(items)} items, {done} already scored, scoring {len(todo)} with {LM_NAME} on {device}")

    with open(SCORED, "a", encoding="utf-8") as out:
        chunk = 256  # items per write; each expands to ~9 sentences
        for start in tqdm(range(0, len(todo), chunk), unit="chunk"):
            group = [items[i] for i in todo[start : start + chunk]]
            enc, starts, owner = [], [], []
            for k, it in enumerate(group):
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
            for k in range(len(group)):
                out.write(json.dumps({"i": todo[start + k], "s": per_item[k]}) + "\n")
            out.flush()


if __name__ == "__main__":
    main()
