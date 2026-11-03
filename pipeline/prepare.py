"""Stage 1: filter and tag sentences, build the lemma vocabulary, and draft cloze items.

Each item names one sentence, the token to blank out, the answer lemma and a pool of
distractor surface forms that share the answer's part of speech and inflection. The
LM validation in `score.py` decides which items survive and which distractors to keep.
"""

from __future__ import annotations

import bz2
import json
import random
import re
import urllib.request
from collections import defaultdict

import common  # noqa: F401  (sets NLTK_DATA)
from common import CACHE, ITEMS, POOLS, SENTENCES, TARGET_TAGS, TATOEBA_TSV, TATOEBA_URL, WORDNET_POS, EMBED_NAME

SEED = 20261103
MIN_WORDS, MAX_WORDS = 6, 22
MIN_ZIPF = 2.3
SENTENCES_PER_LEMMA = 4
MAX_ITEMS_PER_SENTENCE = 2
POOL_RELATED = 6
POOL_RANDOM = 2
SURFACE_ZIPF_GAP = 1.2  # distractor surface forms stay near the answer's frequency
MIN_SURFACE_ZIPF = 1.0

CLEAN = re.compile(r"^[A-Z][A-Za-z ,'’;:\-]*[a-z][.?!]$")
FUNCTION_WORDS = {
    "be", "have", "do", "say", "get", "make", "go", "can", "will", "would", "shall", "should",
    "may", "might", "must", "could", "not", "also", "very", "too", "just", "only", "even", "still",
    "then", "than", "there", "here", "now", "well", "much", "many", "more", "most", "less", "least",
    "such", "own", "same", "other", "another", "each", "every", "few", "lot", "thing", "things",
    "yes", "okay", "really", "actually", "always", "never", "ever", "already", "yet", "again",
    "however", "though", "although", "enough", "quite", "rather", "almost", "perhaps", "maybe",
    "away", "back", "out", "off", "over", "up", "down", "about", "around", "together", "else",
    "somewhere", "anywhere", "everywhere", "nowhere", "sometimes", "often", "soon", "later",
    "today", "tomorrow", "yesterday", "tonight", "something", "anything", "nothing", "everything",
    "someone", "anyone", "everyone", "nobody", "somebody", "anybody", "everybody", "one", "ones",
}


def download_tatoeba() -> None:
    if TATOEBA_TSV.exists():
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / "eng_sentences.tsv.bz2"
    if not archive.exists():
        print("downloading Tatoeba English sentences")
        urllib.request.urlretrieve(TATOEBA_URL, archive)
    with bz2.open(archive, "rb") as src, open(TATOEBA_TSV, "wb") as dst:
        dst.write(src.read())


