# Lexical Flow

A minimalist, lyrics-style vocabulary game that trains instant word choice. Sentences scroll past like
synced lyrics; each one is missing a word, and you pick it from four directional choices before the
clock runs out.

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

- Every question has a strict five-second window. The clock starts only after the sentence has scrolled
  into place and its choices are visible; feedback and scrolling never eat into it.
- The first direction pressed is final. Held keys and auto-repeat never answer a second question.
- Scoring: a correct answer within one second earns 100 points, then decays linearly to 0 at five
  seconds (`25 × (5 − t)`). Wrong answers and timeouts score 0. There are no combos.
- After three consecutive timeouts, or when the tab is hidden, the stream waits on the next sentence
  until you press a direction again. Questions themselves are never paused or replayed.

Progress (attempts, correct / incorrect / timed out, average response time, total score and per-word
results) is stored in `localStorage` and survives reloads.

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
repository settings, set **Pages → Source** to **GitHub Actions**. The workflow sets `BASE_PATH` to
`/<repo>` (or the root for a `<user>.github.io` repository); to build for a sub-path locally, run
`BASE_PATH=/LexicalFlow pnpm build`.

A service worker caches the app shell on first load and the question bank as it is fetched, so the
game keeps working offline afterwards.
