/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { self } from '$app/service-worker';
import { assets, immutable, prerendered } from '$app/manifest';
import { version } from '$app/env';

// Strategy:
// - _app/immutable/* is content-hashed: cache-first.
// - Pages and other static files: network-first, so a deploy is picked up on the next load;
//   the cache is only the offline fallback.
// - The question bank: versioned files cache-first, the manifest network-first (see data()).
// Everything is fetched past the browser's HTTP cache when stored, because GitHub Pages lets
// HTML sit in it for ten minutes and a stale page would point at chunks that no longer exist.
const SHELL = `shell-${version}`;
const DATA = 'data-v1';

const base = new URL(self.registration.scope).pathname;
const local = (p: string) => base + p.replace(/^\//, '');
const hashed = new Set(immutable.map((f) => local(f.path)));
const pages = new Set(prerendered.map((f) => local(f.path)).concat(base));
const shell = [
	...new Set([
		...hashed,
		...pages,
		...assets.map((f) => f.path).filter((p) => !p.startsWith('data/') && !p.startsWith('.')).map(local)
	])
];

self.addEventListener('install', (event) => {
	event.waitUntil(Promise.all([precacheShell(), precacheBank()]).then(() => self.skipWaiting()));
});

/** Cache each file on its own, so one failed request cannot block the whole install. */
async function precacheShell(): Promise<void> {
	const cache = await caches.open(SHELL);
	await Promise.allSettled(
		shell.map(async (path) => {
			const res = await fetch(path, { cache: hashed.has(path) ? 'default' : 'reload' });
			if (res.ok) await cache.put(path, res);
		})
	);
}

/**
 * The first visit fetches the bank before this worker controls the page, so cache it here
 * as well; otherwise the game would only work offline from the second visit on.
 */
async function precacheBank(): Promise<void> {
	try {
		const manifestUrl = `${base}data/manifest.json`;
		const res = await fetch(manifestUrl, { cache: 'no-cache' });
		if (!res.ok) return;
		const manifest = (await res.clone().json()) as {
			version: string;
			categories: Record<string, { file: string }>;
		};
		const cache = await caches.open(DATA);
		await cache.put(manifestUrl, res);
		const v = encodeURIComponent(manifest.version);
		await Promise.all(
			Object.values(manifest.categories).map(async ({ file }) => {
				const url = `${base}data/${file}?v=${v}`;
				if (await cache.match(url)) return;
				const fresh = await fetch(url, { cache: 'reload' });
				if (!fresh.ok) return;
				for (const old of await cache.keys(url, { ignoreSearch: true })) await cache.delete(old);
				await cache.put(url, fresh);
			})
		);
	} catch {
		// Offline during install: the bank is cached on its next fetch instead.
	}
}

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(base)) return;

	if (url.pathname.startsWith(`${base}data/`)) {
		event.respondWith(data(request, url));
	} else if (hashed.has(url.pathname)) {
		event.respondWith(cacheFirst(request));
	} else if (request.mode === 'navigate' || shell.includes(url.pathname)) {
		event.respondWith(networkFirst(request, url));
	}
});

async function cacheFirst(request: Request): Promise<Response> {
	const hit = await caches.match(request);
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok) (await caches.open(SHELL)).put(request, res.clone());
	return res;
}

/** Fresh from the network (revalidated past the HTTP cache); the cached copy only when offline. */
async function networkFirst(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(SHELL);
	// Pages are cached by path: ?bank=… links and the like share the page's entry.
	const key = url.pathname;
	try {
		const res = await fetch(request.mode === 'navigate' ? url.href : request, { cache: 'no-cache' });
		if (res.ok && shell.includes(key)) await cache.put(key, res.clone());
		return res;
	} catch (error) {
		const hit = (await cache.match(key)) ?? (request.mode === 'navigate' ? await cache.match(base) : undefined);
		if (hit) return hit;
		throw error;
	}
}

/** Bank files carry a version query: serve those cache-first. The manifest goes network-first. */
async function data(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(DATA);
	if (url.searchParams.has('v')) {
		const hit = await cache.match(request);
		if (hit) return hit;
		const res = await fetch(request, { cache: 'reload' });
		if (res.ok) {
			// Drop superseded versions of this file before storing the new one.
			for (const old of await cache.keys(request, { ignoreSearch: true })) await cache.delete(old);
			await cache.put(request, res.clone());
		}
		return res;
	}
	try {
		const res = await fetch(request, { cache: 'no-cache' });
		if (res.ok) await cache.put(request, res.clone());
		return res;
	} catch (error) {
		const hit = await cache.match(request, { ignoreSearch: true });
		if (hit) return hit;
		throw error;
	}
}
