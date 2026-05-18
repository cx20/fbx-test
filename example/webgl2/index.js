// WebGL 2.0 + FBX viewer
//
// Same feature set as the WebGL 1.0 sample (multi-mesh, hierarchy animation,
// skinning, morph targets, multi-clip, per-polygon material colors), ported
// to WebGL 2.0 / GLSL ES 3.00. Uses VAOs to bind attributes once per mesh,
// and skips the OES_element_index_uint extension (Uint32 indices are core in
// WebGL 2).

(() => {

const { parseFBX, findNode, findNodes, prop0 } = window.FBXParser;
const { mat4, mat3, vec3 } = window.glMatrix;
const {
    ASSETS, FBX_BASE, MAX_BONES, MAX_MORPHS, SCALES, modelUrl, createParams,
    getProps70, eulerToMat4, makeLocalMatrix,
    getCurveData, sampleCurve, buildAnimation, buildMorphAnimation, sampleAnimation,
    buildMesh, buildSkinForGeometry, buildMorphForGeometry, getWorldMatrix,
} = window.FBXScene;

const PARAMS = createParams();
PARAMS.skeleton ??= /^(1|true|yes|on)$/i.test(new URLSearchParams(location.search).get('skeleton') ?? '');

// =====================================================================
// WebGL setup
// =====================================================================

let canvas, gl;
let program, attribs, uniforms;
let skeletonProgram, skeletonAttribs, skeletonUniforms;

function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
}

function createProgram(vsSource, fsSource) {
    const vs = createShader(gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog));
    }
    return prog;
}

function initGL() {
    canvas = document.querySelector('#c');
    gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL 2.0 is not supported by this browser.');

    program = createProgram(
        document.getElementById('vs').textContent,
        document.getElementById('fs').textContent,
    );
    attribs = {
        position:   gl.getAttribLocation(program, 'aPosition'),
        normal:     gl.getAttribLocation(program, 'aNormal'),
        color:      gl.getAttribLocation(program, 'aColor'),
        texCoord:   gl.getAttribLocation(program, 'aTexCoord'),
        boneIndex:  gl.getAttribLocation(program, 'aBoneIndex'),
        boneWeight: gl.getAttribLocation(program, 'aBoneWeight'),
        morph:      [
            gl.getAttribLocation(program, 'aMorph0'),
            gl.getAttribLocation(program, 'aMorph1'),
            gl.getAttribLocation(program, 'aMorph2'),
            gl.getAttribLocation(program, 'aMorph3'),
        ],
    };
    uniforms = {
        viewProj:        gl.getUniformLocation(program, 'uViewProj'),
        model:           gl.getUniformLocation(program, 'uModel'),
        normalMat:       gl.getUniformLocation(program, 'uNormalMat'),
        baseColor:       gl.getUniformLocation(program, 'uBaseColor'),
        lightDir:        gl.getUniformLocation(program, 'uLightDir'),
        ambient:         gl.getUniformLocation(program, 'uAmbient'),
        hasVertexColor:  gl.getUniformLocation(program, 'uHasVertexColor'),
        hasTexture:      gl.getUniformLocation(program, 'uHasTexture'),
        texture:         gl.getUniformLocation(program, 'uTexture'),
        skinned:         gl.getUniformLocation(program, 'uSkinned'),
        bones:           gl.getUniformLocation(program, 'uBones'),
        morphWeights:    gl.getUniformLocation(program, 'uMorphWeights'),
    };

    skeletonProgram = createProgram(
        '#version 300 es\nin vec3 aPosition; uniform mat4 uViewProj; void main() { gl_Position = uViewProj * vec4(aPosition, 1.0); }',
        '#version 300 es\nprecision mediump float; out vec4 fragColor; void main() { fragColor = vec4(1.0, 0.08, 0.04, 1.0); }',
    );
    skeletonAttribs = { position: gl.getAttribLocation(skeletonProgram, 'aPosition') };
    skeletonUniforms = { viewProj: gl.getUniformLocation(skeletonProgram, 'uViewProj') };

    gl.clearColor(0.627, 0.627, 0.627, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    // Uint32 element indices are core in WebGL 2 — no extension required.
}

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
}

// =====================================================================
// GPU upload (renderable mesh from common buildMesh → WebGL2 VAO)
// =====================================================================

