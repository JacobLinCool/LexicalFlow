<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		BUILTIN_BANKS,
		CUSTOM_PREFIX,
		LEVELS,
		builtinBank,
		deleteCustomBank,
		inLevel,
		level,
		listCustomBanks,
		matchWords,
		myBands,
		saveCustomBank,
		type BandRange,
		type CustomBank,
		type LevelId
	} from '#lib/banks.ts';
	import Page from '#lib/components/Page.svelte';
	import { ImportError, importUrl, nameFromUrl, parseBank, toCustomBank, type ParsedBank } from '#lib/importer.ts';
	import { loadSettings, saveSettings } from '#lib/progress.ts';
	import Seo from '#lib/seo/Seo.svelte';
	import type { Lexicon, Question } from '#lib/types.ts';

	let selected = $state('all');
	let levelId = $state<LevelId>('medium');
	let builtin = $state.raw<Question[]>([]);
	let lexicon = $state.raw<Lexicon | null>(null);
	/** Bands 'My level' plays; null before the level test. */
	let mine = $state.raw<BandRange | null>(null);
	let custom = $state<CustomBank[]>([]);

	let url = $state('');
	let pasted = $state('');
	let busy = $state(false);
	let message = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	let copied = $state<string | null>(null);

	onMount(async () => {
		const settings = loadSettings();
		selected = settings.bank;
		levelId = settings.level;
		const [bank, banks, range] = await Promise.all([builtinBank(), listCustomBanks(), myBands().catch(() => null)]);
		[builtin, lexicon, custom, mine] = [bank.questions, bank.lexicon, banks, range];
	});

	function persist() {
		saveSettings({ ...loadSettings(), bank: selected, level: levelId });
	}

	function select(id: string) {
		selected = id;
		persist();
	}

	function setLevel(id: LevelId) {
		levelId = id;
		persist();
	}

	const levelObj = $derived(LEVELS.find((l) => l.id === levelId) ?? LEVELS[1]);
	/** 'My level' without a level test plays Medium, like resolvePlayable. */
	const effective = $derived(levelObj.frontier && !mine ? (LEVELS.find((l) => l.id === 'medium') ?? levelObj) : levelObj);
	function inRange(q: Question): boolean {
		if (!effective.frontier || !mine || !lexicon) return true;
		const band = lexicon.words.get(q.lemma)?.band;
		return band !== undefined && band >= mine.from && band <= mine.to;
	}
	function builtinCount(id: string): number {
		const count = (l: typeof effective, ranged: boolean) =>
			builtin.filter((q) => (id === 'all' || q.category === id) && inLevel(q, l) && (!ranged || inRange(q))).length;
		// Mirror resolvePlayable: 'My level' with nothing in its bands plays Medium, and an empty level plays All.
		const counted = count(effective, true) || (effective.frontier ? count(level('medium'), false) : 0);
		return counted || count(level('all'), false);
	}
	function levelDetail(l: (typeof LEVELS)[number]): string {
		if (!l.frontier) return l.detail;
		if (!mine || !lexicon) return 'After the level test';
		return `Words ${n((mine.from - 1) * lexicon.bandSize + 1)}–${n(mine.to * lexicon.bandSize)}`;
	}
	function customCount(bank: CustomBank): string {
		if (bank.kind === 'questions') return `${n(bank.questions.length)} questions`;
		const matched = builtin.length ? matchWords(builtin, bank.words).length : 0;
		return `${n(bank.words.length)} words · ${n(matched)} matching questions`;
	}
	const n = (v: number) => v.toLocaleString('en-US');

	function summary(parsed: ParsedBank, bank: CustomBank): string {
		const size =
			bank.kind === 'questions'
				? `${n(bank.questions.length)} questions`
				: `${n(bank.words.length)} words (${n(matchWords(builtin, bank.words).length)} matching questions)`;
		const skipped = parsed.skipped ? ` Skipped ${parsed.skipped}: ${parsed.problems.join('; ')}` : '';
		return `Imported “${bank.name}”: ${size}.${skipped}`;
	}

	async function finish(work: () => Promise<{ bank: CustomBank; parsed: ParsedBank }>) {
		busy = true;
		message = null;
		try {
			const { bank, parsed } = await work();
			if (bank.kind === 'words' && !matchWords(builtin, bank.words).length) {
				message = { tone: 'error', text: 'None of these words appear in the built-in bank, so there is nothing to play yet. Import sentences with the CSV or JSON question format instead.' };
			} else {
				message = { tone: 'ok', text: summary(parsed, bank) };
				select(CUSTOM_PREFIX + bank.id);
			}
			custom = await listCustomBanks();
		} catch (error) {
			message = { tone: 'error', text: error instanceof ImportError ? error.message : `Import failed: ${(error as Error).message}` };
		} finally {
			busy = false;
		}
	}

	function fromUrl(e: SubmitEvent) {
		e.preventDefault();
		if (!url.trim()) return;
		finish(async () => {
			const result = await importUrl(url, custom);
			url = '';
			return result;
		});
	}

	function fromFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		finish(async () => {
			const parsed = parseBank(await file.text(), file.name);
			const bank = toCustomBank(parsed, { type: 'file', name: file.name }, file.name.replace(/\.[^.]+$/, ''));
			await saveCustomBank(bank);
			return { bank, parsed };
		});
	}

	function fromPaste(e: SubmitEvent) {
		e.preventDefault();
		if (!pasted.trim()) return;
		finish(async () => {
			const parsed = parseBank(pasted);
			const bank = toCustomBank(parsed, { type: 'paste' }, `Pasted bank ${new Date().toLocaleDateString('en-US')}`);
			await saveCustomBank(bank);
			pasted = '';
			return { bank, parsed };
		});
	}

	function refresh(bank: CustomBank) {
		if (bank.source.type !== 'url') return;
		const source = bank.source.url;
		finish(() => importUrl(source, custom));
	}

	async function remove(bank: CustomBank) {
		await deleteCustomBank(bank.id);
		if (selected === CUSTOM_PREFIX + bank.id) select('all');
		custom = await listCustomBanks();
	}

	async function share(bank: CustomBank) {
		if (bank.source.type !== 'url') return;
		const link = new URL(resolve('/'), location.href);
		link.searchParams.set('bank', bank.source.url);
		try {
			await navigator.clipboard.writeText(link.toString());
			copied = bank.id;
			setTimeout(() => (copied = null), 1600);
		} catch {
			prompt('Copy this link:', link.toString());
		}
	}

	function sourceLabel(bank: CustomBank): string {
		if (bank.source.type === 'url') return nameFromUrl(bank.source.url) === bank.name ? new URL(bank.source.url).hostname : bank.source.url;
		if (bank.source.type === 'file') return bank.source.name;
		return 'Pasted';
	}

	const csvExample = `sentence,answer,distractor1,distractor2,distractor3
The results ___ that the method is effective.,suggest,declare,prevent,achieve
Could you ___ me the way to the station?,show,say,speak,talk`;
	const jsonExample = `{
  "name": "My bank",
  "questions": [
    {
      "sentence": "The results ___ that the method is effective.",
      "answer": "suggest",
      "distractors": ["declare", "prevent", "achieve"]
    }
  ]
}`;
	const wordsExample = `word
itinerary
negotiate
hypothesis`;
</script>

