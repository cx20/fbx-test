const ASSETS = [
    'Samba Dancing',
    'morph_test',
    'monkey',
    'monkey_embedded_texture',
    'vCube',
    'archer/ArcherRi01',
    'warrior/Warrior',
    'stanford-bunny',
    'mixamo',
    'RotationTest',
    'exampleWindow',
    'Head_69',
    'morph-translation',
];

const SCALES = new Map([
    ['warrior/Warrior',    100],
    ['archer/ArcherRi01',  100],
    ['stanford-bunny',     0.001],
    ['Head_69',            100],
]);

const FBX_BASE = '../../assets/models/fbx/';
const CUSTOM_URL_OPTION = '__custom_url__';
const SEARCH_PARAMS = new URLSearchParams(window.location.search);

let engine, scene, canvas, camera;
let importedMeshes = [];
let isLoading = false;

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

function getInitialModel() {
    const model = SEARCH_PARAMS.get('model');
    return ASSETS.includes(model) ? model : 'vCube';
}

function getCustomUrl() {
    const url = SEARCH_PARAMS.get('url');
    return url && url.trim() ? url.trim() : null;
}

function getInitialSelection() {
    return getCustomUrl() ? CUSTOM_URL_OPTION : getInitialModel();
}

function getUrlFileName(url) {
    try {
        const parsed = new URL(url, window.location.href);
        const name = parsed.pathname.split('/').pop() || url;
        return decodeURIComponent(name);
    } catch {
        const name = url.split(/[\\/]/).pop() || url;
        return decodeURIComponent(name);
    }
}

function getScaleOverride() {
    const scale = Number(SEARCH_PARAMS.get('scale'));
    return Number.isFinite(scale) && scale > 0 ? scale : null;
}

function getAnimationEnabled() {
    const value = SEARCH_PARAMS.get('animation') ?? SEARCH_PARAMS.get('anim');
    return !['0', 'false', 'off', 'no'].includes((value ?? '').toLowerCase());
}

function getAnimationTime() {
    const value = SEARCH_PARAMS.get('time');
    const time = value === null ? NaN : Number(value);
    return Number.isFinite(time) ? time : null;
}

function frameModel(nodes) {
    const meshes = nodes.filter(node => node instanceof BABYLON.Mesh);
    if (!meshes.length) return;

    let min = null;
    let max = null;
    for (const mesh of meshes) {
        mesh.computeWorldMatrix(true);
        const bounds = mesh.getBoundingInfo().boundingBox;
        const bMin = bounds.minimumWorld;
        const bMax = bounds.maximumWorld;
        min = min
            ? BABYLON.Vector3.Minimize(min, bMin)
            : bMin.clone();
        max = max
            ? BABYLON.Vector3.Maximize(max, bMax)
            : bMax.clone();
    }

    const center = min.add(max).scale(0.5);
    const size = max.subtract(min).length();
    camera.target.copyFrom(center);
    camera.radius = Math.max(size * 1.25, 1);
}

async function loadModel(selection) {
    if (isLoading) return;
    isLoading = true;
    const customUrl = selection === CUSTOM_URL_OPTION ? getCustomUrl() : null;
    const name = customUrl ? getUrlFileName(customUrl).replace(/\.fbx$/i, '') : selection;
    setStatus(`読み込み中: ${name} ...`);

    try {
        importedMeshes.forEach(m => m.dispose());
        importedMeshes = [];

        const url = customUrl ?? (FBX_BASE + selection.split('/').map(encodeURIComponent).join('/') + '.fbx');

        const meshes = await FBXLoader.loadFBX(url, scene, {
            animation: getAnimationEnabled(),
            animationTime: getAnimationTime(),
        });

        const scale = getScaleOverride() ?? SCALES.get(selection) ?? 1;
        if (scale !== 1) {
            // Only scale root nodes; children inherit scale through the hierarchy.
            meshes.filter(m => !meshes.includes(m.parent)).forEach(m => m.scaling.scaleInPlace(scale));
        }

        importedMeshes = meshes;
        frameModel(meshes);

        const meshCount = meshes.filter(m => m instanceof BABYLON.Mesh).length;
        const msg = `${name} — meshes: ${meshCount}`;
        console.log(msg);
        setStatus(msg);

    } catch (err) {
        console.error(err);
        setStatus(`エラー: ${err.message}`);
    } finally {
        isLoading = false;
    }
}

async function init() {
    canvas = document.querySelector('#c');
    engine = new BABYLON.Engine(canvas, true);

    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.5, 0.5, 0.5, 1);

    camera = new BABYLON.ArcRotateCamera(
        'camera', -Math.PI / 2, Math.PI / 2.5, 10,
        BABYLON.Vector3.Zero(), scene
    );
    camera.attachControl(canvas, true);
    camera.wheelPrecision = 1;
    camera.lowerRadiusLimit = 0.5;
    camera.upperRadiusLimit = 500;

    new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-1, -2, -1), scene);
    dir.intensity = 0.7;

    // プルダウン初期化
    const select = document.getElementById('modelSelect');
    const customUrl = getCustomUrl();
    const initialSelection = getInitialSelection();
    if (customUrl) {
        const opt = document.createElement('option');
        opt.value = CUSTOM_URL_OPTION;
        opt.textContent = `Custom: ${getUrlFileName(customUrl)}`;
        opt.selected = true;
        select.appendChild(opt);
    }
    ASSETS.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        // vCube を初期選択
        if (name === initialSelection) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => loadModel(select.value));

    engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => engine.resize());

    // 初期モデルを読み込む
    await loadModel(initialSelection);
}

init();
