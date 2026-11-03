"""Shared paths and constants for the Lexical Flow question pipeline."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
OUT = ROOT.parent / "static" / "data"

os.environ.setdefault("NLTK_DATA", str(CACHE / "nltk_data"))

TATOEBA_URL = "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2"
TATOEBA_TSV = CACHE / "eng_sentences.tsv"

SENTENCES = CACHE / "sentences.jsonl"  # tagged, filtered sentences
ITEMS = CACHE / "items.jsonl"  # candidate cloze items with distractor pools
SCORED = CACHE / "scored.jsonl"  # LM scores per item
POOLS = CACHE / "pools.json"  # cached distractor pools per lemma

CATEGORIES = ("travel", "conversation", "networking", "academic")
DIRECTIONS = ("up", "left", "down", "right")

# Penn tags we turn into blanks, mapped to the coarse POS used in the vocabulary.
TARGET_TAGS = {
    "NN": "n",
    "NNS": "n",
    "VB": "v",
    "VBD": "v",
    "VBG": "v",
    "VBN": "v",
    "VBP": "v",
    "VBZ": "v",
    "JJ": "adj",
    "JJR": "adj",
    "JJS": "adj",
    "RB": "adv",
}

WORDNET_POS = {"n": "n", "v": "v", "adj": "a", "adv": "r"}

LM_NAME = "Qwen/Qwen2.5-1.5B"
EMBED_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def difficulty_for(zipf: float) -> int:
    """Map a Zipf frequency to a 1 (common) .. 5 (rare) difficulty band."""
    if zipf >= 4.6:
        return 1
    if zipf >= 4.0:
        return 2
    if zipf >= 3.5:
        return 3
    if zipf >= 3.0:
        return 4
    return 5