def raw_sentences() -> list[tuple[str, str]]:
    """Return (source, text) pairs that pass the cheap surface filters."""
    from nltk.corpus import wordnet as wn

    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def keep(source: str, text: str) -> None:
        text = text.strip().replace("’", "'")
        if not CLEAN.match(text):
            return
        n = len(text.split())
        if not MIN_WORDS <= n <= MAX_WORDS:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        out.append((source, text))

    with open(TATOEBA_TSV, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3:
                keep("tatoeba", parts[2])

    for synset in wn.all_synsets():
        for example in synset.examples():
            example = example.strip()
            if example and example[0].islower():
                example = example[0].upper() + example[1:]
            if example and example[-1] not in ".?!":
                example += "."
            keep("wordnet", example)
    return out


def tag_sentences() -> None:
    if SENTENCES.exists():
        return
    import spacy

    download_tatoeba()
    pairs = raw_sentences()
    print(f"{len(pairs)} sentences pass surface filters; tagging")
    nlp = spacy.load("en_core_web_sm", disable=["parser", "ner"])
    kept = 0
    with open(SENTENCES, "w", encoding="utf-8") as f:
        texts = (text for _, text in pairs)
        for (source, text), doc in zip(pairs, nlp.pipe(texts, batch_size=2000, n_process=8)):
            if any(t.tag_ in ("NNP", "NNPS") or t.like_num for t in doc):
                continue
            toks = [[t.text, t.tag_, t.lemma_.lower(), t.idx] for t in doc]
            f.write(json.dumps({"id": kept, "src": source, "text": text, "toks": toks}) + "\n")
            kept += 1
    print(f"{kept} tagged sentences without proper nouns or numbers")


def wordnet_related(lemma: str, pos: str) -> set[str]:
    """Lemma names whose meaning overlaps the answer enough to make a distractor ambiguous."""
    from nltk.corpus import wordnet as wn

    related: set[str] = set()

    def names(ss) -> None:
        for l in ss.lemmas():
            related.add(l.name().lower())

    for ss in wn.synsets(lemma, pos=WORDNET_POS[pos]):
        names(ss)
        neighbours = (
            ss.hypernyms() + ss.hyponyms() + ss.similar_tos() + ss.also_sees() + ss.verb_groups()
            + ss.entailments() + ss.causes() + ss.instance_hypernyms()
        )
        for n in neighbours:
            names(n)
            for nn in n.hypernyms() + n.hyponyms() + n.similar_tos():
                names(nn)
        for l in ss.lemmas():
            for rel in l.antonyms() + l.derivationally_related_forms() + l.pertainyms():
                related.add(rel.name().lower())
                names(rel.synset())
    return related


def close_spelling(a: str, b: str) -> bool:
    if a[:5] == b[:5] and min(len(a), len(b)) >= 5:
        return True
    if abs(len(a) - len(b)) > 2:
        return False
    # Levenshtein distance <= 2 (colour/color, travelled/traveled, ...)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= 2


def build_vocab(sentences: list[dict]) -> dict[tuple[str, str], float]:
    """Lemma/POS pairs observed as blank-able tokens, with WordNet coverage and a Zipf floor."""
    from nltk.corpus import stopwords, wordnet as wn
    from wordfreq import zipf_frequency

    stop = set(stopwords.words("english")) | FUNCTION_WORDS
    seen: set[tuple[str, str]] = set()
    for s in sentences:
        for text, tag, lemma, _ in s["toks"]:
            if tag in TARGET_TAGS:
                seen.add((lemma, TARGET_TAGS[tag]))
    vocab: dict[tuple[str, str], float] = {}
    for lemma, pos in seen:
        if len(lemma) < 3 or not lemma.isalpha() or not lemma.islower() or lemma in stop:
            continue
        if not wn.synsets(lemma, pos=WORDNET_POS[pos]):
            continue
        z = zipf_frequency(lemma, "en")
        if z >= MIN_ZIPF:
            vocab[(lemma, pos)] = z
    return vocab


def inflect(lemma: str, tag: str) -> str | None:
    from lemminflect import getInflection

    if tag in ("NN", "VB", "JJ", "RB"):
        return lemma
    forms = getInflection(lemma, tag)
    return forms[0] if forms else None


def surface_pos(form: str) -> frozenset[str]:
    """Open-class parts of speech WordNet allows for a surface form."""
    from nltk.corpus import wordnet as wn

    return frozenset(p for p, w in (("n", "n"), ("v", "v"), ("adj", "a")) if wn._morphy(form, w))


def starts_with_vowel_sound(word: str) -> bool:
    return word[0] in "aeiou" and not word.startswith(("uni", "use", "usu", "uti", "eu", "one"))


def build_pools(vocab: dict[tuple[str, str], float], rng: random.Random) -> dict[tuple[str, str], list[str]]:
    """Related-first distractor pools per lemma, cached because the WordNet walk is slow."""
    if POOLS.exists():
        raw = json.loads(POOLS.read_text())
        return {tuple(k.split("|")): v for k, v in raw.items()}
    print("embedding vocabulary for distractor relatedness")
    from sentence_transformers import SentenceTransformer
    import numpy as np

    model = SentenceTransformer(EMBED_NAME, device="mps")
    by_pos: dict[str, list[str]] = defaultdict(list)
    for lemma, pos in vocab:
        by_pos[pos].append(lemma)
    pools: dict[tuple[str, str], list[str]] = {}
    for pos, lemmas in by_pos.items():
        lemmas.sort()
        emb = model.encode(lemmas, batch_size=512, normalize_embeddings=True, convert_to_numpy=True)
        zipfs = np.array([vocab[(l, pos)] for l in lemmas])
        sims = emb @ emb.T
        for i, lemma in enumerate(lemmas):
            band = np.abs(zipfs - zipfs[i]) <= 0.75
            band[i] = False
            idx = np.where(band & (sims[i] < 0.8))[0]
            order = idx[np.argsort(-sims[i][idx])]
            related = wordnet_related(lemma, pos)
            ranked = [lemmas[j] for j in order[:120] if lemmas[j] not in related and not close_spelling(lemma, lemmas[j])]
            rest = [lemmas[j] for j in idx if lemmas[j] not in related and not close_spelling(lemma, lemmas[j])]
            pools[(lemma, pos)] = ranked[:80] + rng.sample(rest, min(40, len(rest)))
        print(f"  {pos}: {len(lemmas)} lemmas")

    POOLS.write_text(json.dumps({f"{l}|{p}": v for (l, p), v in pools.items()}))
    return pools


def main() -> None:
    import nltk

    nltk.download("wordnet", download_dir=str(CACHE / "nltk_data"), quiet=True)
    nltk.download("omw-1.4", download_dir=str(CACHE / "nltk_data"), quiet=True)
    nltk.download("stopwords", download_dir=str(CACHE / "nltk_data"), quiet=True)
    tag_sentences()

    rng = random.Random(SEED)
    sentences = [json.loads(l) for l in open(SENTENCES, encoding="utf-8")]
    vocab = build_vocab(sentences)
    print(f"{len(vocab)} lemma/POS pairs in the candidate vocabulary")

    # Occurrences of each vocabulary lemma that can be blanked cleanly.
    occurrences: dict[tuple[str, str], list[tuple[int, int, str]]] = defaultdict(list)
    for s in sentences:
        toks = s["toks"]
        lowered = [t[0].lower() for t in toks]
        for i, (text, tag, lemma, _) in enumerate(toks):
            if i == 0 or tag not in TARGET_TAGS:
                continue
            key = (lemma, TARGET_TAGS[tag])
            if key not in vocab or text != text.lower() or not text.isalpha():
                continue
            if lowered.count(text) != 1 or inflect(lemma, tag) != text:
                continue
            # Skip blanks fused with a following clitic or hyphen ("don't", "well-known").
            if i + 1 < len(toks) and toks[i + 1][0] in ("-", "n't"):
                continue
            occurrences[key].append((s["id"], i, tag))

    # Lemmas need an occurrence to be part of the distractor space too.
    vocab = {k: z for k, z in vocab.items() if k in occurrences}
    print(f"{len(vocab)} lemma/POS pairs with at least one usable sentence")

    pools = build_pools(vocab, rng)
    from wordfreq import zipf_frequency

    sentence_use: dict[int, int] = defaultdict(int)
    by_id = {s["id"]: s for s in sentences}
    n_items = 0
    with open(ITEMS, "w", encoding="utf-8") as f:
        # Rare lemmas pick first so they are not starved of sentences by common ones.
        for (lemma, pos) in sorted(vocab, key=lambda k: vocab[k]):
            occ = occurrences[(lemma, pos)][:]
            rng.shuffle(occ)
            occ.sort(key=lambda o: abs(len(by_id[o[0]]["toks"]) - 12))
            picked = 0
            for sid, ti, tag in occ:
                if picked >= SENTENCES_PER_LEMMA:
                    break
                if sentence_use[sid] >= MAX_ITEMS_PER_SENTENCE:
                    continue
                s = by_id[sid]
                lowered = {t[0].lower() for t in s["toks"]}
                answer = s["toks"][ti][0]
                prev = s["toks"][ti - 1][0].lower()
                pool = pools[(lemma, pos)]
                related_part, random_part = pool[:80], pool[80:]
                answer_pos = surface_pos(answer)
                answer_zipf = zipf_frequency(answer, "en")
                cands: list[str] = []
                for group, quota in ((related_part, POOL_RELATED), (random_part, POOL_RANDOM)):
                    taken = 0
                    for other in group:
                        if taken >= quota:
                            break
                        form = inflect(other, tag)
                        if not form or form == answer or form in lowered or form in cands or not form.isalpha():
                            continue
                        fz = zipf_frequency(form, "en")
                        if fz < MIN_SURFACE_ZIPF or abs(fz - answer_zipf) > SURFACE_ZIPF_GAP:
                            continue
                        # A tagger slip (verb read as noun) must not leave distractors of the wrong
                        # class, so ambiguous answers get distractors with the same ambiguity.
                        if not (answer_pos & {"n", "v"}) <= surface_pos(form):
                            continue
                        if prev in ("a", "an") and starts_with_vowel_sound(form) != starts_with_vowel_sound(answer):
                            continue
                        cands.append(form)
                        taken += 1
                if len(cands) < 5:
                    continue
                start = s["toks"][ti][3]
                text = s["text"]
                f.write(json.dumps({
                    "sid": sid,
                    "src": s["src"],
                    "lemma": lemma,
                    "pos": pos,
                    "zipf": round(vocab[(lemma, pos)], 2),
                    "tag": tag,
                    "prefix": text[:start],
                    "suffix": text[start + len(answer):],
                    "answer": answer,
                    "cands": cands,
                }) + "\n")
                sentence_use[sid] += 1
                picked += 1
                n_items += 1
    print(f"{n_items} candidate items written to {ITEMS}")


if __name__ == "__main__":
    main()
