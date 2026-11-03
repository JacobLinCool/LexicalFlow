// Renders the share image and app icons into static/.
// Usage: npm i --no-save playwright && npx playwright install chromium && node scripts/og/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'static');
const file = (name) => `file://${join(here, name)}`;

const browser = await chromium.launch();

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await og.goto(file('og.html'));
await og.evaluate(() => document.fonts.ready);
await og.screenshot({ path: join(out, 'og.png') });

const icons = [
	['icon.svg', 'icon-192.png', 192, true],
	['icon.svg', 'icon-512.png', 512, true],
	['icon-maskable.svg', 'icon-maskable-512.png', 512, false],
	['icon-maskable.svg', 'apple-touch-icon.png', 180, false]
];
for (const [src, name, size, transparent] of icons) {
	const page = await browser.newPage({ viewport: { width: size, height: size } });
	// A bare SVG document with only a viewBox scales to fill the viewport.
	await page.goto(file(src));
	await page.screenshot({ path: join(out, name), omitBackground: transparent });
}

await browser.close();
console.log('wrote og.png and icons to', out);
