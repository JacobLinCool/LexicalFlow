"""Stage 2b: what the app shows about each vocabulary lemma, and how the corpus uses it.

- IPA is General American from the CMU Pronouncing Dictionary, converted from ARPAbet with
  stress marks placed at syllable onsets. A word CMUdict lacks tries its American spelling
  (behaviour → behavior), then falls back to ECDICT's phonetic field, whose older British
  notation is rewritten in the same General American symbols (ˈməutəwei → ˈmoʊtɚweɪ).
- Chinese comes from ECDICT (MIT licence): senses from the translation line for the lemma's part
  of speech, converted to Traditional Chinese characters (OpenCC `s2tw`) and then to Taiwan terms
  through a short table. OpenCC's own Taiwan phrase tables (`s2twp`) are tuned for software and
  rewrite everyday words: 程序 becomes 程式 (a computer program), 支持 becomes 支援.
- English is the first clause of the WordNet definition of the sense the lemma's own sentences
  use (see choose_sense), and a sentence that clearly uses another sense gets that one. Instance
  synsets, which name people and places ("Villa": a Mexican revolutionary), are never used.
- Usage counts how often the tagged corpus uses the lemma as each part of speech, so build.py
  can rank a word by its own use ("going" the noun is rare, however common the spelling) and
  teach its common part of speech first ("long" the adjective, not the verb).

Output: `.cache/glosses.json` = {lemma: {"ipa", "pos", "en", "zh", "senses": {pos: [en, zh]},
"variants": {question id: [pos, en]}, "usage": {pos: count}, "zipf"}}, where `pos` is the lemma's
most used part of speech among those it was drafted with, `en`/`zh` repeat its gloss, `senses`
holds a gloss for every part of speech that has one, `variants` the English gloss of sentences
that use another sense of that part of speech, and `zipf` is the lemma's own corpus frequency.
Pairs whose English and Chinese glosses seem to disagree are listed in `.cache/gloss-review.tsv`
for a manual check.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import urllib.request
from collections import Counter, defaultdict

import common  # noqa: F401  (sets NLTK_DATA)
from common import CACHE, GLOSSES, ITEMS, SENSE_EMBED_NAME, SENTENCES, TARGET_TAGS, WORDNET_POS, question_id

ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
ECDICT_CSV = CACHE / "ecdict.csv"
SENSES = CACHE / "senses.jsonl"  # sense-similarity cache, keyed by its inputs (see sense_key)
REVIEW = CACHE / "gloss-review.tsv"
MAX_ZH = 24  # characters
MAX_ZH_SENSES = 3
MAX_EN = 120  # characters
SENSE_SENTENCES = 10  # sentences per lemma and part of speech that vote on its sense (all prepare.py drafts)

# Sense choice (see choose_sense): weight of the log SemCor count against the sentences' mean
# similarity. On 78 hand-labelled words this picked a fitting sense for 66, the most frequent
# sense alone for 49; 0.02-0.04 did about as well.
W_PRIOR = 0.03
# A sentence that fits another sense of the word better by this much is glossed with that sense
# ("major": an army officer in "A major had to take command", a student elsewhere). In samples
# at and above this margin the sentence's own sense was the better gloss about five times in six.
SENTENCE_MARGIN = 0.03
REVIEW_SHARE = 0.03  # the share of glosses, worst matched first, listed for a manual check

SENTENCE_QUERY = (
    'Instruct: Given a sentence, retrieve the dictionary definition of the word "{word}" as it is '
    "used in the sentence\nQuery:{text}"
)
# Only for the review list: how well a definition matches the Chinese senses.
ZH_QUERY = (
    'Instruct: Given Chinese translations of the English word "{word}", retrieve the English '
    "dictionary definition with the same meaning\nQuery:{text}"
)

# ECDICT translation-line prefixes per coarse part of speech.
ZH_POS = {
    "n": {"n."},
    "v": {"v.", "vt.", "vi."},
    "adj": {"a.", "adj."},
    "adv": {"ad.", "adv."},
}
ANY_POS = set().union(*ZH_POS.values(), {"pron.", "prep.", "conj.", "int.", "interj.", "num.", "art.", "aux."})
LINE_POS = re.compile(r"^((?:[a-z]+\.\s*(?:[&/,]\s*)?)+)\s*(.*)$")
NOTES = re.compile(r"\[[^\]]*\]|（[^）]*）|\([^)]*\)|<[^>]*>|〈[^〉]*〉|【[^】]*】")
SENSE_SPLIT = re.compile(r"[,，;；]")
CJK = re.compile(r"[㐀-鿿]")
LATIN = re.compile(r"[A-Za-z]")

# Mainland terms after character conversion, and the words Taiwan uses. Replaced anywhere in a
# sense, so every key is unambiguous on its own (的士 is not here: it also occurs in 的士兵).
TW_TERMS = {
    "軟件": "軟體", "硬件": "硬體", "固件": "韌體", "數據庫": "資料庫", "數據": "資料", "網絡": "網路",
    "互聯網": "網際網路", "因特網": "網際網路", "信息": "資訊", "博客": "部落格", "寬帶": "寬頻",
    "鏈接": "連結", "光標": "游標", "磁盤": "磁碟", "硬盤": "硬碟", "內存": "記憶體", "字節": "位元組",
    "界面": "介面", "黑客": "駭客", "服務器": "伺服器", "操作系統": "作業系統", "計算機": "電腦",
    "打印機": "印表機", "打印": "列印", "鼠標": "滑鼠", "視頻": "影片", "音頻": "音訊", "短信": "簡訊",
    "程序員": "程式設計師", "智能": "智慧", "數碼": "數位", "集成電路": "積體電路", "晶體管": "電晶體",
    "複印": "影印", "激光": "雷射", "鐳射": "雷射", "鱷梨": "酪梨", "金槍魚": "鮪魚", "三文魚": "鮭魚",
    "宇航員": "太空人", "航天飛機": "太空梭", "出租車": "計程車", "公交車": "公車", "土豆": "馬鈴薯",
    "西紅柿": "番茄", "菠蘿": "鳳梨", "獼猴桃": "奇異果", "塑料": "塑膠", "幼兒園": "幼稚園",
    "方便麵": "泡麵", "蹦極": "高空彈跳", "新西蘭": "紐西蘭", "意大利": "義大利", "悉尼": "雪梨",
    "大學本科生": "大學生", "本科生": "大學生",
}
TW_PATTERN = re.compile("|".join(sorted(map(re.escape, TW_TERMS), key=len, reverse=True)))

# Older ECDICT spellings use look-alike or ASCII stand-ins for IPA symbols.
IPA_CHARS = str.maketrans({"ә": "ə", "є": "ɛ", "ε": "ɛ", ":": "ː", "'": "ˈ", ",": "ˌ", "\xa0": "", "g": "ɡ"})

# CMUdict entries that are plainly wrong ("microscopy" with the vowel of "cup").
IPA_FIXES = {"microscopy": "maɪˈkrɑskəpi"}

# British spellings with an American twin CMUdict knows (behaviour → behavior, centre → center).
AMERICAN = [
    ("our", "or"), ("tre", "ter"), ("ise", "ize"), ("isa", "iza"), ("yse", "yze"), ("ogue", "og"),
    ("ae", "e"), ("oe", "e"), ("ll", "l"), ("mme", "m"), ("ence", "ense"), ("eable", "able"),
]
NOT_BRITISH = {"amour"}  # "amour" is not "amor"


def download_ecdict() -> None:
    if ECDICT_CSV.exists():
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    print("downloading ECDICT")
    urllib.request.urlretrieve(ECDICT_URL, ECDICT_CSV)


def normalise_ipa(raw: str) -> str:
    """First pronunciation of an ECDICT phonetic field, in IPA stress marks, without slashes."""
    text = raw.strip().strip("/[]")
    if not text:
        return ""
    # Variants are separated by ';', ', ' or '. ' ("li:d. led", "'kɔndʌkt, -dәkt").
    text = re.split(r";|,\s|\.\s", text)[0].strip()
    # Without a space, '.' is either a variant separator ("ә'bju:s.ә'bju:z": two primary
    # stresses) or an older secondary-stress mark (".æbdi'keiʃәn").
    parts = text.split(".")
    if sum("'" in p for p in parts) >= 2:
        text = next(p for p in parts if "'" in p)
    else:
        text = text.replace(".", ",")
    # A few entries carry mojibake: '^' for ɡ, backslash runs for ɜ, 'әj' for əʊ.
    if "^" in text or "\\" in text:
        text = re.sub(r"\\+", "ɜ", text.replace("^", "ɡ")).replace("әj", "әʊ")
    text = text.translate(IPA_CHARS).rstrip("ˌ ").strip()
    if not text or "-" in text or "?" in text or "@" in text:
        return ""
    return text


# ECDICT's British vowels in General American, longest first; True marks a vowel that takes an
# r colour when the spelling has an r after it ("rampart" ɑː → ɑr, "molar" ə → ɚ).
GA_UNITS = [
    ("əʊ", "oʊ", False), ("əu", "oʊ", False), ("ou", "oʊ", False), ("oʊ", "oʊ", False),
    ("ei", "eɪ", False), ("eɪ", "eɪ", False), ("ai", "aɪ", False), ("aɪ", "aɪ", False),
    ("au", "aʊ", False), ("aʊ", "aʊ", False), ("ɔi", "ɔɪ", False), ("ɔɪ", "ɔɪ", False),
    ("iə", "ɪə", True), ("ɪə", "ɪə", True), ("eə", "ɛə", True), ("ɛə", "ɛə", True),
    ("uə", "ʊə", True), ("ʊə", "ʊə", True), ("iː", "i", False), ("uː", "u", False),
    ("ɑː", "ɑ", True), ("ɔː", "ɔ", True), ("ɒː", "ɔ", True), ("əː", "ɝ", False), ("ɜː", "ɝ", False),
    ("ɜ", "ɝ", False), ("ə", "ə", True), ("ɒ", "ɑ", False), ("ɔ", "ɑ", False), ("e", "ɛ", False),
    ("i", "ɪ", False), ("u", "ʊ", False),
]
R_COLOURED = {"ɪə": "ɪr", "ɛə": "ɛr", "ʊə": "ʊr", "ɑ": "ɑr", "ɔ": "ɔr", "ə": "ɚ"}
# Before a sounded r and a vowel ("urination": juə-r-i), the British glide drops: jʊr.
BEFORE_R = {"ɪə": "ɪ", "ɛə": "ɛ", "ʊə": "ʊ"}


def general_american(ipa: str, word: str) -> str:
    """Rewrite ECDICT's non-rhotic British IPA in the symbols the CMUdict-derived IPA uses.

    Each r the spelling has after a vowel ("motor", "care") colours the British vowel nearest to
    it by relative position; ɜː always stands for one ("bird"), so it uses up the nearest r.
    """
    units: list[list] = []  # [symbol, r-colourable, is vowel]
    # Optional sounds in parentheses are sounded in America ("ˈsentiˌmiːtə(r)", "ˈmænt(ə)lpis").
    ipa = re.sub(r"\(([^)]*)\)", r"\1", ipa)
    i = 0
    while i < len(ipa):
        for src, dst, colourable in GA_UNITS:
            if ipa.startswith(src, i):
                units.append([dst, colourable, True])
                i += len(src)
                break
        else:
            if ipa[i] != "ː":
                units.append([ipa[i], False, False])
            i += 1
    # A short i at the end is the happY vowel, which the CMUdict IPA writes as i.
    if units and units[-1][0] == "ɪ":
        units[-1][0] = "i"
    # A colourable vowel before a sounded r: merge them before a consonant or at the end
    # ("ˈsentiˌmiːtər" → …tɚ), drop the glide before a vowel.
    merged: list[list] = []
    for k, u in enumerate(units):
        if u[0] == "r" and merged and merged[-1][1]:
            prev = merged[-1]
            prev[1] = False
            if k + 1 == len(units) or not units[k + 1][2]:
                prev[0] = R_COLOURED[prev[0]]
                continue
            prev[0] = BEFORE_R.get(prev[0], prev[0])
        merged.append(u)
    units = merged

    letters = [m.start() for m in re.finditer(r"(?<=[aeiouy])r(?![aeiouy])|(?<=[aeiouy])r(?=es?$|ed$)", word)]
    spelled = [p / max(1, len(word) - 1) for p in letters]
    sounded = [u for u in units if u[0] not in "ˈˌ"]
    where = {id(u): k / max(1, len(sounded) - 1) for k, u in enumerate(sounded)}
    free = [u for u in sounded if u[2] and (u[1] or u[0] == "ɝ")]
    for p in spelled:
        if not free:
            break
        nearest = min(free, key=lambda u: abs(where[id(u)] - p))
        if abs(where[id(nearest)] - p) > 0.35:
            continue
        free.remove(nearest)
        if nearest[0] != "ɝ":
            nearest[0] = R_COLOURED[nearest[0]]
    return "".join(u[0] for u in units)


ARPA_VOWELS = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "ER": "ɝ",
    "EY": "eɪ", "IH": "ɪ", "IY": "i", "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "u",
}
ARPA_CONSONANTS = {
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h", "JH": "dʒ", "K": "k",
    "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "r", "S": "s", "SH": "ʃ", "T": "t",
    "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}
# Consonant clusters that can start an English syllable; a stress mark goes before the longest
# one that ends a cluster ("ex-PLAIN" → ɪkˈspleɪn, "com-PU-ter" → kəmˈpjutɚ).
ONSETS = {
    tuple(o.split())
    for o in (
        "P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|S F|"
        "T W|D W|K W|G W|TH W|P Y|B Y|K Y|G Y|M Y|F Y|V Y|HH Y|S P R|S P L|S T R|S K R|S K W|S K Y|S P Y"
    ).split("|")
}


def arpabet_ipa(phones: list[str]) -> str:
    """IPA for one CMUdict pronunciation, with ˈ/ˌ before the onset of stressed syllables."""
    out: list[str] = []
    cluster: list[str] = []  # consonants since the previous vowel
    for phone in phones:
        base, stress = phone.rstrip("012"), phone[len(phone.rstrip("012")):]
        if base not in ARPA_VOWELS:
            cluster.append(base)
            continue
        if not cluster and out and out[-1] in ("ɚ", "ɝ"):
            # CMUdict writes "liberation" as ...B ER EY...: the r starts the next syllable.
            out[-1] = "ə" if out[-1] == "ɚ" else "ɜ"
            cluster = ["R"]
        split = len(cluster) if out else 0  # all leading consonants are the first onset
        for k in range(len(cluster)):
            tail = tuple(cluster[k:])
            if len(tail) == 1 and tail[0] != "NG" or tail in ONSETS:
                split = k
                break
        coda, onset = cluster[:split], cluster[split:]
        out.extend(ARPA_CONSONANTS[c] for c in coda)
        if stress in ("1", "2"):
            out.append("ˈ" if stress == "1" else "ˌ")
        out.extend(ARPA_CONSONANTS[c] for c in onset)
        vowel = ARPA_VOWELS[base]
        if stress == "0":
            vowel = {"ʌ": "ə", "ɝ": "ɚ"}.get(vowel, vowel)
        out.append(vowel)
        cluster = []
    out.extend(ARPA_CONSONANTS[c] for c in cluster)
    ipa = "".join(out)
    # A one-syllable word needs no stress mark.
    return ipa.lstrip("ˈ") if sum(p[-1] in "012" for p in phones) == 1 else ipa


def pronounce(word: str, pronunciations: dict, row: dict | None) -> str:
    """General American IPA: CMUdict, its American spelling, then ECDICT rewritten."""
    if word in IPA_FIXES:
        return IPA_FIXES[word]
    if word in pronunciations:
        return arpabet_ipa(pronunciations[word][0])
    if word not in NOT_BRITISH:
        variants = [word.replace(a, b) for a, b in AMERICAN if a in word]
        for variant in variants:
            if variant in pronunciations:
                return arpabet_ipa(pronunciations[variant][0])
    ipa = normalise_ipa(row["phonetic"]) if row else ""
    return general_american(ipa, word) if ipa else ""


def split_lines(translation: str) -> list[tuple[set[str], str]]:
    """ECDICT translation lines as (POS prefixes, body); unprefixed lines get an empty set."""
    out = []
    for line in translation.replace("\\n", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        m = LINE_POS.match(line)
        if m and CJK.search(m.group(2)):
            out.append((set(re.findall(r"[a-z]+\.", m.group(1))), m.group(2)))
        else:
            out.append((set(), line))
    return out


def chinese_senses(body: str) -> list[str]:
    """The Chinese senses of one translation line, without notes or English."""
    senses: list[str] = []
    for sense in SENSE_SPLIT.split(NOTES.sub("", body)):
        sense = sense.strip(" 　.。:：、").replace("...", "…").replace("时侯", "时候")
        if sense and CJK.search(sense) and not LATIN.search(sense) and sense not in senses:
            senses.append(sense)
    return senses


def to_taiwan(sense: str, cc) -> str:
    return TW_PATTERN.sub(lambda m: TW_TERMS[m.group(0)], cc.convert(sense))


def chinese_gloss(translation: str, pos: str, cc) -> str:
    """Up to three short senses from the line for `pos`, in Traditional Chinese.

    Without a line for `pos`, the first line without any part of speech stands in; another part
    of speech's senses would mislead ("better" the verb is not 較好的).
    """
    lines = split_lines(translation)
    bodies = [body for tags, body in lines if tags & ZH_POS[pos]]
    if not bodies:
        # A line without a part of speech ("pl. 资料, 数据"); a field's jargon ("[医] 穿刺") only
        # when the entry has nothing else ("internet": "[计] 因特网").
        untagged = [body for tags, body in lines if not tags & ANY_POS]
        plain = [body for body in untagged if not body.startswith("[")]
        bodies = (plain or (untagged if len(untagged) == len(lines) else []))[:1]
    senses: list[str] = []
    for body in bodies:
        for sense in chinese_senses(body):
            sense = to_taiwan(sense, cc)
            if sense not in senses:
                senses.append(sense)
    if not senses:
        return ""
    picked = [senses[0][:MAX_ZH]]
    for sense in senses[1:]:
        if len(picked) >= MAX_ZH_SENSES or len("；".join([*picked, sense])) > MAX_ZH:
            break
        picked.append(sense)
    return "；".join(picked)


def has_own_translation(translation: str) -> bool:
    """Whether a translation has a Chinese sense of its own, not just a note like "burn的过去式"."""
    return any(chinese_senses(body) for _, body in split_lines(translation))


def wordnet_senses(lemma: str, pos: str) -> list[tuple[object, int]]:
    """The lemma's common WordNet senses for `pos`, each with the lemma's SemCor count in it.

    Instance synsets name people and places and are never candidates. Lemma names must match
    the spelling exactly, so "Turner" (a person) is not a sense of "turner"; a word WordNet only
    lists capitalised ("martian" as "Martian") falls back to a case-insensitive match.
    """
    from nltk.corpus import wordnet as wn

    synsets = [ss for ss in wn.synsets(lemma, pos=WORDNET_POS[pos]) if not ss.instance_hypernyms()]
    for same in (lambda name: name == lemma, lambda name: name.lower() == lemma):
        found = []
        for ss in synsets:
            counts = [l.count() for l in ss.lemmas() if same(l.name())]
            if counts:
                found.append((ss, max(counts)))
        if found:
            return found
    return []


def describe(synset, lemma: str) -> str:
    """A sense as the embedding model sees it, without the word itself in the definition: its
    overlap with the sentence would favour definitions that use it ("right": "location near …
    the right side" for "the right to vote"). Adding synonyms or examples scored worse."""
    definition = re.sub(rf"\b{re.escape(lemma)}\b", "…", synset.definition(), flags=re.IGNORECASE)
    return f"{lemma}: {definition}"


def clause(definition: str) -> str:
    """The first clause of a definition, without parenthetical notes, cut at a phrase boundary."""
    clauses = definition.split(";")
    # "primarily temporal sense; being or indicating a relatively great … duration" ("long").
    if len(clauses) > 1 and re.fullmatch(r"(primarily )?\w+ sense", clauses[0].strip()):
        clauses = clauses[1:]
    first = clauses[0].replace("_", " ")
    # Drop parenthetical notes ("(computer science)", "(such as ...)") to keep the clause short.
    text = re.sub(r"\s+", " ", re.sub(r"\s*\([^)]*\)", "", first)).strip(" ,:") or first.strip()
    if len(text) <= MAX_EN:
        return text
    head = text[: MAX_EN - 1]
    # End at a comma or before a connective rather than mid-phrase, when that keeps most of it.
    cut = max(head.rfind(sep) for sep in (", ", " or ", " and ", " that ", " which ", " as ", " in ", " of "))
    if cut < MAX_EN // 2:
        cut = head.rfind(" ")
    return head[:cut].rstrip(",:; ") + "…"


def sense_key(lemma: str, pos: str, sentences: list[str], descriptions: list[str], zh: str) -> str:
    """Cache key of one sense choice: every input of its similarities."""
    text = json.dumps([SENSE_EMBED_NAME, lemma, pos, sentences, descriptions, zh])
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def load_sense_cache() -> dict[str, dict]:
    """Cached similarities by sense_key: "s" (sentence × candidate) and "z" (Chinese × candidate)."""
    cache: dict[str, dict] = {}
    if SENSES.exists():
        with open(SENSES, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a line cut short by an interrupted run
                cache[row["k"]] = row
    return cache


def embed_senses(cache: dict[str, dict], pending: list[tuple[str, str, list[str], list[str], str]]) -> None:
    """Similarities for uncached sense choices (key, lemma, sentences, descriptions, zh), appended to SENSES."""
    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    queries, docs = [], []
    for _, lemma, sentences, descriptions, zh in pending:
        queries.extend(SENTENCE_QUERY.format(word=lemma, text=s) for s in sentences)
        if zh:
            queries.append(ZH_QUERY.format(word=lemma, text=zh))
        docs.extend(descriptions)
    print(f"embedding {len(queries)} queries and {len(docs)} sense descriptions")
    model = SentenceTransformer(
        SENSE_EMBED_NAME,
        device="mps" if torch.backends.mps.is_available() else "cpu",
        model_kwargs={"torch_dtype": torch.float16},
    )
    q = model.encode(queries, batch_size=128, normalize_embeddings=True, show_progress_bar=True)
    d = model.encode(docs, batch_size=128, normalize_embeddings=True, show_progress_bar=True)
    qi = di = 0
    with open(SENSES, "a", encoding="utf-8") as f:
        for key, _, sentences, descriptions, zh in pending:
            defs = d[di : di + len(descriptions)].astype(np.float32)
            di += len(descriptions)
            sims = q[qi : qi + len(sentences)].astype(np.float32) @ defs.T
            row = {"k": key, "s": np.round(sims, 4).tolist(), "z": None}
            qi += len(sentences)
            if zh:
                row["z"] = np.round(q[qi].astype(np.float32) @ defs.T, 4).tolist()
                qi += 1
            cache[key] = row
            f.write(json.dumps(row) + "\n")


def sense_bias(candidates: list[tuple[object, int]]) -> list[float]:
    """What each candidate sense brings to its score before the sentences vote: its frequency."""
    return [W_PRIOR * math.log1p(count) for _, count in candidates]


def choose_sense(sims: list[list[float]], bias: list[float]) -> int:
    """Index of the candidate sense the sentences use.

    WordNet's most frequent sense is often not the one a learner meets ("right": the side to the
    east when facing north; "mansion": a zodiac house), so the lemma's own sentences vote by mean
    similarity, and the bias settles close calls ("long" in time, not in speech sounds).
    Weighing in the Chinese senses as well did not help.
    """
    def score(j: int) -> float:
        return (sum(row[j] for row in sims) / len(sims) if sims else 0.0) + bias[j]

    return max(range(len(bias)), key=score)


def sentence_senses(sims: list[list[float]], bias: list[float], chosen: int) -> list[int]:
    """Each sentence's own sense: the chosen one unless another fits it by SENTENCE_MARGIN."""
    out = []
    for row in sims:
        score = [row[j] + bias[j] for j in range(len(bias))]
        best = max(range(len(bias)), key=lambda j: score[j])
        out.append(best if score[best] - score[chosen] >= SENTENCE_MARGIN else chosen)
    return out


def corpus_usage(lemmas: set[str]) -> tuple[dict[str, Counter], int]:
    """How often the tagged corpus uses each lemma as each part of speech, and its token count."""
    usage: dict[str, Counter] = defaultdict(Counter)
    tokens = 0
    with open(SENTENCES, encoding="utf-8") as f:
        for line in f:
            toks = json.loads(line)["toks"]
            tokens += len(toks)
            for _, tag, lemma, _ in toks:
                if tag in TARGET_TAGS and lemma in lemmas:
                    usage[lemma][TARGET_TAGS[tag]] += 1
    return usage, tokens


def main() -> None:
    import nltk
    from nltk.corpus import cmudict
    from opencc import OpenCC

    download_ecdict()
    nltk.download("cmudict", download_dir=str(CACHE / "nltk_data"), quiet=True)
    pronunciations = cmudict.dict()
    lemma_pos: dict[str, Counter] = {}
    sentences: dict[tuple[str, str], list[str]] = defaultdict(list)
    ids: dict[tuple[str, str], list[str]] = defaultdict(list)  # question ids of those sentences
    with open(ITEMS, encoding="utf-8") as f:
        for line in f:
            it = json.loads(line)
            lemma_pos.setdefault(it["lemma"], Counter())[it["pos"]] += 1
            group = sentences[(it["lemma"], it["pos"])]
            if len(group) < SENSE_SENTENCES:
                group.append(it["prefix"] + it["answer"] + it["suffix"])
                ids[(it["lemma"], it["pos"])].append(question_id(it["prefix"] + "___" + it["suffix"]))
    print(f"{len(lemma_pos)} vocabulary lemmas")
    usage, tokens = corpus_usage(set(lemma_pos))

    # ECDICT rows by exact spelling, falling back to a case-insensitive match ("American").
    rows: dict[str, dict] = {}
    folded: dict[str, dict] = {}
    with open(ECDICT_CSV, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            word = row["word"]
            rows.setdefault(word, row)
            folded.setdefault(word.lower(), row)

    def lookup(word: str) -> dict | None:
        return rows.get(word) or folded.get(word)

    def translation(row: dict) -> str:
        """The row's translation, or its base form's when it only says "burn的过去式".

        Comparatives keep their own ("best": 最好的, not good's 好的).
        """
        base = dict(p.split(":", 1) for p in row["exchange"].split("/") if ":" in p).get("0")
        if base and base != row["word"] and (base_row := lookup(base)):
            if not has_own_translation(row["translation"]):
                return base_row["translation"]
        return row["translation"]

    # Every (lemma, pos) with its candidate senses, Chinese gloss and similarity cache key.
    cc = OpenCC("s2tw")
    cache = load_sense_cache()
    entries: list[tuple[str, str, list, str, str]] = []
    pending = []
    for lemma, counts in sorted(lemma_pos.items()):
        row = lookup(lemma)
        for pos in counts:
            zh = chinese_gloss(translation(row), pos, cc) if row else ""
            candidates = wordnet_senses(lemma, pos)
            descriptions = [describe(ss, lemma) for ss, _ in candidates]
            key = sense_key(lemma, pos, sentences[(lemma, pos)], descriptions, zh)
            if candidates and key not in cache:
                pending.append((key, lemma, sentences[(lemma, pos)], descriptions, zh))
            entries.append((lemma, pos, candidates, zh, key))
    if pending:
        embed_senses(cache, pending)

    senses: dict[str, dict[str, list[str]]] = defaultdict(dict)
    variants: dict[str, dict[str, list[str]]] = defaultdict(dict)  # {lemma: {question id: [pos, en]}}
    matches = []  # (Chinese match, sentence match, lemma, pos, en, zh) of each chosen sense
    for lemma, pos, candidates, zh, key in entries:
        en = ""
        if candidates:
            sims = cache[key]["s"]
            bias = sense_bias(candidates)
            best = choose_sense(sims, bias)
            en = clause(candidates[best][0].definition())
            for qid, own in zip(ids[(lemma, pos)], sentence_senses(sims, bias, best)):
                if own != best:
                    variants[lemma][qid] = [pos, clause(candidates[own][0].definition())]
            if cache[key]["z"] is not None:
                fit = sum(row[best] for row in sims) / len(sims) if sims else 0.0
                matches.append((cache[key]["z"][best], fit, lemma, pos, en, zh))
        if en or zh:
            senses[lemma][pos] = [en, zh]

    glosses: dict[str, dict] = {}
    for lemma, counts in sorted(lemma_pos.items()):
        used = usage.get(lemma, Counter())
        own = senses[lemma]
        # The main sense is the part of speech the corpus uses most, among those with a gloss.
        main_pos = max(counts, key=lambda p: (p in own, used[p], counts[p]))
        en, zh = own.get(main_pos, ["", ""])
        glosses[lemma] = {
            "ipa": pronounce(lemma, pronunciations, lookup(lemma)),
            "pos": main_pos,
            "en": en,
            "zh": zh,
            "senses": own,
            "variants": variants[lemma],
            "usage": dict(used),
            "zipf": round(math.log10((sum(used.values()) + 0.5) / tokens) + 9, 2),
        }
    GLOSSES.write_text(json.dumps(glosses, ensure_ascii=False, indent=0), encoding="utf-8")

    # English and Chinese glosses that match each other worst: candidates for a manual check, where
    # WordNet may lack the sense the sentences use ("flooding" only has a behaviour-therapy sense).
    matches.sort()
    worst = matches[: math.ceil(len(matches) * REVIEW_SHARE)]
    REVIEW.write_text(
        "lemma\tpos\tzh_match\tsentence_match\ten\tzh\n"
        + "".join(f"{l}\t{p}\t{z:.3f}\t{s:.3f}\t{en}\t{zh}\n" for z, s, l, p, en, zh in worst),
        encoding="utf-8",
    )
    n = len(glosses)
    for field in ("ipa", "en", "zh"):
        have = sum(1 for g in glosses.values() if g[field])
        print(f"{field}: {have}/{n} ({have / n:.1%})")
    print(f"{len(worst)} English/Chinese pairs listed for review in {REVIEW.name}")
    print(f"wrote {GLOSSES}")


if __name__ == "__main__":
    main()