<Seo title="Word banks" path="/banks" description="Choose a difficulty or import your own word bank from a CSV or JSON link." />

<Page title="Word bank." lead="Choose what flows past. Your choice is remembered in this browser.">
	<section>
		<h2>Difficulty</h2>
		<div class="levels" role="radiogroup" aria-label="Difficulty">
			{#each LEVELS as l (l.id)}
				<button type="button" role="radio" aria-checked={levelId === l.id} class:on={levelId === l.id} onclick={() => setLevel(l.id)}>
					<strong>{l.label}</strong>
					<small>{levelDetail(l)}</small>
				</button>
			{/each}
		</div>
		<p class="note">
			A question is as hard as its rarest choice. Difficulty applies to the built-in topics. My level plays words around
			where your new words come from: two frequency bands below to one above{#if !mine}; it needs the
				<a href="{resolve('/')}?start=placement">level test</a> and plays Medium until then{/if}.
		</p>
	</section>

	<section>
		<h2>Built-in topics</h2>
		<ul class="rows" role="radiogroup" aria-label="Built-in topics">
			{#each BUILTIN_BANKS as b (b.id)}
				<li>
					<button type="button" role="radio" aria-checked={selected === b.id} class="row" class:on={selected === b.id} onclick={() => select(b.id)}>
						<span class="name">{b.label}</span>
						<span class="meta">{builtin.length ? `${n(builtinCount(b.id))} questions` : '…'}</span>
					</button>
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>Your banks</h2>
		{#if custom.length}
			<ul class="rows">
				{#each custom as bank (bank.id)}
					{@const id = CUSTOM_PREFIX + bank.id}
					<li class="custom">
						<button type="button" role="radio" aria-checked={selected === id} class="row" class:on={selected === id} onclick={() => select(id)}>
							<span class="name">{bank.name}</span>
							<span class="meta">{customCount(bank)} · {sourceLabel(bank)}</span>
						</button>
						<span class="actions">
							{#if bank.source.type === 'url'}
								<button type="button" onclick={() => refresh(bank)} disabled={busy}>Refresh</button>
								<button type="button" onclick={() => share(bank)}>{copied === bank.id ? 'Copied' : 'Copy link'}</button>
							{/if}
							<button type="button" onclick={() => remove(bank)}>Delete</button>
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="note">Nothing imported yet.</p>
		{/if}
	</section>

	<section>
		<h2>Import</h2>
		<form class="field" onsubmit={fromUrl}>
			<label for="bank-url">From a link</label>
			<div class="inline">
				<input id="bank-url" type="url" placeholder="https://raw.githubusercontent.com/…/bank.csv" bind:value={url} required />
				<button type="submit" class="primary" disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
			</div>
			<p class="note">
				The file must allow cross-origin requests. Raw GitHub files and Gists work, and GitHub page links are converted
				automatically; so do Google Sheets shared as “anyone with the link” (the sheet link is turned into its CSV export).
				Link banks can be refreshed and shared.
			</p>
		</form>

		<div class="field">
			<label for="bank-file">From a file</label>
			<input id="bank-file" type="file" accept=".csv,.tsv,.json,.txt,text/csv,application/json,text/plain" onchange={fromFile} disabled={busy} />
		</div>

		<form class="field" onsubmit={fromPaste}>
			<label for="bank-paste">Paste</label>
			<textarea id="bank-paste" rows="5" placeholder={csvExample} bind:value={pasted}></textarea>
			<div><button type="submit" disabled={busy || !pasted.trim()}>Import pasted text</button></div>
		</form>

		{#if message}
			<p class={['message', message.tone]} role="status">{message.text}</p>
		{/if}
	</section>

	<section>
		<h2>Formats</h2>
		<div class="formats">
			<div>
				<h3>Questions as CSV</h3>
				<p>One sentence per row with <code>___</code> where the word goes (or the answer written in place). Optional <code>category</code> and <code>difficulty</code> (1–5) columns.</p>
				<pre>{csvExample}</pre>
			</div>
			<div>
				<h3>Questions as JSON</h3>
				<p>
					An array, or an object with <code>name</code> and <code>questions</code>. Each question takes <code>answer</code> plus
					three <code>distractors</code>, or the game's own <code>choices</code> / <code>answer</code> shape.
				</p>
				<pre>{jsonExample}</pre>
			</div>
			<div>
				<h3>A word list</h3>
				<p>One word per line, a <code>word</code> column, or a JSON array of strings. The game plays the built-in sentences for those words.</p>
				<pre>{wordsExample}</pre>
			</div>
		</div>
		<p class="note">
			To share a bank, send a link of the form <code>{new URL(resolve('/'), 'https://example.com').pathname}?bank=&lt;file URL&gt;</code>; opening it imports and selects the bank.
		</p>
	</section>

	<div class="play">
		<button type="button" class="primary" onclick={() => goto(resolve('/'))}>Play this bank →</button>
	</div>
</Page>

<style>
	.note {
		margin: 0.6rem 0 0;
		font-size: 0.8rem;
		color: var(--text-muted);
		line-height: 1.5;
	}

	.note a {
		color: var(--text-secondary);
	}

	.note a:hover {
		color: var(--ink);
	}

	button {
		font: inherit;
		color: var(--ink);
		cursor: pointer;
	}

	button:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.levels {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.6rem;
	}

	.levels button,
	.row {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.8rem 1rem;
		border-radius: 1rem;
		text-align: left;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
	}

	.levels button:hover,
	.row:hover {
		background: var(--surface-hover);
	}

	.levels button.on,
	.row.on {
		background: var(--surface-strong);
		box-shadow: inset 0 0 0 1.5px var(--ink);
	}

	.levels small {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.rows {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		width: 100%;
		flex-direction: row;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.name {
		font-size: 1.15rem;
		font-weight: 650;
	}

	.meta {
		font-size: 0.82rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
		text-align: right;
		overflow-wrap: anywhere;
	}

	.custom {
		display: grid;
		gap: 0.35rem;
	}

	.actions {
		display: flex;
		gap: 1rem;
		padding-left: 1rem;
	}

	.actions button {
		padding: 0;
		background: none;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.actions button:hover {
		color: var(--ink);
	}

	.field {
		display: grid;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	label {
		font-size: 0.9rem;
		font-weight: 600;
	}

	.inline {
		display: flex;
		gap: 0.5rem;
	}

	input[type='url'],
	textarea {
		flex: 1;
		min-width: 0;
		padding: 0.7rem 0.9rem;
		border: 0;
		border-radius: 0.8rem;
		font: inherit;
		font-size: 0.9rem;
		color: var(--ink);
		background: rgb(0 0 0 / 0.25);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	textarea {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.8rem;
		resize: vertical;
	}

	input:focus-visible,
	textarea:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--series-1);
		outline-offset: 2px;
	}

	input[type='file'] {
		font: inherit;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.field button,
	.play button {
		padding: 0.7rem 1.1rem;
		border-radius: 0.8rem;
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--hairline);
		font-weight: 600;
	}

	button.primary {
		background: var(--ink);
		color: var(--bg);
		box-shadow: none;
	}

	.message {
		margin: 0;
		padding: 0.8rem 1rem;
		border-radius: 0.8rem;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.message.ok {
		background: var(--positive-surface);
	}

	.message.error {
		background: var(--negative-surface);
	}

	.formats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
		gap: 1.5rem;
	}

	h3 {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
	}

	.formats p {
		margin: 0 0 0.6rem;
		font-size: 0.82rem;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	pre {
		margin: 0;
		padding: 0.8rem;
		border-radius: 0.8rem;
		overflow-x: auto;
		font-size: 0.72rem;
		background: rgb(0 0 0 / 0.25);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	code {
		font-size: 0.9em;
	}

	.play {
		margin-top: 3rem;
	}
</style>
