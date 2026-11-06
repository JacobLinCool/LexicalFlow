# Question pipeline

Lexical Flow ships a static question bank in `static/data/`. This directory holds the offline
pipeline that builds it. Nothing here runs at play time.

## Run

Requires [uv](https://docs.astral.sh/uv/). The LM stages use Apple Silicon (MPS) when available
and fall back to CPU.

```sh
cd pipeline
uv sync
uv run python prepare.py     # download + tag sentences, build vocabulary, draft cloze items
uv run python score.py       # score new items with a causal LM (resumable, content-keyed cache)
uv run python crosscheck.py  # second opinion on validated items from another model family (resumable)
uv run python glosses.py     # IPA, English and Traditional Chinese gloss per vocabulary word
uv run python build.py       # keep validated items, categorise, write static/data/ (format 2)
uv run python validate.py    # check the output contract
```

Downloads, the tagged corpus and intermediate files live in `pipeline/.cache/` (git-ignored).
`score.py` keys every score by the item's content (a hash of the sentence, answer and candidate
distractors) in `.cache/scores.jsonl`. It scores only items whose key is missing, appends as it
goes and resumes after an interruption, so regenerating `items.jsonl` (for example with more
sentences per word) costs only the new items. Delete `scores.jsonl` to rescore from scratch. An
older index-keyed `scored.jsonl` is converted once, when it still matches `items.jsonl` line for
line. Scoring runs at roughly 20–25 items per second on an Apple M-series GPU.

`crosscheck.py` works the same way: it caches the second model's scores in `.cache/scores2.jsonl`,
keyed by the item's content plus its three chosen distractors, scores only what is missing and
resumes after an interruption. Its candidates depend on `score.py`'s results, so run it after
scoring; `build.py` runs without it, and then treats every item as checked. All random choices use
a fixed seed.

## Output (format 2)

`static/data/manifest.json` lists the bank's version (a hash of the band files), counts, category
totals and one entry per band. Words are ranked by Zipf frequency and split into bands of 1,000;
`bands/NN.json` holds a band's words as `[word, pos, zipf, ipa, en, zh]` rows and its questions
as `[id, sentence, up, left, down, right, answerIndex, categoryIndex, difficulty, wordIndex]`
rows, where `wordIndex` points at the answer's word in the same file. `pos`, `en` and `zh` are
the word's main part of speech (the one the corpus uses most) and that sense's gloss. A word whose
questions also use another sense, as another part of speech ("to steal" beside "a steal") or as
another meaning of the same one, carries a seventh element, `[[pos, en, zh], …]`, listing those
senses; such a question carries an eleventh element, the index of its sense in that list. Question
ids are the first 8 hex digits of the SHA-1 of the blanked sentence, so they stay stable across
rebuilds.

The current build has 17,493 words in 18 bands and 67,953 questions: about 10.4 MB of band files,
4.0 MB gzipped.

## How questions are made

1. **Sentences.** English sentences from Tatoeba plus WordNet usage examples, kept when they
   have 6–22 words, start with a capital, end in `.`, `?` or `!`, and contain no digits, quotes,
   or proper nouns. spaCy (`en_core_web_sm`) supplies Penn tags and lemmas.
2. **Vocabulary.** Lemmas seen as nouns, verbs, adjectives or adverbs that exist in WordNet with
   that part of speech, have a wordfreq Zipf frequency of at least 2.3, and are not stopwords or
   function-like words.
