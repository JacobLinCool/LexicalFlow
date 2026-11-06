# Lexical Flow

A minimalist vocabulary game that trains instant word choice. Sentences scroll past in a continuous
stream; each one is missing a word, and you pick it from four directional choices before the clock
runs out. A daily course estimates your vocabulary, plans new words towards a goal and brings each
word back just before you would forget it.

## Play

| Key       | Choice |
| --------- | ------ |
| `W` / `↑` | Up     |
| `A` / `←` | Left   |
| `S` / `↓` | Down   |
| `D` / `→` | Right  |

`M` toggles sound (spoken words included), and `Esc` or the **Quit** button leaves the current run.
On the menu, `Space` starts the demo, an autoplay that also starts after 30 seconds idle; any key or
tap ends it, and nothing it plays is recorded. Choices can also be tapped or clicked. On the menu,
`L` opens the plan page, `B` the word banks and `P` the profile.

The stream opens on a mode menu, picked with the same directions:

| Direction | Mode     | Run                                                                   |
| --------- | -------- | --------------------------------------------------------------------- |
| Up        | Learn    | Today's new words and reviews (see [Learning](#learning)), unscored   |
| Left      | Quick    | 30 questions                                                          |
| Right     | Survival | Endless with 100 HP: a miss costs HP, a correct answer heals by speed |
| Down      | Standard | 100 questions                                                         |

In Survival a correct answer heals a tenth of its score (up to 10 HP at full speed), while a wrong
answer or timeout costs 20 HP, rising by 5 every 25 questions so every run eventually ends. Finished
runs show a results line in the stream, and the best score per mode is kept. Answers in the scored
modes also count towards the course, as weaker evidence than Learn answers: a word you already study
gets a review, and a new word you answer correctly joins the course when it comes from a band you
probably know. Answers from your own banks review words but never move the estimate.

- Each sentence first gets reading time at a native speaker's pace (300 words per minute, so 200 ms
  per word, the blank included); its choices appear only then.
- Every question has a strict eight-second window. The clock starts when the choices appear; reading,
  feedback and scrolling never eat into it.
- The first direction pressed is final. Held keys and auto-repeat never answer a second question.
- Scoring: a correct answer within one second earns 100 points, then decays linearly to 0 at eight
  seconds (`100 × (8 − t) / 7`). Wrong answers and timeouts score 0. There are no combos.
- After three consecutive timeouts the stream waits on the next sentence until you press a direction
  again. If the tab is hidden or loses focus while a question is on screen, nothing is recorded: the
  question is asked again with a fresh clock when you return.

### Levels

Every answer earns experience (XP), shown with your level in the bottom bar. Learn and the level test
give 10 XP for a right answer and 2 for a miss (meeting a word is part of learning it); the scored
modes give a tenth of an answer's points. A word reaching mastered adds 20 XP, and finishing the
day's Learn plan adds 50 once a day. Going from level L to the next takes 100 × L XP, so the first
day of study reaches about level 5 and a month of daily study about level 30. Saves from before
levels existed start with a tenth of their all-time score. The profile shows the level, total XP,
today's XP and the day streak.

Progress (attempts, correct / incorrect / timed out, average response time, total score and per-word
results) is stored in `localStorage` and survives reloads. Learn and the level test add to the
answer counts but not to the score. Several open tabs share it without overwriting each other.

## Learning

Learn mode is a long-term course over the built-in bank. Words are ranked by how often they appear
in English, so the most useful ones come first.

- **Level test.** Choosing Learn for the first time offers a short adaptive test (or skip it and
  start with the most common words). It opens with a sweep across the frequency bands, then asks
  where the answer is least certain, and stops after 20 to 40 items once the estimate is precise
  enough. The result is an estimated vocabulary size with a range (a 90% credible interval) and a
  frontier: the first band you do not yet know well. Every later answer keeps refining the
  estimate, and Learn now and then asks a word from a rarer band to keep it honest.
- **Daily plan.** Pick a vocabulary goal and a length (14 to 90 days); after the level test the
  suggested goal is about 1,000 words above your estimate over 60 days. The plan works out the words
  to introduce each day, how many of them are probably new to you, a rough minutes-per-day estimate
  with reviews included, and a finish date. It is honest about pace: introductions are capped at 150
  a day, a goal that would need an intensive or unrealistic pace says so, and a saved goal shows
  whether you are on track or behind. The day's quota is fixed in the morning, so it does not shift
  while you study.
