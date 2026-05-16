const { chromium } = require('playwright');
const path = require('path');

const MODEL = process.argv[2] || 'gltf/SimpleSkin';
const TIME = process.argv[3] || '1.0';
const CLIP = process.argv[4];

const params = new URLSearchParams({
    model: MODEL,
    animation: '0',
    time: TIME,
    fog: '0', ground: '0', grid: '0',
    skeleton: '1',
});
if (CLIP) params.set('clip', CLIP);

const URLS = {
    babylonjs: `http://127.0.0.1:5500/example/babylonjs/index.html?${params}`,
    threejs:   `http://127.0.0.1:5500/example/threejs/index.html?${params}`,
};

async function capture(browser, name, url) {
    console.log(`=== ${name}: ${url}`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', msg => {
        if (msg.type() === 'error' || /\b(error|exception)\b/i.test(msg.text())) errs.push(msg.text());
    });
    page.on('pageerror', err => errs.push(`pageerror: ${err.message}`));
    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForFunction(() => {
            const s = document.getElementById('status');
            return s && (s.textContent.includes('meshes:') || s.textContent.includes('エラー') || s.textContent.includes('Error'));
        }, { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2000);
        const status = await page.evaluate(() => document.getElementById('status')?.textContent ?? '?');
        console.log(`  status: ${status}`);
        const outPath = path.join(__dirname, 'screenshots', `${name}.png`);
        await page.screenshot({ path: outPath, fullPage: false });
        console.log(`  saved: ${outPath}`);
        for (const e of errs.slice(0, 8)) console.log(`  err: ${e}`);
    } finally {
        await ctx.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        await capture(browser, 'babylonjs', URLS.babylonjs);
        await capture(browser, 'threejs',   URLS.threejs);
    } finally {
        await browser.close();
    }
})();
