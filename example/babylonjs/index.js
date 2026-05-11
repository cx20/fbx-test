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
let gui, animationFolder, timeController;
let activeAnimations = [];
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

function getAssetOptions() {
    const options = {};
    const customUrl = getCustomUrl();
    if (customUrl) options[`Custom: ${getUrlFileName(customUrl)}`] = CUSTOM_URL_OPTION;
    ASSETS.forEach(name => {
        options[name] = name;
    });
    return options;
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

const PARAMS = {
    asset: getInitialSelection(),
    animate: getAnimationEnabled(),
    time: getAnimationTime() ?? 0,
    debug: showDebugLayer,
};

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
        activeAnimations = [];
        rebuildAnimationFolder();

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
        PARAMS.asset = selection;
        frameModel(meshes);
        rebuildAnimationFolder();

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

function getAnimationControls() {
    const controls = [];
    importedMeshes.forEach(node => {
        const nodeControls = node.metadata?.fbxAnimationControls;
        if (Array.isArray(nodeControls)) controls.push(...nodeControls);
    });
    return controls;
}

function rebuildAnimationFolder() {
    [...animationFolder.children].forEach(child => child.destroy());
    animationFolder.hide();

    activeAnimations = getAnimationControls();
    if (!activeAnimations.length) return;

    PARAMS.animate = activeAnimations.some(animation => animation.playing);
    PARAMS.time = getAnimationTime() ?? activeAnimations[0].time;
    animationFolder.show();
    animationFolder.add(PARAMS, 'animate').name('play').onChange(value => {
        activeAnimations.forEach(animation => animation.setPlaying(value));
    });
    const duration = Math.max(...activeAnimations.map(animation => animation.duration));
    timeController = animationFolder.add(PARAMS, 'time', 0, duration, 0.01)
        .name('time')
        .onChange(value => {
            activeAnimations.forEach(animation => animation.setTime(value));
        });
    activeAnimations.forEach(animation => animation.setTime(PARAMS.time));
    timeController.updateDisplay();
}

function showDebugLayer() {
    if (!scene?.debugLayer) return;
    if (scene.debugLayer.isVisible?.()) {
        scene.debugLayer.hide();
        return;
    }

    scene.debugLayer.show({
        embedMode: true,
        overlay: true,
        handleResize: false,
    });
}

function initGui() {
    gui = new lil.GUI();
    gui.add(PARAMS, 'asset', getAssetOptions()).name('asset').onChange(loadModel);
    animationFolder = gui.addFolder('Animation').hide();
    gui.add(PARAMS, 'debug').name('Debug');
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

    const initialSelection = getInitialSelection();
    initGui();

    engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => engine.resize());

    // 初期モデルを読み込む
    await loadModel(initialSelection);
}

init();
