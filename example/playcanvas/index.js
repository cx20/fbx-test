import * as pc from 'https://cdn.jsdelivr.net/npm/playcanvas@2.18.1/build/playcanvas.mjs';

const { parseFBX, findNode, findNodes, prop0 } = window.FBXParser;
const {
    ASSETS, SCALES, modelUrl, createParams,
    getProps70, sampleCurve, buildAnimation, buildMorphAnimation,
    sampleAnimation, buildMesh, buildSkinForGeometry, buildMorphForGeometry,
} = window.FBXScene;

const { vec3 } = window.glMatrix;
const SEARCH_PARAMS = new URLSearchParams(window.location.search);
const CUSTOM_URL_OPTION = '__custom_url__';

const PARAMS = {
    ...createParams(),
    asset: getInitialSelection(),
    ground: getBoolParam('ground', true),
    rotate: getBoolParam('rotate', false),
};

let app, canvas, camera, light, ground;
let gui, assetController, clipController, timeController, morphsFolder;
let modelRoot = null;
let currentScene = null;
let isLoading = false;
let resources = [];

const cameraTarget = vec3.fromValues(0, 50, 0);
let orbitYaw = 45;
let orbitPitch = 25;
let orbitDistance = 320;

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

function getBoolParam(key, defaultValue) {
    const value = SEARCH_PARAMS.get(key);
    if (value === null) return defaultValue;
    return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function getCustomUrl() {
    const url = SEARCH_PARAMS.get('url');
    return url && url.trim() ? url.trim() : null;
}

function getInitialSelection() {
    const customUrl = getCustomUrl();
    if (customUrl) return CUSTOM_URL_OPTION;
    const model = SEARCH_PARAMS.get('model');
    return ASSETS.includes(model) ? model : 'vCube';
}

function getAssetOptions() {
    const options = {};
    const customUrl = getCustomUrl();
    if (customUrl) options[`Custom: ${getUrlFileName(customUrl)}`] = CUSTOM_URL_OPTION;
    ASSETS.forEach(name => { options[name] = name; });
    return options;
}

function getUrlFileName(url) {
    try {
        const parsed = new URL(url, window.location.href);
        return decodeURIComponent(parsed.pathname.split('/').pop() || url);
    } catch {
        return decodeURIComponent(url.split(/[\\/]/).pop() || url);
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
    return Number.isFinite(time) ? time : 0;
}

function getInitialClipName() {
    return SEARCH_PARAMS.get('clip') ?? null;
}

function disposeCurrentModel() {
    if (modelRoot) {
        modelRoot.destroy();
        modelRoot = null;
    }
    resources.forEach(resource => resource?.destroy?.());
    resources = [];
    currentScene = null;
}

function createMaterial(color, texture, hasVertexColor, track = true) {
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(color[0], color[1], color[2]);
    material.diffuseMap = texture || null;
    material.diffuseVertexColor = !!hasVertexColor;
    material.alphaTest = texture ? 0.5 : 0;
    material.cull = pc.CULLFACE_NONE;
    material.update();
    if (track) resources.push(material);
    return material;
}

function createTextureFromImage(img) {
    const texture = new pc.Texture(app.graphicsDevice, {
        width: img.width,
        height: img.height,
        format: pc.PIXELFORMAT_RGBA8,
        mipmaps: true,
    });
    texture.addressU = pc.ADDRESS_REPEAT;
    texture.addressV = pc.ADDRESS_REPEAT;
    texture.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
    texture.magFilter = pc.FILTER_LINEAR;
    texture.setSource(img);
    resources.push(texture);
    return texture;
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
        img.src = url;
    });
}