// Upload a mesh and return a VAO that binds every attribute exactly once.
// Subsequent draws only need `gl.bindVertexArray(gpu.vao)` plus uniforms.
function uploadMesh(meshData) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    function uploadAttrib(loc, data, size) {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        if (loc >= 0) {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        }
        return buf;
    }

    uploadAttrib(attribs.position, meshData.positions, 3);
    uploadAttrib(attribs.normal,   meshData.normals,   3);
    uploadAttrib(attribs.color,    meshData.colors,    4);
    uploadAttrib(attribs.texCoord, meshData.uvs,       2);

    if (meshData.hasSkin) {
        uploadAttrib(attribs.boneIndex,  meshData.boneIndices, 4);
        uploadAttrib(attribs.boneWeight, meshData.boneWeights, 4);
    } else {
        // Disable the bone attribs in this VAO and use constant 0 so the
        // skinning branch is well-defined even though uSkinned is false.
        if (attribs.boneIndex  >= 0) { gl.disableVertexAttribArray(attribs.boneIndex);  gl.vertexAttrib4f(attribs.boneIndex,  0, 0, 0, 0); }
        if (attribs.boneWeight >= 0) { gl.disableVertexAttribArray(attribs.boneWeight); gl.vertexAttrib4f(attribs.boneWeight, 0, 0, 0, 0); }
    }

    for (let m = 0; m < MAX_MORPHS; m++) {
        const loc = attribs.morph[m];
        if (loc < 0) continue;
        if (m < meshData.morphs.length) {
            uploadAttrib(loc, meshData.morphs[m], 3);
        } else {
            gl.disableVertexAttribArray(loc);
            gl.vertexAttrib3f(loc, 0, 0, 0);
        }
    }

    // Uint32 indices are core in WebGL 2; still pick the smaller type for
    // meshes that fit, since smaller fetches usually win in the cache.
    const needU32 = meshData.positions.length / 3 > 65535;
    const idxData = needU32 ? new Uint32Array(meshData.indices) : new Uint16Array(meshData.indices);
    const idxType = needU32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const idxBytes = needU32 ? 4 : 2;

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxData, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    // Convert per-material offsets from index-units to byte-units for drawElements.
    const groups = meshData.groups.map(g => ({
        matIdx:    g.matIdx,
        byteOffset: g.offset * idxBytes,
        count:     g.count,
    }));

    return {
        vao, idxBuf, idxType,
        groups,
        hasVertexColor: meshData.hasVertexColor,
        hasUVs: meshData.hasUVs,
        hasSkin: meshData.hasSkin,
    };
}

// =====================================================================
// Texture loading
// =====================================================================

function createGLTexture(img) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
}

function loadTextureFromUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(createGLTexture(img));
        img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
        img.src = url;
    });
}

function loadTextureFromBytes(bytes) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    return loadTextureFromUrl(url).finally(() => URL.revokeObjectURL(url));
}

// Load a WebGL texture from a Video FBX node (embedded bytes or relative file path).
async function loadTextureFromVideo(vid, assetUrl) {
    const contentNode = findNode(vid.children, 'Content');
    if (contentNode && contentNode.props[0] instanceof ArrayBuffer) {
        return loadTextureFromBytes(contentNode.props[0]);
    }
    const relNode = findNode(vid.children, 'RelativeFilename');
    if (relNode && relNode.props[0]) {
        const base = assetUrl.substring(0, assetUrl.lastIndexOf('/') + 1);
        return loadTextureFromUrl(base + relNode.props[0].replace(/\\/g, '/'));
    }
    return null;
}

// =====================================================================
// Scene state
// =====================================================================

// scene = {
//   meshes:      [{ gpu, texture, modelId }],
//   parentOf:    Map<childId, parentId>,
//   modelById:   Map<id, modelNode>,
//   baseTRSOf:   Map<id, TRS>,
//   animationsOf:Map<id, animation>,
//   duration:    number,
//   modelName:   string,
// }
let scene = null;

const projection = mat4.create();
const view       = mat4.create();
const viewProj   = mat4.create();
const cameraEye    = vec3.fromValues(220, 220, 320);
const cameraTarget = vec3.fromValues(0, 50, 0);
const cameraUp     = vec3.fromValues(0, 1, 0);

// Camera controls live in example/common/orbit-controls.js and are wired up
// in main() after the canvas has been created.

