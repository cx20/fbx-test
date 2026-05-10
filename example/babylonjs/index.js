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

let engine, scene, canvas;
let importedMeshes = [];
let isLoading = false;

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

function getInitialModel() {
    const model = new URLSearchParams(window.location.search).get('model');
    return ASSETS.includes(model) ? model : 'vCube';
}

async function loadModel(name) {
    if (isLoading) return;
    isLoading = true;
    setStatus(`読み込み中: ${name} ...`);

    try {
        importedMeshes.forEach(m => m.dispose());
        importedMeshes = [];

        const fbxPath = name.split('/').map(encodeURIComponent).join('/');
        const url     = FBX_BASE + fbxPath + '.fbx';

        const meshes = await FBXLoader.loadFBX(url, scene);

        const scale = SCALES.get(name) ?? 1;
        if (scale !== 1) {
            // Only scale root nodes; children inherit scale through the hierarchy
            meshes.filter(m => !meshes.includes(m.parent)).forEach(m => m.scaling.scaleInPlace(scale));
        }

        importedMeshes = meshes;

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

    const camera = new BABYLON.ArcRotateCamera(
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
    const initialModel = getInitialModel();
    ASSETS.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        // vCube を初期選択
        if (name === initialModel) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => loadModel(select.value));

    engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => engine.resize());

    // 初期モデルを読み込む
    await loadModel(initialModel);
}

init();