async function loadTextureFromBytes(bytes) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    try {
        return createTextureFromImage(await loadImage(url));
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function loadTextureFromVideo(vid, assetUrl) {
    const contentNode = findNode(vid.children, 'Content');
    if (contentNode && contentNode.props[0] instanceof ArrayBuffer) {
        return loadTextureFromBytes(contentNode.props[0]);
    }
    const relNode = findNode(vid.children, 'RelativeFilename');
    if (relNode && relNode.props[0]) {
        const base = assetUrl.substring(0, assetUrl.lastIndexOf('/') + 1);
        return createTextureFromImage(await loadImage(base + relNode.props[0].replace(/\\/g, '/')));
    }
    return null;
}

function readMaterialColor(matNode) {
    const p70 = findNode(matNode.children, 'Properties70');
    if (!p70) return null;
    let diffuse = null;
    let factor = 1;
    for (const p of p70.children) {
        if (p.name !== 'P' || !p.props) continue;
        const key = p.props[0];
        if ((key === 'DiffuseColor' || key === 'Diffuse') && p.props.length > 6) {
            diffuse = [p.props[4], p.props[5], p.props[6]];
        } else if (key === 'DiffuseFactor' && p.props.length > 4) {
            factor = p.props[4];
        }
    }
    return diffuse ? [diffuse[0] * factor, diffuse[1] * factor, diffuse[2] * factor] : null;
}

function stripFbxName(name) {
    const sep = (name ?? '').indexOf('\x00');
    return sep >= 0 ? name.slice(0, sep) : (name ?? '');
}

function makeEntityName(modelNode, fallback) {
    const name = stripFbxName(modelNode?.props?.[1]);
    return name || fallback;
}

function createMesh(meshData, group) {
    const mesh = new pc.Mesh(app.graphicsDevice);
    const vertexCount = meshData.positions.length / 3;
    mesh.setPositions(meshData.positions);
    mesh.setNormals(meshData.normals);
    if (meshData.hasUVs) mesh.setUvs(0, meshData.uvs);
    if (meshData.hasVertexColor) mesh.setColors(meshData.colors);
    if (meshData.hasSkin) {
        mesh.setVertexStream(pc.SEMANTIC_BLENDINDICES, new Uint8Array(meshData.boneIndices), 4, vertexCount, pc.TYPE_UINT8);
        mesh.setVertexStream(pc.SEMANTIC_BLENDWEIGHT, meshData.boneWeights, 4, vertexCount);
    }
    const groupIndices = meshData.indices.slice(group.offset, group.offset + group.count);
    mesh.setIndices(vertexCount > 65535 ? new Uint32Array(groupIndices) : new Uint16Array(groupIndices));
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    resources.push(mesh);
    return mesh;
}

function createGroundMesh(size) {
    const half = size * 0.5;
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(new Float32Array([
        -half, 0, -half,
         half, 0, -half,
         half, 0,  half,
        -half, 0,  half,
    ]));
    mesh.setNormals(new Float32Array([
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
    ]));
    mesh.setUvs(0, new Float32Array([
        0, 0,
        1, 0,
        1, 1,
        0, 1,
    ]));
    mesh.setIndices(new Uint16Array([0, 2, 1, 0, 3, 2]));
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
}

function createSkinResource(fbxSkin, entityById) {
    if (!fbxSkin) return null;
    const bones = fbxSkin.boneModelIds.map(id => entityById.get(id)).filter(Boolean);
    if (bones.length !== fbxSkin.boneModelIds.length) return null;
    const boneNames = bones.map(bone => bone.name);
    const inverseBindPose = fbxSkin.bindInverses.map(matrix => new pc.Mat4().set(matrix));
    return {
        skin: new pc.Skin(app.graphicsDevice, inverseBindPose, boneNames),
        bones,
    };
}

function createSkinInstance(skinResource) {
    if (!skinResource) return null;
    const skinInstance = new pc.SkinInstance(skinResource.skin);
    skinInstance.bones = skinResource.bones;
    return skinInstance;
}

function createMorphResource(meshData, fbxMorph) {
    if (!fbxMorph || !meshData.morphs.length) return null;
    const targets = meshData.morphs.map((deltaPositions, index) => new pc.MorphTarget({
        name: fbxMorph.channels[index]?.name || `channel_${index}`,
        deltaPositions,
        defaultWeight: PARAMS.morph,
    }));
    return new pc.Morph(targets, app.graphicsDevice);
}

function setEntityTransform(entity, base, anim, time) {
    const trs = sampleAnimation(anim ?? null, time, base);
    const rotation = new pc.Quat();
    const preRotation = new pc.Quat();
    const localRotation = new pc.Quat();
    preRotation.setFromEulerAngles(base.preR[0], base.preR[1], base.preR[2]);
    rotation.setFromEulerAngles(trs.R[0], trs.R[1], trs.R[2]);
    localRotation.mul2(preRotation, rotation);
    entity.setLocalPosition(trs.T[0], trs.T[1], trs.T[2]);
    entity.setLocalRotation(localRotation);
    entity.setLocalScale(trs.S[0], trs.S[1], trs.S[2]);
}

function frameModel(bounds) {
    if (!bounds) return;
    const center = [
        (bounds.min[0] + bounds.max[0]) * 0.5,
        (bounds.min[1] + bounds.max[1]) * 0.5,
        (bounds.min[2] + bounds.max[2]) * 0.5,
    ];
    const size = Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
    );
    vec3.set(cameraTarget, center[0], center[1], center[2]);
    orbitDistance = Math.max(size * 1.35, 4);
    orbitPitch = 25;
    orbitYaw = 45;
    updateCamera();
}

