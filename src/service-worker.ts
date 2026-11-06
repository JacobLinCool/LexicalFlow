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
//   the cache answers when the network fails or is too slow (see patience()).
// - The question bank: versioned band files cache-first, the manifest network-first in the
//   same way. A new manifest only replaces the cached one once all its bands are cached, so
//   an interrupted update never leaves the offline bank half old, half new (see promote()).
// Pages and the manifest are fetched past the browser's HTTP cache, because GitHub Pages lets
// them sit in it for ten minutes and a stale page would point at chunks that no longer exist.
// Band files are immutable per version, so they may come from the HTTP cache.
const SHELL = `shell-${version}`;
// v2: the bank moved to frequency bands; activate drops the old cache with its topic files.
const DATA = 'data-v2';

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

const MANIFEST = `${base}data/manifest.json`;
/** A newer manifest whose band files are still being cached; see promote(). */
const PENDING = `${MANIFEST}?pending`;

interface Manifest {
	version: string;
	bands?: { file: string }[];
}

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
 * as well; otherwise the game would only work offline from the second visit on. The band
 * requests may be answered by the HTTP cache the page just filled, so the bank is not
 * downloaded twice.
 */
async function precacheBank(): Promise<void> {
	try {
		const res = await fetch(MANIFEST, { cache: 'no-cache' });
		if (res.ok) await update(res);
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
		if (url.searchParams.has('v')) event.respondWith(band(url.pathname + url.search));
		else if (url.pathname === MANIFEST) event.respondWith(manifest(event));
	} else if (hashed.has(url.pathname)) {
		event.respondWith(cacheFirst(request));
	} else if (request.mode === 'navigate' || shell.includes(url.pathname)) {
		event.respondWith(networkFirst(event, url));
	}
});

/** When the network last kept a request waiting past patience(). */
let stalledAt = -Infinity;

/**
 * How long a page or the manifest waits for the network before the cached copy is served: a
 * connection that is up but never answers (a captive portal, a train's Wi-Fi) would otherwise
 * keep the installed app from opening at all. Shorter on a link the browser reports as slow,
 * and right after a stall, so the page's own requests do not each wait in turn.
 */
function patience(): number {
	if (Date.now() - stalledAt < 30_000) return 500;
	const link = (self.navigator as WorkerNavigator & { connection?: { effectiveType?: string; saveData?: boolean } })
		.connection;
	return link?.saveData || /2g|3g/.test(link?.effectiveType ?? '') ? 1500 : 3000;
}

/**
 * The network's answer, or `fallback` when the network fails or takes longer than patience().
 * The request keeps going after a timeout (the event stays alive for it) so it can still
 * refresh the cache through `network`'s own handlers.
 */
function race(event: FetchEvent, network: Promise<Response>, fallback: Response): Promise<Response> {
	event.waitUntil(network.catch(() => undefined));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<Response>((resolve) => {
		timer = setTimeout(() => {
			stalledAt = Date.now();
			resolve(fallback);
		}, patience());
	});
	const answered = network.then(
		(res) => {
			stalledAt = -Infinity;
			return res;
		},
		() => fallback
	);
	return Promise.race([answered, late]).finally(() => clearTimeout(timer));
}

async function cacheFirst(request: Request): Promise<Response> {
	const hit = await caches.match(request);
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok) (await caches.open(SHELL)).put(request, res.clone());
	return res;
}

/** Fresh from the network (revalidated past the HTTP cache); the cached copy when offline or slow. */
async function networkFirst(event: FetchEvent, url: URL): Promise<Response> {
	const request = event.request;
	const cache = await caches.open(SHELL);
	// Pages are cached by path: ?bank=… links and the like share the page's entry.
	const key = url.pathname;
	const network = fetch(request.mode === 'navigate' ? url.href : request, { cache: 'no-cache' }).then(async (res) => {
		if (res.ok && shell.includes(key)) await cache.put(key, res.clone());
		return res;
	});
	const hit = (await cache.match(key)) ?? (request.mode === 'navigate' ? await cache.match(base) : undefined);
	return hit ? race(event, network, hit) : network;
}

/**
 * The manifest, network-first like a page. A fetched manifest is staged (see update()) and
 * returned, so the page loads that version's bands; when the network is down or slow, the
 * page gets the newest manifest whose bands are all cached.
 */
async function manifest(event: FetchEvent): Promise<Response> {
	const cache = await caches.open(DATA);
	const network = fetch(MANIFEST, { cache: 'no-cache' }).then((res) => {
		if (res.ok) event.waitUntil(update(res.clone()).catch(() => undefined));
		return res;
	});
	const current = await cache.match(MANIFEST);
	return current ? race(event, network, current) : network;
}

/** One network fetch per band URL at a time, shared by the page and update(). */
const inflight = new Map<string, Promise<number>>();

/** A versioned band file: from the cache, or fetched once and cached (see promote()). */
async function band(url: string): Promise<Response> {
	const cache = await caches.open(DATA);
	const hit = await cache.match(url);
	if (hit) return hit;
	let job = inflight.get(url);
	if (!job) {
		job = (async () => {
			const res = await fetch(url);
			if (!res.ok) return res.status;
			await cache.put(url, res);
			await promote(cache);
			return 200;
		})().finally(() => inflight.delete(url));
		inflight.set(url, job);
	}
	const status = await job;
	return (status === 200 && (await cache.match(url))) || new Response(null, { status });
}

/** Stage a fetched manifest and cache its bands; the last band to arrive promotes it. */
async function update(res: Response): Promise<void> {
	const cache = await caches.open(DATA);
	const manifest = (await res.clone().json()) as Manifest;
	await cache.put(PENDING, res);
	await promote(cache);
	await Promise.allSettled(bandUrls(manifest).map(band));
}

function bandUrls(manifest: Manifest): string[] {
	const v = encodeURIComponent(manifest.version);
	return (manifest.bands ?? []).map(({ file }) => `${base}data/${file}?v=${v}`);
}

/**
 * Make the pending manifest the cached one once every band it lists is cached, then drop band
 * files of other versions. Until then the previous manifest and its bands stay complete.
 */
async function promote(cache: Cache): Promise<void> {
	const pending = await cache.match(PENDING);
	if (!pending) return;
	const urls = bandUrls((await pending.clone().json()) as Manifest);
	for (const url of urls) if (!(await cache.match(url))) return;
	await cache.put(MANIFEST, pending);
	await cache.delete(PENDING);
	const keep = new Set(urls);
	for (const request of await cache.keys()) {
		const url = new URL(request.url);
		if (url.searchParams.has('v') && !keep.has(url.pathname + url.search)) await cache.delete(request);
	}
}
