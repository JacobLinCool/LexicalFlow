import { asset } from '$app/paths';
import type { AssetPath } from '$app/types';
import type { Manifest, Question } from './types';

function url(path: string): string {
	return asset(`/data/${path}` as AssetPath);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url(path), init);
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** Load every category of the bundled question bank. */
export async function loadQuestions(): Promise<Question[]> {
	// The manifest is revalidated; bank files are versioned by it and safe to cache forever.
	const manifest = await json<Manifest>('manifest.json', { cache: 'no-cache' });
	const v = encodeURIComponent(manifest.version);
	const banks = await Promise.all(
		Object.values(manifest.categories).map(({ file }) => json<Question[]>(`${file}?v=${v}`))
	);
	return banks.flat();
}
