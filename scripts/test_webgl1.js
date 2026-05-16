// Smoke-test the WebGL1.0 sample with vCube and AnimatedTriangle.
const { chromium } = require('playwright');
const path = require('path');

const MODELS = [
    { name: 'vCube',                 file: 'vcube',              time: 0 },
    { name: 'gltf/AnimatedTriangle', file: 'animated-triangle-t0', time: 0 },
    { name: 'gltf/AnimatedTriangle', file: 'animated-triangle-t05', time: 0.5 },
    { name: 'gltf/AnimatedTriangle', file: 'animated-triangle-t10', time: 1.0 },
];

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const m of MODELS) {
            const url = `http://127.0.0.1:5500/example/webgl1/index.html?model=${encodeURIComponent(m.name)}&animation=0&time=${m.time}`;
            console.log(`\n=== ${m.name} ===`);
            console.log(`  ${url}`);
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const page = await ctx.newPage();
            const errs = [];
            page.on('console', msg => {
                const t = msg.text();
                if (msg.type() === 'error' || /\b(error|exception)\b/i.test(t)) errs.push(t);
            });
            page.on('pageerror', err => errs.push(`pageerror: ${err.message}`));
            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
                await page.waitForFunction(() => {
                    const s = document.getElementById('status');
                    return s && /triangles:|Error/i.test(s.textContent);
                }, { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(1500);
                const status = await page.evaluate(() => document.getElementById('status').textContent);
                console.log(`  status: ${status}`);
                const out = path.join(__dirname, 'screenshots', `webgl1-${m.file}.png`);
                await page.screenshot({ path: out, fullPage: false });
                console.log(`  saved: ${out}`);
                for (const e of errs.slice(0, 5)) console.log(`  err: ${e}`);
            } finally {
                await ctx.close();
            }
        }
    } finally {
        await browser.close();
    }
})();