- **Spaced retrieval.** Each word you meet gets an FSRS-5 card (90% target retention, intervals up
  to a year). A miss or timeout grades Again; a correct answer grades Easy, Good or Hard by response
  time. The cut-offs start at 1.8 s and 5 s and are then calibrated to you, from your times on words
  you surely know. Reviews fall due by calendar day, so a day's load stays even. A session mixes due
  reviews with new words from the frontier, brings a missed word back a few items later (in a new
  sentence when there is one), and holds new words back while review accuracy is low.
- **Glosses.** After an answer in Learn (and after a miss elsewhere) the word's meaning appears:
  Traditional Chinese first, then IPA and a short English definition. A word used as more than one
  part of speech is glossed with the sense the sentence uses.
- **Study pause.** On a missed or unfamiliar word, Learn holds the gloss for the time it takes to
  read it; any key moves on.
- **Settings** (on the plan page): which meanings to show (English, Chinese or both; browsers set
  to Chinese show both by default, others English), saying the word aloud in Learn (while sound is
  on), and the study pause.

`L` on the menu opens the plan page (`/plan`): the estimate, mastered and learning counts, the
frontier, the goal, coverage by frequency band, reviews due over the next two weeks, and the
settings. The word bank page adds a **My level** difficulty that plays the bands around your
frontier once you have taken the level test.

The course is stored in `localStorage` under `lexical-flow:learn:v1`: one card per word met,
first-answer evidence per band, the level test result, the plan, daily tallies and a review log of
the last 5,000 answers.

## Word banks

`B` on the menu opens the word bank page (`/banks`):

- **Difficulty**: Easy, Medium, Hard, All or My level. A question is as hard as its rarest choice, so Easy keeps
  every option to everyday words.
- **Topics**: all, conversation, travel, networking or academic.
- **Your own banks**, imported from a link, a file or pasted text, and stored in IndexedDB:
  - Questions as CSV: `sentence,answer,distractor1,distractor2,distractor3` (plus optional `category`,
    `difficulty`), with `___` marking the blank.
  - Questions as JSON: an array (or `{ "name", "questions" }`) of `{ sentence, answer, distractors }`
    or the game's own `{ sentence, choices, answer }` shape.
  - A word list (one per line, a `word` column, or a JSON array of strings), which plays the built-in
    sentences for those words.

  Links must allow cross-origin requests; GitHub page links and Google Sheets links are converted to
  their raw/CSV forms automatically. Sharing `https://<site>/?bank=<file URL>` imports and selects the
  bank for whoever opens it.

## Profile

`P` on the menu opens `/profile`: level, XP and day streak, estimated vocabulary with mastered, learning and due counts, totals, best runs, accuracy and points by topic (radar), accuracy
by word level, response-time distribution, daily activity, recent run trend, and the words that need
practice. It reads the same browser storage and can be reset there.

## Develop

```sh
pnpm install
pnpm dev        # local dev server
pnpm check      # svelte-check / TypeScript
pnpm test       # unit tests (scoring, decks, imports, scheduling, estimates, data)
pnpm build      # static site in build/
```

The question bank under `static/data/` is generated offline; see [`pipeline/README.md`](pipeline/README.md).
It holds 17,493 words in 18 frequency bands of 1,000 words each, with 67,953 questions (about 10 MB,
4 MB gzipped). `manifest.json` lists the counts per band; each `bands/NN.json` holds that band's
words with their glosses and questions. Data licences are in [`DATA_LICENSES.md`](DATA_LICENSES.md).

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`. In the
repository settings, set **Pages → Source** to **GitHub Actions**. The workflow reads the site's
address from `actions/configure-pages` and passes it to the build as `BASE_PATH` (e.g. `/LexicalFlow`)
and `SITE_URL` (e.g. `https://jacoblincool.github.io/LexicalFlow`); both follow a custom domain
automatically. To build for a sub-path locally:

```sh
BASE_PATH=/LexicalFlow SITE_URL=https://jacoblincool.github.io/LexicalFlow pnpm build
```

`SITE_URL` is used for canonical links, Open Graph and Twitter cards, `sitemap.xml` and the
`Sitemap:` line in `robots.txt`. Without it the site still works; those absolute URLs are simply
left out.

A service worker caches the app shell on first load and the question bank as it is fetched, so the
game keeps working offline afterwards.

The share image (`static/og.png`) and app icons are rendered from `scripts/og/`:

```sh
npm i --no-save playwright && npx playwright install chromium && node scripts/og/render.mjs
```