function buildSkeletonSegments(skins, parentOf) {
    const segments = [];
    const seen = new Set();
    const seenSkins = new Set();

    for (const skin of skins) {
        const skinKey = skin.boneModelIds.join('|');
        if (seenSkins.has(skinKey)) continue;
        seenSkins.add(skinKey);

        const boneIds = new Set(skin.boneModelIds);
        for (const boneId of skin.boneModelIds) {
            let parentId = parentOf.get(boneId);
            while (parentId !== undefined && !boneIds.has(parentId)) parentId = parentOf.get(parentId);
            if (parentId === undefined) continue;

            const key = `${parentId}:${boneId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            segments.push({ parentId, childId: boneId });
        }
    }

    return segments;
}

function createSkeletonGpu(segments) {
    if (!segments.length) return null;
    const positions = new Float32Array(segments.length * 6);
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(skeletonAttribs.position);
    gl.vertexAttribPointer(skeletonAttribs.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { segments, positions, vao, buffer };
}

function updateSkeletonGpu() {
    const skeleton = scene?.skeleton;
    if (!skeleton || !PARAMS.skeleton) return;

    for (let i = 0; i < skeleton.segments.length; i++) {
        const segment = skeleton.segments[i];
        const parentWorld = getWorldMatrix(segment.parentId, PARAMS.time, scene);
        const childWorld = getWorldMatrix(segment.childId, PARAMS.time, scene);
        const offset = i * 6;
        skeleton.positions[offset] = parentWorld[12] * scene.scale;
        skeleton.positions[offset + 1] = parentWorld[13] * scene.scale;
        skeleton.positions[offset + 2] = parentWorld[14] * scene.scale;
        skeleton.positions[offset + 3] = childWorld[12] * scene.scale;
        skeleton.positions[offset + 4] = childWorld[13] * scene.scale;
        skeleton.positions[offset + 5] = childWorld[14] * scene.scale;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, skeleton.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, skeleton.positions);
}

function renderSkeleton() {
    const skeleton = scene?.skeleton;
    if (!skeleton || !PARAMS.skeleton) return;

    updateSkeletonGpu();
    gl.useProgram(skeletonProgram);
    gl.uniformMatrix4fv(skeletonUniforms.viewProj, false, viewProj);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(skeleton.vao);
    gl.drawArrays(gl.LINES, 0, skeleton.segments.length * 2);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
}

async function loadModel(name) {
    if (!ASSETS.includes(name)) return;
    setStatus(`Loading ${name} ...`);

    const url = modelUrl(name);
    const buffer = await fetch(url).then(r => r.arrayBuffer());
    const { nodes } = await parseFBX(buffer);

    const objects   = findNode(nodes, 'Objects');
    const connsNode = findNode(nodes, 'Connections');
    if (!objects || !connsNode) { setStatus(`Error: missing Objects/Connections in ${name}`); return; }

    // Build object maps by ID
    const geoById = new Map(findNodes(objects.children, 'Geometry').map(n => [n.props[0], n]));
    const modelById = new Map(findNodes(objects.children, 'Model').map(n => [n.props[0], n]));
    const matById   = new Map(findNodes(objects.children, 'Material').map(n => [n.props[0], n]));
    const texById   = new Map(findNodes(objects.children, 'Texture').map(n => [n.props[0], n]));
    const vidById   = new Map(findNodes(objects.children, 'Video').map(n => [n.props[0], n]));
    const deformerById = new Map(findNodes(objects.children, 'Deformer').map(n => [n.props[0], n]));

    // Build connection maps
    const parentOf   = new Map();           // OO childModelId → parentModelId (scene graph)
    const reverseConns = new Map();         // toId → [fromId] (for texture/skin lookup)
    for (const c of connsNode.children) {
        if (c.name !== 'C') continue;
        const fromId = c.props[1];
        const toId   = c.props[2];
        // Only Model→Model OO connections form the scene-graph parent chain.
        // (A LimbNode also has OO connections to its Cluster sub-deformer; those
        // would clobber the real parent if we set parentOf indiscriminately.)
        if (c.props[0] === 'OO' && modelById.has(fromId) && modelById.has(toId)) {
            parentOf.set(fromId, toId);
        }
        if (!reverseConns.has(toId)) reverseConns.set(toId, []);
        reverseConns.get(toId).push(fromId);
    }

    // Find all Geometry→Model pairs
    const meshPairs = [];
    for (const c of connsNode.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (geoById.has(fromId) && modelById.has(toId)) {
            meshPairs.push({ geoNode: geoById.get(fromId), modelId: toId });
        }
    }
    if (meshPairs.length === 0) { setStatus(`Error: no Geometry in ${name}`); return; }

    // Per-model base TRS (including geometric transforms)
    const baseTRSOf = new Map();
    for (const [id, m] of modelById) baseTRSOf.set(id, getProps70(m));

    // ---- Animation clips ----
    // Each AnimationStack is one clip. Layers under it carry the ACNs; many
    // FBX files use a single layer per stack, but we union them all just in
    // case. ACN-less stacks (e.g. an empty "Take 001" stub) are dropped.
    const stackById = new Map(findNodes(objects.children, 'AnimationStack').map(n => [n.props[0], n]));
    const layerInfoById = new Map();
    for (const layer of findNodes(objects.children, 'AnimationLayer')) {
        layerInfoById.set(layer.props[0], { stackId: null, acns: new Set() });
    }
    for (const c of connsNode.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (layerInfoById.has(fromId) && stackById.has(toId)) {
            layerInfoById.get(fromId).stackId = toId;
        }
    }
    for (const c of connsNode.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (layerInfoById.has(toId)) layerInfoById.get(toId).acns.add(fromId);
    }

    const stripFbxTag = s => {
        const i = (s ?? '').indexOf('\x00');
        return i >= 0 ? s.slice(0, i) : (s ?? '');
    };

    const clipStubs = []; // { name, stackId, acns: Set }
    for (const [stackId, stack] of stackById) {
        const acns = new Set();
        for (const { stackId: lsid, acns: lacns } of layerInfoById.values()) {
            if (lsid === stackId) for (const a of lacns) acns.add(a);
        }
        if (acns.size === 0) continue;
        clipStubs.push({ name: stripFbxTag(stack.props[1]), stackId, acns });
    }
    // Fallback: no clean stacks → one "global" clip containing every ACN
    // (covers files without AnimationStack/Layer structure).
    if (clipStubs.length === 0) {
        clipStubs.push({ name: 'default', stackId: null, acns: null });
    }

    // Per-clip per-model TRS animations.
    const clips = clipStubs.map(stub => {
        const animationsOf = new Map();
        for (const [id] of modelById) {
            const anim = buildAnimation(nodes, id, stub.acns);
            if (anim) animationsOf.set(id, anim);
        }
        let duration = 0;
        for (const a of animationsOf.values()) duration = Math.max(duration, a.duration);
        return { name: stub.name, animationsOf, morphAnimsByChannel: new Map(), duration };
    });

    // Trace Material→Texture→Video to find the Video node for one material.
    // Used to load per-material textures so meshes with multi-material textures
    // (e.g. morph-translation's paillottes, paillotte.png + paillotte extremite.png)
    // can render each material's polygons with the matching texture.
    function findVideoForMaterial(matId) {
        for (const texId of reverseConns.get(matId) ?? []) {
            if (!texById.has(texId)) continue;
            for (const vidId of reverseConns.get(texId) ?? []) {
                if (vidById.has(vidId)) return vidById.get(vidId);
            }
        }
        return null;
    }

    // Extract DiffuseColor (× DiffuseFactor) from a single Material node.
    function readMaterialColor(matNode) {
        const p70 = findNode(matNode.children, 'Properties70');
        if (!p70) return null;
        let diffuse = null, factor = 1;
        for (const p of p70.children) {
            if (p.name !== 'P' || !p.props) continue;
            const k = p.props[0];
            if ((k === 'DiffuseColor' || k === 'Diffuse') && p.props.length > 6) {
                diffuse = [p.props[4], p.props[5], p.props[6]];
            } else if (k === 'DiffuseFactor' && p.props.length > 4) {
                factor = p.props[4];
            }
        }
        if (!diffuse) return null;
        return [diffuse[0] * factor, diffuse[1] * factor, diffuse[2] * factor];
    }

    // Ordered list of Materials connected to a Model (in OO-connection order).
    // The per-polygon `LayerElementMaterial.Materials` array indexes into this.
    function findMaterialsForModel(modelId) {
        const mats = [];
        for (const matId of reverseConns.get(modelId) ?? []) {
            if (matById.has(matId)) mats.push(matById.get(matId));
        }
        return mats;
    }

    // Build GPU objects for each mesh
    const meshes = [];
    let totalTriangles = 0;
    let totalBones = 0;
    let totalMorphs = 0;
    const skins = [];
    for (const { geoNode, modelId } of meshPairs) {
        const verts = prop0(findNode(geoNode.children, 'Vertices'));
        const vertexCount = verts ? verts.length / 3 : 0;
        const skin = buildSkinForGeometry(geoNode, vertexCount, connsNode, deformerById, modelById);
        const morph = buildMorphForGeometry(geoNode, vertexCount, connsNode, geoById, deformerById);
        // Attach a per-channel DeformPercent curve to each clip if present.
        if (morph) {
            for (const ch of morph.channels) {
                for (let i = 0; i < clipStubs.length; i++) {
                    const anim = buildMorphAnimation(nodes, ch.channelId, clipStubs[i].acns);
                    if (anim) {
                        clips[i].morphAnimsByChannel.set(ch.channelId, anim);
                        clips[i].duration = Math.max(clips[i].duration, anim.duration);
                    }
                }
            }
        }
        const morphDeltas = morph ? morph.channels.map(ch => ch.deltas) : null;
        const matsForModel = findMaterialsForModel(modelId);
        const matColors = matsForModel.map(m => readMaterialColor(m) ?? [1, 1, 1]);
        const baseTRS = baseTRSOf.get(modelId);
        const geoXform = baseTRS ? { T: baseTRS.geoT, R: baseTRS.geoR, S: baseTRS.geoS } : null;
        const meshData = buildMesh(geoNode, skin, morphDeltas, matColors, geoXform);
        if (!meshData) continue;
        const gpu = uploadMesh(meshData);
        // Load per-material textures so the render loop can bind the right one
        // for each draw call. matsForModel[i] aligns with the matIdx in
        // meshData.groups; null entries mean "no texture, fall back to baseColor".
        const matTextures = await Promise.all(matsForModel.map(async (mat) => {
            if (!meshData.hasUVs) return null;
            const vid = findVideoForMaterial(mat.props[0]);
            if (!vid) return null;
            try { return await loadTextureFromVideo(vid, url); }
            catch (e) { console.warn('Texture load failed:', e); return null; }
        }));
        // Display name for the mesh (used by the per-channel morph GUI).
        const rawModelName = modelById.get(modelId)?.props[1] ?? '';
        const sep = rawModelName.indexOf('\x00');
        const modelName = sep >= 0 ? rawModelName.slice(0, sep) : rawModelName;
        meshes.push({ gpu, matColors, matTextures, modelId, modelName, skin, morph });
        if (skin) skins.push(skin);
        totalTriangles += meshData.triangleCount;
        if (skin) totalBones += skin.boneModelIds.length;
        if (morph) totalMorphs += morph.channels.length;
    }

    // Drop clips that ended up with no curves at all (e.g. a stub stack).
    const liveClips = clips.filter((c, i) =>
        c.animationsOf.size > 0 || c.morphAnimsByChannel.size > 0 || clipStubs[i].stackId === null);
    const sceneClips = liveClips.length ? liveClips : [{ name: 'default', animationsOf: new Map(), morphAnimsByChannel: new Map(), duration: 0 }];

    const scale = SCALES.get(name) ?? 1;
    scene = {
        meshes, parentOf, modelById, baseTRSOf,
        clips: sceneClips, currentClip: 0,
        modelName: name, scale,
        skeleton: createSkeletonGpu(buildSkeletonSegments(skins, parentOf)),
    };
    const skinNote  = totalBones  ? ` — bones: ${totalBones}`   : '';
    const morphNote = totalMorphs ? ` — morphs: ${totalMorphs}` : '';
    const clipNote  = sceneClips.length > 1 ? ` — clips: ${sceneClips.length}` : '';
    const dur = sceneClips[0]?.duration ?? 0;
    setStatus(`${name} — triangles: ${totalTriangles}${dur ? ` — anim ${dur.toFixed(2)}s` : ''}${skinNote}${morphNote}${clipNote}`);
    updateMorphGui(meshes);
    updateClipGui(sceneClips);
    updateTimeRange();
}

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

// =====================================================================
// Render loop
// =====================================================================

function render(timeMs) {
    const currentDuration = scene?.clips[scene.currentClip]?.duration ?? 0;
    if (PARAMS.animate && currentDuration) {
        PARAMS.time = (timeMs / 1000) % currentDuration;
    }

    resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (!scene || scene.meshes.length === 0) {
        requestAnimationFrame(render);
        return;
    }

    const aspect = canvas.width / canvas.height;
    mat4.perspective(projection, 45 * Math.PI / 180, aspect, 1, 2000);
    mat4.lookAt(view, cameraEye, cameraTarget, cameraUp);
    mat4.multiply(viewProj, projection, view);

    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.viewProj, false, viewProj);
    gl.uniform3f(uniforms.lightDir, 0.3, 1.0, 0.5);
    gl.uniform1f(uniforms.ambient, 0.25);
    gl.uniform1i(uniforms.texture, 0);

    const scaleMat = scene.scale !== 1 ? mat4.fromScaling(mat4.create(), [scene.scale, scene.scale, scene.scale]) : null;
    for (const mesh of scene.meshes) {
        const isSkinned = !!mesh.skin;

        // Non-skinned: world matrix from mesh's own node hierarchy + scale.
        // Skinned:     bind matrices baked into bone palette, so uModel is identity.
        const model = mat4.create();
        if (!isSkinned) {
            mat4.copy(model, getWorldMatrix(mesh.modelId, PARAMS.time, scene));
            if (scaleMat) mat4.multiply(model, scaleMat, model);
        }
        const normalMat = mat3.create();
        mat3.normalFromMat4(normalMat, model);

        gl.uniformMatrix4fv(uniforms.model,    false, model);
        gl.uniformMatrix3fv(uniforms.normalMat, false, normalMat);
        gl.uniform1i(uniforms.hasVertexColor, mesh.gpu.hasVertexColor ? 1 : 0);
        gl.uniform1i(uniforms.skinned, isSkinned ? 1 : 0);

        if (isSkinned) {
            const bones = new Float32Array(MAX_BONES * 16);
            const scaleM = scene.scale !== 1
                ? mat4.fromScaling(mat4.create(), [scene.scale, scene.scale, scene.scale])
                : null;
            for (let i = 0; i < mesh.skin.boneModelIds.length; i++) {
                const boneWorld = getWorldMatrix(mesh.skin.boneModelIds[i], PARAMS.time, scene);
                const skinMat = mat4.create();
                mat4.multiply(skinMat, boneWorld, mesh.skin.bindInverses[i]);
                if (scaleM) mat4.multiply(skinMat, scaleM, skinMat);
                bones.set(skinMat, i * 16);
            }
            // Fill remaining slots with identity so unused indices don't blow up.
            for (let i = mesh.skin.boneModelIds.length; i < MAX_BONES; i++) {
                bones.set(mat4.create(), i * 16);
            }
            gl.uniformMatrix4fv(uniforms.bones, false, bones);
        }

        // Per-channel morph weights — attribute bindings were baked into the
        // VAO at upload time, so we only set the uniform here.
        const morphChannels = mesh.morph?.channels ?? [];
        const morphAnims = scene.clips[scene.currentClip]?.morphAnimsByChannel ?? new Map();
        const morphWeights = [0, 0, 0, 0];
        for (let m = 0; m < Math.min(MAX_MORPHS, morphChannels.length); m++) {
            const ch = morphChannels[m];
            const anim = morphAnims.get(ch.channelId);
            // Animated DeformPercent (0..100) if the current clip animates
            // this channel, else the per-channel slider value.
            morphWeights[m] = anim ? sampleCurve(anim.curve, PARAMS.time, 0) / 100 : ch.weight;
        }
        gl.uniform4f(uniforms.morphWeights, morphWeights[0], morphWeights[1], morphWeights[2], morphWeights[3]);

        gl.bindVertexArray(mesh.gpu.vao);
        // One draw call per material group. Each group rebinds the matching
        // baseColor / texture so multi-material meshes (e.g. morph-translation's
        // paillottes split between paillotte.png and paillotte_extremite.png)
        // render with the right art per polygon.
        for (const g of mesh.gpu.groups) {
            const bc = mesh.matColors[g.matIdx];
            gl.uniform4f(uniforms.baseColor,
                bc ? bc[0] : 0.85,
                bc ? bc[1] : 0.85,
                bc ? bc[2] : 0.9,
                1.0);
            const tex = mesh.matTextures[g.matIdx];
            const hasTexture = !!(tex && mesh.gpu.hasUVs);
            gl.uniform1i(uniforms.hasTexture, hasTexture ? 1 : 0);
            if (hasTexture) {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, tex);
            }
            gl.drawElements(gl.TRIANGLES, g.count, mesh.gpu.idxType, g.byteOffset);
        }
    }
    gl.bindVertexArray(null);
    renderSkeleton();

    requestAnimationFrame(render);
}

// =====================================================================
// GUI
// =====================================================================

let gui = null;
let clipCtrl = null;
let timeCtrl = null;
let morphsFolder = null;
const CLIP_PARAM = { clip: '' };

function initGui() {
    gui = new lil.GUI();
    gui.add(PARAMS, 'asset', ASSETS).name('asset').onChange(loadModel);
    // Same order as the Three.js viewer's Animation folder: clip → play → time.
    clipCtrl = gui.add(CLIP_PARAM, 'clip', ['']).name('clip').onChange(name => {
        if (!scene) return;
        const idx = scene.clips.findIndex(c => c.name === name);
        if (idx >= 0) {
            scene.currentClip = idx;
            PARAMS.time = 0;
            updateTimeRange();
        }
    });
    clipCtrl.hide();
    gui.add(PARAMS, 'animate').name('play');
    gui.add(PARAMS, 'skeleton').name('skeleton');
    // Time scrubber. Updates automatically via .listen() while playing; when
    // `play` is off, dragging the slider seeks to that time (the render loop
    // only overwrites PARAMS.time when PARAMS.animate is true).
    timeCtrl = gui.add(PARAMS, 'time', 0, 1, 0.01).name('time').listen();
}

// Resync the time slider's max to the current clip's duration. Called from
// loadModel (after the scene is set) and from the clip dropdown's onChange.
function updateTimeRange() {
    if (!timeCtrl) return;
    const dur = scene?.clips[scene.currentClip]?.duration ?? 0;
    timeCtrl.max(dur > 0 ? dur : 1);
}

// Rebuild the "Morphs" folder from the loaded scene's meshes. One subfolder
// per mesh that has BlendShape channels, with one slider per channel — the
// same layout the Babylon viewer uses. The folder is destroyed and rebuilt
// each load so switching to a non-morph model leaves the panel clean.
function updateMorphGui(meshes) {
    if (!gui) return;
    if (morphsFolder) {
        morphsFolder.destroy();
        morphsFolder = null;
    }
    const morphMeshes = meshes.filter(m => m.morph && m.morph.channels.length > 0);
    if (morphMeshes.length === 0) return;

    morphsFolder = gui.addFolder('Morphs');
    for (const mesh of morphMeshes) {
        const sub = morphsFolder.addFolder(mesh.modelName || `mesh_${mesh.modelId}`);
        for (const ch of mesh.morph.channels) {
            // Initialize to PARAMS.morph (lets `?morph=` URL preset all channels).
            ch.weight = PARAMS.morph;
            sub.add(ch, 'weight', 0, 1, 0.01).name(ch.name || 'channel');
        }
    }
}

// Repopulate the clip dropdown with the loaded scene's clip names. The
// dropdown only shows when there's more than one named clip — single-clip
// models keep the panel uncluttered.
//
// If `?clip=<name>` was provided on the URL, that clip becomes the initial
// selection (honored only on the first load; subsequent loadModel calls fall
// back to the first clip).
function updateClipGui(clips) {
    if (!clipCtrl) return;
    const names = clips.map(c => c.name);

    let initialIdx = 0;
    if (PARAMS.clip) {
        const requested = names.indexOf(PARAMS.clip);
        if (requested >= 0) initialIdx = requested;
        PARAMS.clip = null; // honor only on first load
    }
    if (scene) scene.currentClip = initialIdx;
    CLIP_PARAM.clip = names[initialIdx] ?? '';

    // lil-gui requires rebuilding the <option> list via the .options() method.
    clipCtrl = clipCtrl.options(names);
    clipCtrl.onChange(name => {
        if (!scene) return;
        const idx = scene.clips.findIndex(c => c.name === name);
        if (idx >= 0) {
            scene.currentClip = idx;
            PARAMS.time = 0;
            updateTimeRange();
        }
    });
    if (names.length > 1) clipCtrl.show();
    else clipCtrl.hide();
}

// =====================================================================
// Boot
// =====================================================================

async function main() {
    try {
        initGL();
        OrbitControls.create({ canvas, cameraEye, cameraTarget, cameraUp, vec3 });
        initGui();
        window.addEventListener('resize', resize);
        await loadModel(PARAMS.asset);
        requestAnimationFrame(render);
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`);
    }
}

main();

})();