function getRenderBounds(root) {
    let bounds = null;
    root.syncHierarchy();
    root.forEach(entity => {
        const meshInstances = entity.render?.meshInstances ?? [];
        for (const meshInstance of meshInstances) {
            const aabb = meshInstance.aabb;
            const center = aabb.center;
            const half = aabb.halfExtents;
            const min = [center.x - half.x, center.y - half.y, center.z - half.z];
            const max = [center.x + half.x, center.y + half.y, center.z + half.z];
            if (!bounds) {
                bounds = { min, max };
            } else {
                bounds.min[0] = Math.min(bounds.min[0], min[0]);
                bounds.min[1] = Math.min(bounds.min[1], min[1]);
                bounds.min[2] = Math.min(bounds.min[2], min[2]);
                bounds.max[0] = Math.max(bounds.max[0], max[0]);
                bounds.max[1] = Math.max(bounds.max[1], max[1]);
                bounds.max[2] = Math.max(bounds.max[2], max[2]);
            }
        }
    });
    return bounds;
}

function expandBounds(bounds, positions) {
    if (!positions?.length) return bounds;
    const out = bounds ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < positions.length; i += 3) {
        out.min[0] = Math.min(out.min[0], positions[i]);
        out.min[1] = Math.min(out.min[1], positions[i + 1]);
        out.min[2] = Math.min(out.min[2], positions[i + 2]);
        out.max[0] = Math.max(out.max[0], positions[i]);
        out.max[1] = Math.max(out.max[1], positions[i + 1]);
        out.max[2] = Math.max(out.max[2], positions[i + 2]);
    }
    return out;
}

