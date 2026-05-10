import * as THREE from 'three';
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

let renderer, scene, camera, controls, loader;
let importedObject = null;
let mixer = null;
let isLoading = false;
const timer = new THREE.Timer();
timer.connect(document);

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

function getInitialModel() {
    const model = new URLSearchParams(window.location.search).get('model');
    return ASSETS.includes(model) ? model : 'vCube';
}

function getAnimationEnabled() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('animation') ?? params.get('anim');
    return !['0', 'false', 'off', 'no'].includes((value ?? '').toLowerCase());
}

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

function countMeshes(object) {
    let count = 0;
    object.traverse(child => {
        if (child.isMesh) count++;
    });
    return count;
}

function selectDefaultClip(object) {
    if (!object.animations.length) return null;
    console.log('[FBX] Animation clips:', object.animations.map(clip => clip.name).join(', '));
    return object.animations.find(clip => clip.name === 'idle') ?? object.animations[0];
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
        mixer = null;

        const fbxPath = name.split('/').map(encodeURIComponent).join('/');
        const url = FBX_BASE + fbxPath + '.fbx';
        const object = await loader.loadAsync(url);

        const scale = SCALES.get(name);
        object.scale.setScalar(scale || 1);

        object.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        const clip = getAnimationEnabled() ? selectDefaultClip(object) : null;
        if (clip) {
            mixer = new THREE.AnimationMixer(object);
            mixer.clipAction(clip).play();
        }

        scene.add(object);
        importedObject = object;

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

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(2000, 2000),
        new THREE.MeshPhongMaterial({ color: 0x999999, depthWrite: false })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(2000, 20, 0x000000, 0x000000);
    grid.material.opacity = 0.2;
    grid.material.transparent = true;
    scene.add(grid);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 100, 0);
    controls.update();

    loader = new FBXLoader();

    const select = document.getElementById('modelSelect');
    const initialModel = getInitialModel();
    ASSETS.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === initialModel) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => loadModel(select.value));

    window.addEventListener('resize', onResize);
    renderer.setAnimationLoop(animate);

    loadModel(initialModel);
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    timer.update();
    const delta = timer.getDelta();
    if (mixer) mixer.update(delta);
    controls.update();
    renderer.render(scene, camera);
}

init();
