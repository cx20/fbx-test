// Smoke-test the WebGL1.0 sample with vCube and AnimatedTriangle.
const { chromium } = require('playwright');
const path = require('path');

const MODELS = [
    { name: 'vCube',                    file: 'vcube',                    time: 0 },
    { name: 'gltf/AnimatedTriangle',    file: 'animated-triangle-t0',     time: 0 },
    { name: 'gltf/AnimatedTriangle',    file: 'animated-triangle-t05',    time: 0.5 },
    { name: 'gltf/AnimatedTriangle',    file: 'animated-triangle-t10',    time: 1.0 },
    { name: 'monkey',                   file: 'monkey',                   time: 0 },
    { name: 'monkey_embedded_texture',  file: 'monkey-embedded',          time: 0 },
    { name: 'Samba Dancing',            file: 'samba-dancing',            time: 0 },
    { name: 'archer/ArcherRi01',        file: 'archer',                   time: 0 },
    { name: 'warrior/Warrior',          file: 'warrior',                  time: 0 },
    { name: 'stanford-bunny',           file: 'bunny',                    time: 0 },
    { name: 'Head_69',                  file: 'head',                     time: 0 },
    { name: 'RotationTest',             file: 'rotation-test',            time: 0 },
    { name: 'exampleWindow',            file: 'example-window',           time: 0 },
    { name: 'mixamo',                   file: 'mixamo',                   time: 0 },
    { name: 'test/anim_euler_jump',     file: 'anim-euler-jump',          time: 0 },
    { name: 'test/anim_root_motion',    file: 'anim-root-motion',         time: 0 },
    { name: 'gltf/SimpleSkin',          file: 'simple-skin-t0',           time: 0 },
    { name: 'gltf/SimpleSkin',          file: 'simple-skin-t1',           time: 1.0 },
    { name: 'gltf/RiggedSimple',        file: 'rigged-simple-t0',         time: 0 },
    { name: 'gltf/RiggedSimple',        file: 'rigged-simple-t1',         time: 1.0 },
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
