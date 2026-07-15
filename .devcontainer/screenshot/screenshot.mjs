#!/usr/bin/env node
// This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
// Source of truth lives in PhantomWP infrastructure generators.

// PhantomWP screenshot helper. Generated from lib/infrastructure-files.ts.
// Do not edit by hand -- changes will be overwritten on infrastructure update.

import { resolve, join, dirname } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
function getArg(name, def) {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

function clampDimension(raw, min, max) {
    const n = Number.parseInt(String(raw || ''), 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
}

const targetPath = getArg('path', '/');
const viewportName = getArg('viewport', 'desktop');
const port = getArg('port', '4321');
const format = getArg('format', 'jpeg');
const fullPage = args.includes('--full-page');
// Selector is passed base64-encoded so CSS combinators (~, >, +) don't
// collide with the codespace exec policy or shell metacharacters.
const selectorB64 = getArg('selector-b64', '');
let selector = '';
if (selectorB64) {
    try { selector = Buffer.from(selectorB64, 'base64').toString('utf8'); }
    catch { selector = ''; }
}
const selectorPaddingRaw = getArg('selector-padding', '16');
const selectorPadding = Math.max(0, Math.min(200, Number.parseInt(selectorPaddingRaw, 10) || 0));

const VIEWPORTS = {
    mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
const baseViewport = VIEWPORTS[viewportName] || VIEWPORTS.desktop;
const widthOverride = clampDimension(getArg('width', ''), 320, 3840);
const heightOverride = clampDimension(getArg('height', ''), 480, 3000);
const viewport = {
    ...baseViewport,
    width: widthOverride || baseViewport.width,
    height: heightOverride || baseViewport.height,
};

// The model rejects images over 8000px on either edge or ~5MB decoded, and
// an oversized screenshot persisted into chat history breaks every
// subsequent request. Captures land in DEVICE pixels (CSS px *
// deviceScaleFactor), so the CSS-px clamp depends on the viewport.
const MAX_CAPTURE_EDGE_DEVICE_PX = 7500;
const MAX_IMAGE_BYTES = Math.floor(4.5 * 1024 * 1024);
const maxCaptureEdgeCssPx = Math.floor(MAX_CAPTURE_EDGE_DEVICE_PX / (viewport.deviceScaleFactor || 1));

const cacheDir = resolve(__dirname, '.cache');

// Walk the @puppeteer/browsers cache and find the chrome-headless-shell
// (or chrome) executable. The structure is:
//   .cache/chrome-headless-shell/<platform>-<version>/chrome-headless-shell-<platform>/chrome-headless-shell
function findChromiumExecutable(root) {
    if (!existsSync(root)) return null;
    const candidates = [];
    function walk(dir, depth) {
        if (depth > 5) return;
        let entries;
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
            const full = join(dir, name);
            let st;
            try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) {
                walk(full, depth + 1);
            } else if (st.isFile() && (name === 'chrome-headless-shell' || name === 'chrome' || name === 'chromium')) {
                candidates.push(full);
            }
        }
    }
    walk(root, 0);
    candidates.sort((a, b) => {
        const score = (p) => (p.includes('chrome-headless-shell') ? 0 : 1);
        return score(a) - score(b);
    });
    return candidates[0] || null;
}

const executablePath = process.env.PHANTOMWP_CHROMIUM_PATH || findChromiumExecutable(cacheDir);
if (!executablePath) {
    console.error('[screenshot] Chromium binary not found in ' + cacheDir + '. Run: cd .devcontainer/screenshot && bash install.sh');
    process.exit(2);
}

const normalizedPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
const url = 'http://localhost:' + port + normalizedPath;

let browser;
try {
    browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--hide-scrollbars',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
    });

    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.setUserAgent('PhantomWP-PreviewScreenshot/1.0');

    page.setDefaultNavigationTimeout(25000);
    page.setDefaultTimeout(25000);

    await page.goto(url, { waitUntil: 'load', timeout: 25000 });

    // Wait for fonts and a couple paints so we don't snapshot a half-rendered layout.
    await page.evaluate(() => {
        return new Promise((res) => {
            const done = () => requestAnimationFrame(() => requestAnimationFrame(res));
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(done, done);
            } else {
                done();
            }
        });
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 400));

    const isPng = format === 'png';
    const screenshotOptions = {
        type: isPng ? 'png' : 'jpeg',
        quality: isPng ? undefined : 25,
        encoding: 'binary',
    };

    // Collect a hint of selectors that DO exist on the page so a missed
    // selector can be turned into an actionable error for the AI: the
    // first list is data-component values from the dev plugin
    // (lib/astro-template/scripts/phantom-dev-tools.ts), the second is a
    // fallback list of semantic top-level tags that almost always exist.
    async function collectSelectorHints() {
        try {
            return await page.evaluate(() => {
                const components = Array.from(
                    new Set(
                        Array.from(document.querySelectorAll('[data-component]'))
                            .map((el) => el.getAttribute('data-component'))
                            .filter(Boolean),
                    ),
                ).slice(0, 25);
                const semantic = ['header', 'nav', 'main', 'footer', 'aside']
                    .filter((tag) => document.querySelector(tag));
                return { components, semantic };
            });
        } catch {
            return { components: [], semantic: [] };
        }
    }

    function formatSelectorHint(hint) {
        const lines = [];
        if (hint.components.length > 0) {
            lines.push('data-component values on this page (use [data-component$="<name>"]):');
            for (const c of hint.components) lines.push('  - ' + c);
        } else {
            lines.push('No data-component attributes were found on this page (the phantom-dev-tools plugin may not be active here).');
        }
        if (hint.semantic.length > 0) {
            lines.push('Top-level semantic tags present: ' + hint.semantic.join(', '));
        }
        return lines.join('\n');
    }

    // The codespace WebSocket exec protocol drops stderr on non-zero
    // exit (only `error` propagates, not `output`). To make the
    // selector-miss hint actually reach the AI we emit structured
    // errors on STDOUT with a recognisable marker and still exit 0;
    // the screenshot_preview tool decodes the marker into a helpful
    // [Error] message instead of an image.
    async function emitSelectorMissError(reason) {
        const hint = await collectSelectorHints();
        const message = '[screenshot-error] ' + reason + '\n' + formatSelectorHint(hint);
        process.stdout.write(message + '\n');
        await browser.close();
        process.exit(0);
    }

    let buffer;
    let clipNote = '';
    if (selector) {
        // Bring the element into view and grab its bounding box, then
        // capture a clip with a small padding so the AI can see a bit of
        // surrounding context (margins, neighbouring text). On selector
        // miss / zero-size we exit non-zero with a list of selectors
        // that DO exist so the model can retry with a real one instead
        // of being silently handed a full-page capture.
        const handle = await page.$(selector);
        if (!handle) {
            await emitSelectorMissError('selector did not match any element: ' + selector);
        }
        try {
            await handle.evaluate((el) => {
                el.scrollIntoView({ block: 'center', inline: 'center' });
            });
            await new Promise((r) => setTimeout(r, 150));
            const box = await handle.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                return {
                    x: rect.left + window.scrollX,
                    y: rect.top + window.scrollY,
                    width: rect.width,
                    height: rect.height,
                };
            });
            if (!box || box.width === 0 || box.height === 0) {
                await handle.dispose().catch(() => {});
                await emitSelectorMissError('selector matched a zero-size element: ' + selector);
            }
            const pad = selectorPadding;
            const clip = {
                x: Math.max(0, Math.floor(box.x - pad)),
                y: Math.max(0, Math.floor(box.y - pad)),
                width: Math.min(maxCaptureEdgeCssPx, Math.ceil(box.width + pad * 2)),
                height: Math.min(maxCaptureEdgeCssPx, Math.ceil(box.height + pad * 2)),
            };
            buffer = await page.screenshot({ ...screenshotOptions, clip, captureBeyondViewport: true });
        } finally {
            await handle.dispose().catch(() => {});
        }
    } else if (fullPage) {
        const pageCssHeight = await page.evaluate(() => Math.max(
            document.documentElement ? document.documentElement.scrollHeight : 0,
            document.body ? document.body.scrollHeight : 0,
        ));
        if (pageCssHeight > maxCaptureEdgeCssPx) {
            // Clip to the top of the page: a taller capture would be
            // rejected by the model outright. The clip note travels with
            // the data URL so the AI knows the page continues below.
            clipNote = 'The full page is ' + pageCssHeight + 'px tall; only the top ' + maxCaptureEdgeCssPx + 'px was captured.';
            buffer = await page.screenshot({
                ...screenshotOptions,
                clip: { x: 0, y: 0, width: viewport.width, height: maxCaptureEdgeCssPx },
                captureBeyondViewport: true,
            });
        } else {
            buffer = await page.screenshot({ ...screenshotOptions, fullPage: true, captureBeyondViewport: true });
        }
    } else {
        buffer = await page.screenshot(screenshotOptions);
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
        process.stdout.write('[screenshot-error] capture is '
            + (buffer.length / 1024 / 1024).toFixed(1)
            + 'MB, larger than the model accepts. Retry with a CSS selector for the relevant section, a smaller viewport, or fullPage: false.\n');
        await browser.close();
        process.exit(0);
    }

    if (clipNote) {
        process.stdout.write('[screenshot-meta] ' + clipNote + '\n');
    }
    const mime = isPng ? 'image/png' : 'image/jpeg';
    const base64 = Buffer.from(buffer).toString('base64');
    process.stdout.write('data:' + mime + ';base64,' + base64 + '\n');
    await browser.close();
    process.exit(0);
} catch (err) {
    if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
    }
    console.error('[screenshot] ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
}
