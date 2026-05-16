// Check what mesh.parent and mesh.world look like in BJS for RiggedFigure
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:5500/example/babylonjs/index.html?model=gltf/RiggedFigure&animation=0&time=0&fog=0&ground=0&grid=0&skeleton=1&clip=Armature%7CAnim_0.002';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`));
    try {
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => {
            const s = document.getElementById('status');
            return s && s.textContent.includes('meshes:');
        }, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        const info = await page.evaluate(() => {
            const scene = window.BABYLON?._lastScene ?? null;
            const lookFor = (s) => {
                const meshes = (s?.meshes ?? []).filter(m => m.skeleton);
                return meshes;
            };
            const result = [];
            // Try to find SkinnedMesh in active scenes
            for (const engineProp of Object.keys(window)) {
                try {
                    const v = window[engineProp];
                    if (v && v._scenes && v._scenes.length) {
                        for (const s of v._scenes) {
                            const ms = lookFor(s);
                            for (const m of ms) {
                                // chain of parents
                                const parents = [];
                                let cur = m.parent;
                                while (cur) {
                                    parents.push({
                                        name: cur.name,
                                        pos: cur.position ? [cur.position.x, cur.position.y, cur.position.z] : null,
                                        rot: cur.rotation ? [cur.rotation.x, cur.rotation.y, cur.rotation.z] : null,
                                        rotQ: cur.rotationQuaternion ? [cur.rotationQuaternion.x, cur.rotationQuaternion.y, cur.rotationQuaternion.z, cur.rotationQuaternion.w] : null,
                                        scale: cur.scaling ? [cur.scaling.x, cur.scaling.y, cur.scaling.z] : null,
                                    });
                                    cur = cur.parent;
                                }
                                m.computeWorldMatrix(true);
                                const worldData = Array.from(m.getWorldMatrix().m);
                                result.push({
                                    meshName: m.name,
                                    position: [m.position.x, m.position.y, m.position.z],
                                    rotation: m.rotation ? [m.rotation.x, m.rotation.y, m.rotation.z] : null,
                                    rotationQuaternion: m.rotationQuaternion ? [m.rotationQuaternion.x, m.rotationQuaternion.y, m.rotationQuaternion.z, m.rotationQuaternion.w] : null,
                                    scaling: [m.scaling.x, m.scaling.y, m.scaling.z],
                                    worldMatrix: worldData,
                                    parents,
                                    skeletonName: m.skeleton?.name,
                                    boneCount: m.skeleton?.bones?.length,
                                });
                            }
                        }
                    }
                } catch (e) {}
            }
            return result;
        });

        console.log('Mesh info:');
        console.log(JSON.stringify(info, null, 2));
    } finally {
        await browser.close();
    }
})();
