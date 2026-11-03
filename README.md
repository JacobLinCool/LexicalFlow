# Lexical Flow

A minimalist vocabulary game that trains instant word choice. Sentences scroll past in a continuous
stream; each one is missing a word, and you pick it from four directional choices before the clock
runs out.

## Play

| Key       | Choice |
| --------- | ------ |
| `W` / `↑` | Up     |
| `A` / `←` | Left   |
| `S` / `↓` | Down   |
| `D` / `→` | Right  |

`M` toggles sound and `Esc` abandons the current run. Choices can also be tapped or clicked.

The stream opens on a mode menu, picked with the same directions:

| Direction | Mode     | Run                                                                    |
| --------- | -------- | ---------------------------------------------------------------------- |
| Up        | Quick    | 30 questions                                                           |
| Left      | Standard | 100 questions                                                          |
| Right     | Survival | Endless with 100 HP: a miss costs HP, a correct answer heals by speed |
| Down      | Practice | Endless, no stakes                                                     |

In Survival a correct answer heals a tenth of its score (up to 10 HP at full speed), while a wrong
answer or timeout costs 20 HP, rising by 5 every 25 questions so every run eventually ends. Finished
runs show a results line in the stream, and the best score per mode is kept.

- Every question has a strict ten-second window. The clock starts only after the sentence has scrolled
  into place and its choices are visible; feedback and scrolling never eat into it.
- The first direction pressed is final. Held keys and auto-repeat never answer a second question.
- Scoring: a correct answer within one second earns 100 points, then decays linearly to 0 at ten
  seconds (`100 × (10 − t) / 9`). Wrong answers and timeouts score 0. There are no combos.
- After three consecutive timeouts, or when the tab is hidden, the stream waits on the next sentence
  until you press a direction again. Questions themselves are never paused or replayed.

Progress (attempts, correct / incorrect / timed out, average response time, total score and per-word
results) is stored in `localStorage` and survives reloads.

## Word banks

`B` on the menu opens the word bank page (`/banks`):

- **Difficulty**: Easy, Medium, Hard or All. A question is as hard as its rarest choice, so Easy keeps
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

`P` on the menu opens `/profile`: totals, best runs, accuracy and points by topic (radar), accuracy
by word level, response-time distribution, daily activity, recent run trend, and the words that need
practice. It reads the same browser storage and can be reset there.

## Develop

```sh
pnpm install
pnpm dev        # local dev server
pnpm check      # svelte-check / TypeScript
pnpm test       # unit tests (scoring, deck shuffling, progress)
pnpm build      # static site in build/
```

The question bank under `static/data/` is generated offline; see [`pipeline/README.md`](pipeline/README.md).

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
