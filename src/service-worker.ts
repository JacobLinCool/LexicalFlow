/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { self } from '$app/service-worker';
import { assets, immutable, prerendered } from '$app/manifest';
import { version } from '$app/env';

// The app shell is cached up front; the question bank is cached as it is fetched,
// so a second visit works fully offline.
const SHELL = `shell-${version}`;
const DATA = 'data-v1';

const base = new URL(self.registration.scope).pathname;
// cache.addAll rejects duplicate entries, hence the Set.
const shell = [
	...new Set(
		[
			...immutable.map((f) => f.path),
			...assets.map((f) => f.path).filter((p) => !p.startsWith('data/') && !p.startsWith('.')),
			...prerendered.map((f) => f.path),
			''
		].map((p) => base + p.replace(/^\//, ''))
	)
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		Promise.all([caches.open(SHELL).then((cache) => cache.addAll(shell)), precacheBank()]).then(() =>
			self.skipWaiting()
		)
	);
});

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
				for (const old of await cache.keys(url, { ignoreSearch: true })) await cache.delete(old);
				await cache.add(url);
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
	if (url.origin !== self.location.origin) return;

	if (url.pathname.startsWith(`${base}data/`)) {
		event.respondWith(data(request, url));
		return;
	}
	if (shell.includes(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
	}
});

/** Bank files carry a version query: serve those cache-first. The manifest goes network-first. */
async function data(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(DATA);
	if (url.searchParams.has('v')) {
		const hit = await cache.match(request);
		if (hit) return hit;
		const res = await fetch(request);
		if (res.ok) {
			// Drop superseded versions of this file before storing the new one.
			for (const old of await cache.keys(request, { ignoreSearch: true })) await cache.delete(old);
			await cache.put(request, res.clone());
		}
		return res;
	}
	try {
		const res = await fetch(request);
		if (res.ok) await cache.put(request, res.clone());
		return res;
	} catch (error) {
		const hit = await cache.match(request, { ignoreSearch: true });
		if (hit) return hit;
		throw error;
	}
}