async function loadModel(selection) {
    if (isLoading) return;
    isLoading = true;

    const customUrl = selection === CUSTOM_URL_OPTION ? getCustomUrl() : null;
    const name = customUrl ? getUrlFileName(customUrl).replace(/\.fbx$/i, '') : selection;
    const url = customUrl ?? modelUrl(selection);
    setStatus(`Loading ${name} ...`);

    try {
        disposeCurrentModel();
        rebuildClipGui([]);
        rebuildMorphsFolder([]);

        const buffer = await fetch(url).then(response => {
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            return response.arrayBuffer();
        });
        const { nodes } = await parseFBX(buffer);
        const objects = findNode(nodes, 'Objects');
        const connsNode = findNode(nodes, 'Connections');
        if (!objects || !connsNode) throw new Error('missing Objects/Connections');

        const geoById = new Map(findNodes(objects.children, 'Geometry').map(n => [n.props[0], n]));
        const modelById = new Map(findNodes(objects.children, 'Model').map(n => [n.props[0], n]));
        const matById = new Map(findNodes(objects.children, 'Material').map(n => [n.props[0], n]));
        const texById = new Map(findNodes(objects.children, 'Texture').map(n => [n.props[0], n]));
        const vidById = new Map(findNodes(objects.children, 'Video').map(n => [n.props[0], n]));
        const deformerById = new Map(findNodes(objects.children, 'Deformer').map(n => [n.props[0], n]));
        const parentOf = new Map();
        const reverseConns = new Map();

        for (const c of connsNode.children) {
            if (c.name !== 'C') continue;
            const fromId = c.props[1];
            const toId = c.props[2];
            if (c.props[0] === 'OO' && modelById.has(fromId) && modelById.has(toId)) parentOf.set(fromId, toId);
            if (!reverseConns.has(toId)) reverseConns.set(toId, []);
            reverseConns.get(toId).push(fromId);
        }

        const meshPairs = [];
        for (const c of connsNode.children) {
            if (c.name !== 'C' || c.props[0] !== 'OO') continue;
            const [, fromId, toId] = c.props;
            if (geoById.has(fromId) && modelById.has(toId)) meshPairs.push({ geoNode: geoById.get(fromId), modelId: toId });
        }
        if (!meshPairs.length) throw new Error('no Geometry nodes');

        const baseTRSOf = new Map();
        const entityById = new Map();
        modelRoot = new pc.Entity(name);
        const scale = getScaleOverride() ?? SCALES.get(selection) ?? 1;
        modelRoot.setLocalScale(scale, scale, scale);
        app.root.addChild(modelRoot);

        for (const [id, modelNode] of modelById) {
            const base = getProps70(modelNode);
            baseTRSOf.set(id, base);
            const entity = new pc.Entity(makeEntityName(modelNode, `model_${id}`));
            setEntityTransform(entity, base, null, 0);
            entityById.set(id, entity);
        }
        for (const [id, entity] of entityById) {
            const parent = entityById.get(parentOf.get(id)) ?? modelRoot;
            parent.addChild(entity);
        }

        function findMaterialsForModel(modelId) {
            const mats = [];
            for (const matId of reverseConns.get(modelId) ?? []) {
                if (matById.has(matId)) mats.push(matById.get(matId));
            }
            return mats;
        }

        function findVideoForMaterial(matId) {
            for (const texId of reverseConns.get(matId) ?? []) {
                if (!texById.has(texId)) continue;
                for (const vidId of reverseConns.get(texId) ?? []) {
                    if (vidById.has(vidId)) return vidById.get(vidId);
                }
            }
            return null;
        }

        const clipStubs = buildClipStubs(objects, connsNode);
        const clips = clipStubs.map(stub => {
            const animationsOf = new Map();
            for (const [id] of modelById) {
                const anim = buildAnimation(nodes, id, stub.acns);
                if (anim) animationsOf.set(id, anim);
            }
            let duration = 0;
            for (const anim of animationsOf.values()) duration = Math.max(duration, anim.duration);
            return { name: stub.name, animationsOf, morphAnimsByChannel: new Map(), duration };
        });

        let bounds = null;
        let totalTriangles = 0;
        let totalSkinnedMeshes = 0;
        let totalMorphs = 0;
        const morphMeshes = [];

        for (const { geoNode, modelId } of meshPairs) {
            const verts = prop0(findNode(geoNode.children, 'Vertices'));
            const vertexCount = verts ? verts.length / 3 : 0;
            const skin = buildSkinForGeometry(geoNode, vertexCount, connsNode, deformerById, modelById);
            const morph = buildMorphForGeometry(geoNode, vertexCount, connsNode, geoById, deformerById);
            let morphRecord = null;
            if (morph) {
                morphRecord = {
                    modelId,
                    modelName: makeEntityName(modelById.get(modelId), `model_${modelId}`),
                    morph,
                    instances: [],
                };
                morphMeshes.push(morphRecord);
                for (const channel of morph.channels) {
                    for (let i = 0; i < clipStubs.length; i++) {
                        const anim = buildMorphAnimation(nodes, channel.channelId, clipStubs[i].acns);
                        if (anim) {
                            clips[i].morphAnimsByChannel.set(channel.channelId, anim);
                            clips[i].duration = Math.max(clips[i].duration, anim.duration);
                        }
                    }
                }
            }

            const matsForModel = findMaterialsForModel(modelId);
            const matColors = matsForModel.map(mat => readMaterialColor(mat) ?? [1, 1, 1]);
            const base = baseTRSOf.get(modelId);
            const meshData = buildMesh(
                geoNode,
                skin,
                morph ? morph.channels.map(channel => channel.deltas) : null,
                matColors,
                base ? { T: base.geoT, R: base.geoR, S: base.geoS } : null,
            );
            if (!meshData) continue;
            const skinResource = createSkinResource(skin, entityById);
            const morphResource = createMorphResource(meshData, morph);

            const textures = await Promise.all(matsForModel.map(async mat => {
                if (!meshData.hasUVs) return null;
                const vid = findVideoForMaterial(mat.props[0]);
                if (!vid) return null;
                try { return await loadTextureFromVideo(vid, url); }
                catch (err) { console.warn('Texture load failed:', err); return null; }
            }));

            const entity = entityById.get(modelId) ?? modelRoot;
            const meshInstances = meshData.groups.map(group => {
                const material = createMaterial(matColors[group.matIdx] ?? [0.85, 0.85, 0.9], textures[group.matIdx], meshData.hasVertexColor);
                const mesh = createMesh(meshData, group);
                if (skinResource) mesh.skin = skinResource.skin;
                if (morphResource) mesh.morph = morphResource;
                const meshInstance = new pc.MeshInstance(mesh, material, entity);
                meshInstance.skinInstance = createSkinInstance(skinResource);
                if (morphResource) {
                    meshInstance.morphInstance = new pc.MorphInstance(morphResource);
                    morphRecord.instances.push(meshInstance.morphInstance);
                }
                meshInstance.castShadow = true;
                return meshInstance;
            });
            entity.addComponent('render', { meshInstances });

            bounds = expandBounds(bounds, meshData.positions);
            totalTriangles += meshData.triangleCount;
            if (skin) totalSkinnedMeshes++;
            if (morph) totalMorphs += morph.channels.length;
        }

        const liveClips = clips.filter((clip, i) =>
            clip.animationsOf.size > 0 || clip.morphAnimsByChannel.size > 0 || clipStubs[i].stackId === null);
        currentScene = {
            clips: liveClips.length ? liveClips : [{ name: 'default', animationsOf: new Map(), morphAnimsByChannel: new Map(), duration: 0 }],
            currentClip: 0,
            entityById,
            baseTRSOf,
            morphMeshes,
        };
        selectInitialClip();
        rebuildClipGui(currentScene.clips);
        rebuildMorphsFolder(morphMeshes);
        const renderBounds = getRenderBounds(modelRoot) ?? bounds;
        frameModel(renderBounds);
        PARAMS.asset = selection;
        assetController?.updateDisplay();

        const duration = currentScene.clips[currentScene.currentClip]?.duration ?? 0;
        const skinNote = totalSkinnedMeshes ? ` - skinned meshes: ${totalSkinnedMeshes}` : '';
        const morphNote = totalMorphs ? ` - morphs: ${totalMorphs}` : '';
        setStatus(`${name} - triangles: ${totalTriangles}${duration ? ` - anim ${duration.toFixed(2)}s` : ''}${skinNote}${morphNote}`);
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`);
    } finally {
        isLoading = false;
    }
}

function buildClipStubs(objects, connsNode) {
    const stackById = new Map(findNodes(objects.children, 'AnimationStack').map(n => [n.props[0], n]));
    const layerInfoById = new Map();
    for (const layer of findNodes(objects.children, 'AnimationLayer')) {
        layerInfoById.set(layer.props[0], { stackId: null, acns: new Set() });
    }
    for (const c of connsNode.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (layerInfoById.has(fromId) && stackById.has(toId)) layerInfoById.get(fromId).stackId = toId;
    }
    for (const c of connsNode.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (layerInfoById.has(toId)) layerInfoById.get(toId).acns.add(fromId);
    }
    const clipStubs = [];
    for (const [stackId, stack] of stackById) {
        const acns = new Set();
        for (const { stackId: layerStackId, acns: layerAcns } of layerInfoById.values()) {
            if (layerStackId === stackId) for (const acn of layerAcns) acns.add(acn);
        }
        if (acns.size) clipStubs.push({ name: stripFbxName(stack.props[1]) || 'default', stackId, acns });
    }
    if (!clipStubs.length) clipStubs.push({ name: 'default', stackId: null, acns: null });
    return clipStubs;
}

function selectInitialClip() {
    if (!currentScene) return;
    const requested = getInitialClipName();
    if (requested) {
        const index = currentScene.clips.findIndex(clip => clip.name === requested);
        if (index >= 0) currentScene.currentClip = index;
    }
    PARAMS.time = getAnimationTime();
    PARAMS.animate = getAnimationEnabled();
}

function rebuildClipGui(clips) {
    if (!gui) return;
    if (clipController) {
        clipController.destroy();
        clipController = null;
    }
    if (timeController) {
        timeController.destroy();
        timeController = null;
    }
    if (!clips.length) return;

    const names = clips.map(clip => clip.name);
    PARAMS.clip = names[currentScene?.currentClip ?? 0] ?? '';
    if (names.length > 1) {
        clipController = gui.add(PARAMS, 'clip', names).name('clip').onChange(name => {
            const index = currentScene.clips.findIndex(clip => clip.name === name);
            if (index >= 0) {
                currentScene.currentClip = index;
                PARAMS.time = 0;
                updateTimeController();
            }
        });
    }
    timeController = gui.add(PARAMS, 'time', 0, Math.max(clips[currentScene?.currentClip ?? 0]?.duration ?? 0, 1), 0.01).name('time').listen();
}

function rebuildMorphsFolder(morphMeshes) {
    if (!gui) return;
    if (morphsFolder) {
        morphsFolder.destroy();
        morphsFolder = null;
    }

    const targets = morphMeshes.filter(mesh => mesh.morph?.channels.length > 0);
    if (!targets.length) return;

    morphsFolder = gui.addFolder('Morphs');
    for (const mesh of targets) {
        const meshFolder = morphsFolder.addFolder(mesh.modelName || `mesh_${mesh.modelId}`);
        for (const channel of mesh.morph.channels) {
            channel.weight = PARAMS.morph;
            meshFolder.add(channel, 'weight', 0, 1, 0.01).name(channel.name || 'channel').listen();
        }
    }
}

function updateTimeController() {
    if (!timeController || !currentScene) return;
    const duration = currentScene.clips[currentScene.currentClip]?.duration ?? 0;
    timeController.max(Math.max(duration, 1));
    PARAMS.clip = currentScene.clips[currentScene.currentClip]?.name ?? '';
    clipController?.updateDisplay();
}

function updateMorphWeights(clip) {
    const morphAnims = clip?.morphAnimsByChannel ?? new Map();
    for (const mesh of currentScene?.morphMeshes ?? []) {
        mesh.morph.channels.forEach((channel, index) => {
            const anim = morphAnims.get(channel.channelId);
            if (anim) channel.weight = sampleCurve(anim.curve, PARAMS.time, 0) / 100;
            for (const morphInstance of mesh.instances) {
                morphInstance.setWeight(index, channel.weight);
            }
        });
    }
}

function updateAnimation(dt) {
    if (!currentScene) return;
    const clip = currentScene.clips[currentScene.currentClip];
    if (PARAMS.animate && clip.duration) PARAMS.time = (PARAMS.time + dt) % clip.duration;
    for (const [id, entity] of currentScene.entityById) {
        const base = currentScene.baseTRSOf.get(id);
        if (!base) continue;
        setEntityTransform(entity, base, clip.animationsOf.get(id), PARAMS.time);
    }
    updateMorphWeights(clip);
}

function updateCamera() {
    const yaw = orbitYaw * Math.PI / 180;
    const pitch = orbitPitch * Math.PI / 180;
    const cp = Math.cos(pitch);
    const eye = new pc.Vec3(
        cameraTarget[0] + Math.sin(yaw) * cp * orbitDistance,
        cameraTarget[1] + Math.sin(pitch) * orbitDistance,
        cameraTarget[2] + Math.cos(yaw) * cp * orbitDistance,
    );
    camera.setPosition(eye);
    camera.lookAt(cameraTarget[0], cameraTarget[1], cameraTarget[2]);
}

function initCameraControls() {
    let mode = null;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('mousedown', event => {
        event.preventDefault();
        mode = event.button === 2 ? 'pan' : 'rotate';
        lastX = event.clientX;
        lastY = event.clientY;
    });
    window.addEventListener('mouseup', () => { mode = null; });
    window.addEventListener('mousemove', event => {
        if (!mode) return;
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        if (mode === 'rotate') {
            orbitYaw -= dx * 0.25;
            orbitPitch = Math.max(-85, Math.min(85, orbitPitch + dy * 0.25));
        } else {
            const scale = orbitDistance * 0.0015;
            const right = camera.right;
            const up = camera.up;
            cameraTarget[0] += (-dx * right.x + dy * up.x) * scale;
            cameraTarget[1] += (-dx * right.y + dy * up.y) * scale;
            cameraTarget[2] += (-dx * right.z + dy * up.z) * scale;
        }
        updateCamera();
    });
    canvas.addEventListener('wheel', event => {
        event.preventDefault();
        orbitDistance = Math.max(0.1, orbitDistance * (event.deltaY > 0 ? 1.1 : 1 / 1.1));
        updateCamera();
    }, { passive: false });
}

function initGui() {
    gui = new lil.GUI();
    assetController = gui.add(PARAMS, 'asset', getAssetOptions()).name('asset').onChange(loadModel);
    gui.add(PARAMS, 'animate').name('play');
    gui.add(PARAMS, 'rotate').name('rotate');
    gui.add(PARAMS, 'ground').name('ground').onChange(value => { ground.enabled = value; });
}

function initScene() {
    canvas = document.getElementById('c');
    app = new pc.Application(canvas);
    app.start();
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    window.addEventListener('resize', () => app.resizeCanvas(canvas.width, canvas.height));

    app.scene.ambientLight = new pc.Color(0.65, 0.65, 0.65);

    light = new pc.Entity('light');
    light.addComponent('light', {
        type: 'directional',
        color: new pc.Color(1, 1, 1),
        intensity: 1.6,
        castShadows: true,
        shadowResolution: 2048,
    });
    light.setLocalEulerAngles(45, 35, 25);
    app.root.addChild(light);

    camera = new pc.Entity('camera');
    camera.addComponent('camera', {
        clearColor: new pc.Color(0.627, 0.627, 0.627),
        nearClip: 0.1,
        farClip: 5000,
        fov: 45,
    });
    app.root.addChild(camera);
    updateCamera();

    const groundMat = createMaterial([0.72, 0.74, 0.76], null, false, false);
    groundMat.cull = pc.CULLFACE_BACK;
    groundMat.depthWrite = false;
    groundMat.update();
    ground = new pc.Entity('ground');
    ground.setLocalPosition(0, -1, 0);
    const groundMesh = createGroundMesh(2000);
    const groundMeshInstance = new pc.MeshInstance(groundMesh, groundMat, ground);
    groundMeshInstance.castShadow = false;
    groundMeshInstance.receiveShadow = true;
    ground.addComponent('render', { meshInstances: [groundMeshInstance] });
    ground.enabled = PARAMS.ground;
    app.root.addChild(ground);
}

async function main() {
    try {
        initScene();
        initCameraControls();
        initGui();
        app.on('update', dt => {
            if (PARAMS.rotate && modelRoot) modelRoot.rotate(0, 20 * dt, 0);
            updateAnimation(dt);
        });
        await loadModel(PARAMS.asset);
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`);
    }
}

main();