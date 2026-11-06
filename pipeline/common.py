"""Shared paths and constants for the Lexical Flow question pipeline."""

from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
OUT = ROOT.parent / "static" / "data"

os.environ.setdefault("NLTK_DATA", str(CACHE / "nltk_data"))

TATOEBA_URL = "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2"
TATOEBA_TSV = CACHE / "eng_sentences.tsv"

SENTENCES = CACHE / "sentences.jsonl"  # tagged, filtered sentences
ITEMS = CACHE / "items.jsonl"  # candidate cloze items with distractor pools
SCORES = CACHE / "scores.jsonl"  # LM scores keyed by item content (see item_key)
SCORED_V1 = CACHE / "scored.jsonl"  # legacy scores keyed by line index in items.jsonl
SCORES2 = CACHE / "scores2.jsonl"  # second-model scores of validated items (crosscheck.py)
GLOSSES = CACHE / "glosses.json"  # IPA, English and Chinese gloss per vocabulary lemma
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
CROSS_LM_NAME = "HuggingFaceTB/SmolLM3-3B-Base"  # an independent model family for crosscheck.py
EMBED_NAME = "sentence-transformers/all-MiniLM-L6-v2"
# Multilingual and instruction-aware: matches a sentence or a Chinese gloss to a WordNet definition.
SENSE_EMBED_NAME = "Qwen/Qwen3-Embedding-0.6B"


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


@lru_cache(maxsize=None)
def vowel_sound(word: str) -> bool:
    """Whether a word takes "an": by CMUdict when it knows the word ("unidentified" yes, "unique"
    no), else by spelling."""
    word = word.lower()
    phones = _pronunciations().get(word)
    if phones:
        return phones[0][0][-1].isdigit()
    return word[0] in "aeiou" and not word.startswith(("uni", "use", "usu", "uti", "eu", "one"))


@lru_cache(maxsize=1)
def _pronunciations() -> dict:
    import nltk
    from nltk.corpus import cmudict

    nltk.download("cmudict", download_dir=str(CACHE / "nltk_data"), quiet=True)
    return cmudict.dict()


def item_key(item: dict) -> str:
    """Content key of a cloze item: its scores depend only on the sentence and the choices."""
    text = json.dumps([item["prefix"], item["answer"], item["suffix"], item["cands"]])
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def question_id(sentence: str) -> str:
    """Stable 8-hex id from the sentence with its blank, so ids survive rebuilds."""
    return hashlib.sha1(sentence.encode("utf-8")).hexdigest()[:8]


def cross_key(item: dict, chosen: list[str]) -> str:
    """Key of an item's second-model check: its content plus the distractors build.py chose."""
    text = json.dumps([item_key(item), chosen])
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
