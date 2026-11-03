# Question pipeline

Lexical Flow ships a static question bank in `static/data/`. This directory holds the offline
pipeline that builds it. Nothing here runs at play time.

## Run

Requires [uv](https://docs.astral.sh/uv/). The LM stage uses Apple Silicon (MPS) when available
and falls back to CPU.

```sh
cd pipeline
uv sync
uv run python prepare.py   # download + tag sentences, build vocabulary, draft cloze items
uv run python score.py     # score every item with a causal LM (resumable)
uv run python build.py     # keep validated items, categorise, write static/data/
uv run python validate.py  # check the output contract
```

Downloads, the tagged corpus and intermediate files live in `pipeline/.cache/` (git-ignored).
`score.py` appends to `.cache/scored.jsonl` and resumes after an interruption; delete that file
(and `items.jsonl`) to rescore from scratch. All random choices use a fixed seed.

## How questions are made

1. **Sentences.** English sentences from Tatoeba plus WordNet usage examples, kept when they
   have 6–22 words, start with a capital, end in `.`, `?` or `!`, and contain no digits, quotes,
   or proper nouns. spaCy (`en_core_web_sm`) supplies Penn tags and lemmas.
2. **Vocabulary.** Lemmas seen as nouns, verbs, adjectives or adverbs that exist in WordNet with
   that part of speech, have a wordfreq Zipf frequency of at least 2.3, and are not stopwords or
   function-like words.
3. **Cloze items.** A token becomes the blank when it is lowercase, not sentence-initial, appears
   once in the sentence, and is the regular inflection of its lemma for its tag. Each lemma gets
   up to four sentences; rare lemmas choose first.
4. **Distractors.** Same part of speech, inflected to the same tag (`suggests` → `declares`),
   within ±0.75 Zipf of the answer, and preferably close to it in embedding space so they are
   not trivial. Candidates are excluded when WordNet relates them to the answer (shared synset,
   hypernym/hyponym up to two steps, similar-to, also-see, antonym, derivational or pertainym
   links) or when they are near-identical spellings. Before `a`/`an`, distractors must match the
   answer's vowel sound. When the answer could be read as either noun or verb (or, for a
   noun-tagged answer, noun or adjective), distractors must allow the same readings, so a
   tagging slip cannot leave distractors of the wrong word class.
5. **Validation.** Qwen2.5-1.5B scores the full sentence with each choice filled in. An item is
   kept only when three distractors trail the answer by at least 7 nats of log-likelihood (the
   answer is ≥1100× likelier), both raw and after crediting a rarer distractor its frequency
   gap, so rarity alone cannot make a distractor look wrong. Of those, the three closest are used, so distractors are as hard as
   the check allows. Sentences or distractors containing profanity or sexual terms
   (better-profanity's word list plus a few additions) are dropped.
6. **Selection, categories and difficulty.** The 12,000 most frequent validated lemmas are kept,
   with at most two questions each. Sentences go to travel, networking or academic when their
   similarity (all-MiniLM-L6-v2) to that category's prototype sentences clears a threshold, and
   to conversation otherwise; the categories are approximate. Difficulty 1–5 follows the
   answer's Zipf frequency.

## Data sources and licences

- **Tatoeba** sentences, © Tatoeba contributors, licensed
  [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/). Source:
  <https://tatoeba.org>. Sentences are reproduced with the masked word removed.
- **WordNet 3.0**, © Princeton University, under the
  [WordNet License](https://wordnet.princeton.edu/license-and-commercial-use) (BSD-style).
- **wordfreq** frequency data, Robyn Speer et al., CC BY-SA 4.0 for the data
  (<https://github.com/rspeer/wordfreq>); only derived Zipf values are shipped.
- **better-profanity** word list (MIT), used only for filtering.
- Models used offline only (not shipped): Qwen2.5-1.5B (Apache 2.0),
  all-MiniLM-L6-v2 (Apache 2.0), spaCy en_core_web_sm (MIT).
