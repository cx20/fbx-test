import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

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
const SEARCH_PARAMS = new URLSearchParams(window.location.search);

let renderer, scene, camera, controls, loader, gui, morphsFolder, animationFolder;
let ground, grid;
let importedObject = null;
let skeletonHelper = null;
let mixer = null;
let activeAction = null;
let isLoading = false;
let clipController, timeController;
const timer = new THREE.Timer();
timer.connect(document);

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

function getInitialModel() {
    const model = SEARCH_PARAMS.get('model');
    return ASSETS.includes(model) ? model : 'vCube';
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

function getScaleOverride() {
    const scale = Number(SEARCH_PARAMS.get('scale'));
    return Number.isFinite(scale) && scale > 0 ? scale : null;
}

const PARAMS = {
    asset: getInitialModel(),
    animate: getAnimationEnabled(),
    time: getAnimationTime() ?? 0,
    clip: '',
    skeleton: false,
    ground: true,
    grid: true,
};

function disposeObject(object) {
    object.traverse(child => {
        if (child.isSkinnedMesh && child.skeleton) child.skeleton.dispose();
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(material => {
                for (const key of Object.keys(material)) {
                    const value = material[key];
                    if (value && value.isTexture) value.dispose();
                }
                material.dispose();
            });
        }
    });
}

function disposeSkeletonHelper() {
    if (!skeletonHelper) return;
    scene.remove(skeletonHelper);
    skeletonHelper.geometry?.dispose();
    skeletonHelper.material?.dispose();
    skeletonHelper = null;
}

function countMeshes(object) {
    let count = 0;
    object.traverse(child => {
        if (child.isMesh) count++;
    });
    return count;
}

function getDefaultClip(object) {
    if (!object.animations.length) return null;
    console.log('[FBX] Animation clips:', object.animations.map(clip => clip.name).join(', '));
    return object.animations.find(clip => clip.name === 'idle') ?? object.animations[0];
}

function setActiveClip(clipName = PARAMS.clip) {
    if (!mixer || !importedObject?.animations.length) return;

    if (activeAction) {
        activeAction.stop();
        activeAction = null;
    }

    const clip = importedObject.animations.find(item => item.name === clipName) ?? importedObject.animations[0];
    PARAMS.clip = clip.name;
    activeAction = mixer.clipAction(clip);
    activeAction.play();
    applyAnimationTime();
}

function applyAnimationTime() {
    if (mixer && !PARAMS.animate) {
        mixer.setTime(PARAMS.time);
    }
}

function setObjectVisibility() {
    if (skeletonHelper) skeletonHelper.visible = PARAMS.skeleton;
    if (ground) ground.visible = PARAMS.ground;
    if (grid) grid.visible = PARAMS.grid;
}

function rebuildAnimationFolder(object) {
    [...animationFolder.children].forEach(child => child.destroy());
    animationFolder.hide();

    if (!object.animations.length) return;

    const clips = object.animations.map(clip => clip.name);
    const defaultClip = getDefaultClip(object);
    PARAMS.clip = defaultClip?.name ?? clips[0];
    PARAMS.time = getAnimationTime() ?? 0;
    animationFolder.show();
    clipController = animationFolder.add(PARAMS, 'clip', clips).name('clip').onChange(setActiveClip);
    animationFolder.add(PARAMS, 'animate').name('play').onChange(value => {
        if (!value) applyAnimationTime();
    });
    timeController = animationFolder.add(PARAMS, 'time', 0, Math.max(...object.animations.map(clip => clip.duration)), 0.01)
        .name('time')
        .onChange(applyAnimationTime);
    clipController.updateDisplay();
    timeController.updateDisplay();
}

function rebuildMorphsFolder(object) {
    [...morphsFolder.children].forEach(child => child.destroy());
    morphsFolder.hide();

    object.traverse(child => {
        if (!child.isMesh || !child.morphTargetDictionary) return;

        morphsFolder.show();
        const meshFolder = morphsFolder.addFolder(child.name || child.uuid);
        Object.keys(child.morphTargetDictionary).forEach(key => {
            meshFolder.add(child.morphTargetInfluences, child.morphTargetDictionary[key], 0, 1, 0.01).name(key);
        });
    });
}

async function loadModel(name) {
    if (isLoading) return;
    isLoading = true;
    setStatus(`読み込み中: ${name} ...`);

    try {
        if (importedObject) {
            scene.remove(importedObject);
            disposeObject(importedObject);
            importedObject = null;
        }
        disposeSkeletonHelper();
        mixer = null;
        activeAction = null;

        const fbxPath = name.split('/').map(encodeURIComponent).join('/');
        const url = FBX_BASE + fbxPath + '.fbx';
        const object = await loader.loadAsync(url);

        const scale = getScaleOverride() ?? SCALES.get(name) ?? 1;
        PARAMS.asset = name;
        object.scale.setScalar(scale);

        object.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        importedObject = object;

        if (object.animations.length) {
            mixer = new THREE.AnimationMixer(object);
            rebuildAnimationFolder(object);
            setActiveClip(PARAMS.clip);
            if (getAnimationTime() !== null) mixer.setTime(PARAMS.time);
        } else {
            rebuildAnimationFolder(object);
        }

        scene.add(object);
        skeletonHelper = new THREE.SkeletonHelper(object);
        skeletonHelper.visible = PARAMS.skeleton;
        scene.add(skeletonHelper);
        rebuildMorphsFolder(object);

        const meshCount = countMeshes(object);
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

function initGui() {
    gui = new GUI();
    gui.add(PARAMS, 'asset', ASSETS).name('asset').onChange(loadModel);
    gui.add(PARAMS, 'skeleton').name('skeleton').onChange(setObjectVisibility);
    gui.add(PARAMS, 'ground').name('ground').onChange(setObjectVisibility);
    gui.add(PARAMS, 'grid').name('grid').onChange(setObjectVisibility);
    animationFolder = gui.addFolder('Animation').hide();
    morphsFolder = gui.addFolder('Morphs').hide();
}

function init() {
    const canvas = document.querySelector('#c');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa0a0a0);
    scene.fog = new THREE.Fog(0xa0a0a0, 200, 1000);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 2000);
    camera.position.set(100, 200, 300);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 5);
    hemi.position.set(0, 200, 0);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 5);
    dir.position.set(0, 200, 100);
    dir.castShadow = true;
    dir.shadow.camera.top = 180;
    dir.shadow.camera.bottom = -100;
    dir.shadow.camera.left = -120;
    dir.shadow.camera.right = 120;
    scene.add(dir);

    ground = new THREE.Mesh(
        new THREE.PlaneGeometry(2000, 2000),
        new THREE.MeshPhongMaterial({ color: 0x999999, depthWrite: false })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    grid = new THREE.GridHelper(2000, 20, 0x000000, 0x000000);
    grid.material.opacity = 0.2;
    grid.material.transparent = true;
    scene.add(grid);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 100, 0);
    controls.update();

    loader = new FBXLoader();
    initGui();

    window.addEventListener('resize', onResize);
    renderer.setAnimationLoop(animate);

    loadModel(PARAMS.asset);
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    timer.update();
    const delta = timer.getDelta();
    if (mixer && PARAMS.animate) mixer.update(delta);
    controls.update();
    renderer.render(scene, camera);
}

init();