3. **Cloze items.** A token becomes the blank when it is lowercase, not sentence-initial, appears
   once in the sentence, and is the regular inflection of its lemma for its tag. Each lemma gets
   up to ten candidate sentences; rare lemmas choose first, and a sentence serves at most two
   lemmas.
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
   gap, so rarity alone cannot make a distractor look wrong. Of those, the three closest are used,
   so distractors are as hard as the check allows. Sentences or distractors containing profanity
   or sexual terms (better-profanity's word list plus a few additions) are dropped, and so are
   items that would teach a wrong lesson:
   - another word of the sentence shares the answer's stem ("a princess and a ___"), which gives
     the answer away;
   - after "a"/"an", a distractor that takes the other article (judged by pronunciation);
   - WordNet usage examples without a finite verb, which read as broken sentences;
   - words that WordNet knows in that part of speech only as a person or place (a tagging slip);
   - question ids rejected in a hand review (`REVIEWED_OUT` in `build.py`).
6. **Cross-check.** A distractor that only fools Qwen's quirks would teach a wrong lesson, so
   SmolLM3-3B-Base, an independent model family, scores each validated item again on its answer
   and three chosen distractors (up to nine items per word, in the order selection prefers).
   `build.py` drops an item when this model's lead of the answer over any chosen distractor,
   with the same frequency credit, is below `CROSS_MARGIN` = 5 nats; in a hand-checked sample
   such items were often genuinely ambiguous. Spares replace them, and selection prefers
   checked items over unchecked ones.
7. **Selection, categories and difficulty.** Every validated lemma is kept, with up to six
   questions each, preferring sentences no other word uses, Tatoeba sentences and moderate
   margins. A word is taught in the part of speech the tagged corpus uses most ("long" the
   adjective); another part of speech gets sentences in proportion to its share of use, none
   below 3% and at most half. A word whose own use is far rarer than its spelling ("going" the
   noun, "better" the verb) is ranked by its own use. If the band files would exceed the size budget (`MAX_BANK_BYTES`), the rarest bands
   keep fewer questions per word first, down to three. Sentences go to travel, networking or
   academic when their similarity (all-MiniLM-L6-v2) to that category's prototype sentences
   clears a threshold, and to conversation otherwise; the categories are approximate.
   Difficulty 1–5 follows the rarest of the four choices' Zipf frequencies.
8. **Glosses.** IPA is General American from the CMU Pronouncing Dictionary, converted from
   ARPAbet with stress marks at syllable onsets (maximal legal onset); a word CMUdict lacks tries
   its American spelling, then ECDICT's phonetic field, rewritten in the same General American
   symbols. The Chinese senses come from ECDICT's translation line matching the word's part of
   speech (up to three short senses), converted to Traditional Chinese characters by OpenCC
   (`s2tw`) and then to Taiwan terms through a short table (軟件 → 軟體); OpenCC's phrase tables
   (`s2twp`) rewrite everyday words such as 程序 into software terms. The English gloss is the
   first clause of a WordNet definition, never one naming a person or place. Its sense is chosen
   by the word's own sentences: Qwen3-Embedding-0.6B compares each sentence with every candidate
   definition (the word itself hidden), with a small weight for WordNet's sense frequency, and
   the sentences vote. A sentence that clearly uses another sense is glossed with that one.
   Glosses are made for every part of speech the word's questions use. A missing field ships as
   an empty string; pairs whose English and Chinese seem to disagree are listed in
   `.cache/gloss-review.tsv` for a manual check.

## Data sources and licences

- **Tatoeba** sentences, © Tatoeba contributors, licensed
  [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/). Source:
  <https://tatoeba.org>. Sentences are reproduced with the masked word removed.
- **WordNet 3.0**, © Princeton University, under the
  [WordNet License](https://wordnet.princeton.edu/license-and-commercial-use) (BSD-style).
- **wordfreq** frequency data, Robyn Speer et al., CC BY-SA 4.0 for the data
  (<https://github.com/rspeer/wordfreq>); only derived Zipf values are shipped.
- **CMU Pronouncing Dictionary** (via NLTK), BSD-style licence: IPA pronunciations.
- **ECDICT** (<https://github.com/skywind3000/ECDICT>), MIT licence: Chinese translations
  (shortened and converted to Traditional Chinese) and fallback pronunciations.
- **OpenCC** conversion tables (Apache 2.0), via opencc-python-reimplemented, used offline only.
- **better-profanity** word list (MIT), used only for filtering.
- Models used offline only (not shipped): Qwen2.5-1.5B (Apache 2.0), SmolLM3-3B-Base
  (Apache 2.0), Qwen3-Embedding-0.6B (Apache 2.0), all-MiniLM-L6-v2 (Apache 2.0), spaCy
  en_core_web_sm (MIT).
