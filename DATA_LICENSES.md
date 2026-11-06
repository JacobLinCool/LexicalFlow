# Data licences

The question bank in `static/data/` is generated offline by the pipeline in `pipeline/`
(see `pipeline/README.md` for how it is built).

- **Sentences** come from [Tatoeba](https://tatoeba.org) (© Tatoeba contributors,
  [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)) and from WordNet usage
  examples. Each sentence appears with one word replaced by a blank.
- **WordNet 3.0** © Princeton University, used under the
  [WordNet License](https://wordnet.princeton.edu/license-and-commercial-use). The English
  word definitions are the first clause of WordNet glosses, one per part of speech a word's
  questions use.
- **Word frequencies** (`zipf` values in `bands/*.json`) are derived from
  [wordfreq](https://github.com/rspeer/wordfreq) data (CC BY-SA 4.0).
- **Pronunciations** (`ipa` in `bands/*.json`) are converted to IPA from the
  [CMU Pronouncing Dictionary](http://www.speech.cs.cmu.edu/cgi-bin/cmudict) © Carnegie Mellon
  University (BSD-style licence); the few words it lacks use ECDICT's phonetic field.
- **Chinese translations** come from
  [ECDICT](https://github.com/skywind3000/ECDICT) © Linwei (skywind3000), under the
  [MIT License](https://github.com/skywind3000/ECDICT/blob/master/LICENSE), shortened to a few
  senses per part of speech.
- **Traditional Chinese conversion** uses [OpenCC](https://github.com/BYVoid/OpenCC)
  (Apache License 2.0) offline, through opencc-python-reimplemented; no OpenCC code or data
  ships with the app.

Nothing else ships in `static/data/`. The pipeline also uses tools whose code, data and weights
stay offline and are not shipped: the better-profanity word list (MIT) for filtering, spaCy
`en_core_web_sm` (MIT) for tagging, all-MiniLM-L6-v2 (Apache 2.0) for embeddings and categories,
Qwen2.5-1.5B and SmolLM3-3B-Base (both Apache 2.0) for scoring and cross-checking items, and
Qwen3-Embedding-0.6B (Apache 2.0) for choosing each word's English sense.
