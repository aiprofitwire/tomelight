// Renders build/icon.svg to PNG. Needs Playwright: npx playwright install chromium, then node build/render-icon.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
const svg = fs.readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: new URL('./icon-1024.png', import.meta.url).pathname, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
