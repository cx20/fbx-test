// WebGPU + FBX viewer
//
// Same feature set as the WebGL 1.0 / 2.0 samples (multi-mesh, hierarchy
// animation, skinning, morph targets, multi-clip, per-polygon material
// colors), ported to WebGPU. One render pipeline; per-mesh uniform buffer
// + bind group holding matrices, flags, morph weights, the bone palette,
// the diffuse texture (or a 1×1 white fallback) and a sampler.

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

// =====================================================================
// WebGPU setup
// =====================================================================

let canvas, ctx, device, adapter;
let pipeline, meshBindGroupLayout, matBindGroupLayout, sampler;
let depthTexture = null;
let dummyTexture; // 1x1 white texture used as the diffuse for non-textured meshes
let presentationFormat;

// Per-mesh uniform buffer layout matches the WGSL `MeshUniforms` struct.
//   viewProj     (mat4 = 16 floats)
//   model        (mat4 = 16 floats)
//   normalMat    (mat4 = 16 floats)
//   lightDir     (vec4 = 4 floats)
//   ambient      (vec4 = 4 floats)
//   morphWeights (vec4 = 4 floats)
//   flags        (vec4u = 4 u32) — same 16 bytes; written through Uint32 view
//   bones        (array<mat4, 64> = 64 * 16 floats)
const U_FLOAT_COUNT = 16 + 16 + 16 + 4 + 4 + 4 + 4 + 64 * 16;
const U_BYTES = U_FLOAT_COUNT * 4;
const U_OFF = {
    viewProj:     0,
    model:        16,
    normalMat:    32,
    lightDir:     48,
    ambient:      52,
    morphWeights: 56,
    flags:        60,
    bones:        64,
};

// Per-material uniform buffer layout matches the WGSL `MaterialUniforms` struct.
//   baseColor (vec4 = 4 floats)
//   flags     (vec4u = 4 u32) — written through Uint32 view
const MAT_U_FLOAT_COUNT = 4 + 4;
const MAT_U_BYTES = MAT_U_FLOAT_COUNT * 4;
const MAT_U_OFF = {
    baseColor: 0,
    flags:     4,
};

async function initWebGPU() {
    canvas = document.querySelector('#c');
    if (!navigator.gpu) throw new Error('WebGPU is not supported by this browser.');
    adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('navigator.gpu.requestAdapter returned null.');
    device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', e => console.error('WebGPU:', e.error.message));
    ctx = canvas.getContext('webgpu');
    presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

    const code = document.getElementById('wgsl').textContent;
    const shaderModule = device.createShaderModule({ code });

    meshBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
    });
    matBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
    });

    // WebGPU guarantees only 8 vertex buffer slots, so pack:
    //   slot 4: boneIndex + boneWeight  (stride 32, two vec4 attribs)
    //   slot 7: morph2     + morph3     (stride 24, two vec3 attribs)
    const vb1 = (loc, stride, format) => ({
        arrayStride: stride,
        attributes: [{ shaderLocation: loc, offset: 0, format }],
    });
    const vb2 = (loc0, loc1, stride, fmt0, fmt1, off1) => ({
        arrayStride: stride,
        attributes: [
            { shaderLocation: loc0, offset: 0,    format: fmt0 },
            { shaderLocation: loc1, offset: off1, format: fmt1 },
        ],
    });
    pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [meshBindGroupLayout, matBindGroupLayout] }),
        vertex: {
            module: shaderModule,
            entryPoint: 'vsMain',
            buffers: [
                vb1(0, 12, 'float32x3'),                              // position
                vb1(1, 12, 'float32x3'),                              // normal
                vb1(2, 16, 'float32x4'),                              // color
                vb1(3, 8,  'float32x2'),                              // texCoord
                vb2(4, 5, 32, 'float32x4', 'float32x4', 16),          // boneIndex + boneWeight
                vb1(6, 12, 'float32x3'),                              // morph0
                vb1(7, 12, 'float32x3'),                              // morph1
                vb2(8, 9, 24, 'float32x3', 'float32x3', 12),          // morph2 + morph3
            ],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fsMain',
            targets: [{ format: presentationFormat }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

    dummyTexture = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: dummyTexture }, new Uint8Array([255, 255, 255, 255]), {}, { width: 1, height: 1 });
}

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
    if (depthTexture) depthTexture.destroy();
    depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
}

// =====================================================================
// GPU upload (renderable mesh from common buildMesh → WebGPU buffers)
// =====================================================================

// Upload a mesh's vertex/index data + create the per-mesh uniform buffer and
// bind group. Per-material bind groups (with each material's texture) are
// built later in loadModel once the FBX textures have been resolved.
function uploadMesh(meshData) {
    function makeVB(data) {
        const buf = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buf, 0, data);
        return buf;
    }
    function zeroVB(byteCount) {
        const buf = device.createBuffer({ size: byteCount, usage: GPUBufferUsage.VERTEX });
        return buf;
    }
    const vertexCount = meshData.positions.length / 3;

    // Interleave boneIndex[4] + boneWeight[4] into one 8-float-stride buffer.
    function interleaveBones() {
        const out = new Float32Array(vertexCount * 8);
        if (meshData.hasSkin) {
            for (let i = 0; i < vertexCount; i++) {
                out[i * 8    ] = meshData.boneIndices[i * 4    ];
                out[i * 8 + 1] = meshData.boneIndices[i * 4 + 1];
                out[i * 8 + 2] = meshData.boneIndices[i * 4 + 2];
                out[i * 8 + 3] = meshData.boneIndices[i * 4 + 3];
                out[i * 8 + 4] = meshData.boneWeights[i * 4    ];
                out[i * 8 + 5] = meshData.boneWeights[i * 4 + 1];
                out[i * 8 + 6] = meshData.boneWeights[i * 4 + 2];
                out[i * 8 + 7] = meshData.boneWeights[i * 4 + 3];
            }
        }
        return out;
    }
    // Interleave morph[a] + morph[b] (each vec3) into one 6-float-stride buffer.
    function interleaveMorphPair(a, b) {
        const out = new Float32Array(vertexCount * 6);
        const ma = a < meshData.morphs.length ? meshData.morphs[a] : null;
        const mb = b < meshData.morphs.length ? meshData.morphs[b] : null;
        for (let i = 0; i < vertexCount; i++) {
            if (ma) {
                out[i * 6    ] = ma[i * 3    ];
                out[i * 6 + 1] = ma[i * 3 + 1];
                out[i * 6 + 2] = ma[i * 3 + 2];
            }
            if (mb) {
                out[i * 6 + 3] = mb[i * 3    ];
                out[i * 6 + 4] = mb[i * 3 + 1];
                out[i * 6 + 5] = mb[i * 3 + 2];
            }
        }
        return out;
    }

    const vb = [
        makeVB(meshData.positions),  // 0 position
        makeVB(meshData.normals),    // 1 normal
        makeVB(meshData.colors),     // 2 color
        makeVB(meshData.uvs),        // 3 texCoord
        makeVB(interleaveBones()),   // 4 boneIndex(+0) + boneWeight(+16)
        makeVB(meshData.morphs[0] ?? new Float32Array(vertexCount * 3)), // 6 morph0
        makeVB(meshData.morphs[1] ?? new Float32Array(vertexCount * 3)), // 7 morph1
        makeVB(interleaveMorphPair(2, 3)),                               // 8 morph2(+0) + morph3(+12)
    ];

    // Uint32 indices are first-class in WebGPU; still pick u16 when possible.
    // WebGPU buffer sizes (and writeBuffer payloads) must be multiples of 4
    // bytes, so pad an odd-count Uint16 buffer to the next u16 (the extra
    // index is never referenced because we draw exactly `count` indices).
    const needU32 = vertexCount > 65535;
    const idxCount = meshData.indices.length;
    let idxData;
    if (needU32) {
        idxData = new Uint32Array(meshData.indices);
    } else {
        const padded = (idxCount + 1) & ~1;
        idxData = new Uint16Array(padded);
        for (let i = 0; i < idxCount; i++) idxData[i] = meshData.indices[i];
    }
    const idxBuf = device.createBuffer({
        size: idxData.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(idxBuf, 0, idxData);

    const uniformBuf = device.createBuffer({
        size: U_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const meshBindGroup = device.createBindGroup({
        layout: meshBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
        ],
    });

    return {
        vb, idxBuf, idxFormat: needU32 ? 'uint32' : 'uint16',
        groups: meshData.groups, // [{ matIdx, offset, count }]
        uniformBuf, meshBindGroup,
        hasVertexColor: meshData.hasVertexColor,
        hasUVs: meshData.hasUVs,
        hasSkin: meshData.hasSkin,
    };
}

// =====================================================================
// Texture loading
// =====================================================================

async function createGPUTexture(img) {
    const tex = device.createTexture({
        size: [img.width, img.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
        { source: img, flipY: false },
        { texture: tex },
        [img.width, img.height],
    );
    return tex;
}

async function loadTextureFromUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load texture: ${url}`);
    const bitmap = await createImageBitmap(await res.blob());
    return createGPUTexture(bitmap);
}

async function loadTextureFromBytes(bytes) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    return createGPUTexture(bitmap);
}

// Load a GPU texture from a Video FBX node (embedded bytes or relative file path).
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
        // Load per-material textures so each draw call can bind the matching
        // art. matsForModel[i] aligns with the matIdx in meshData.groups; null
        // entries mean "no texture, fall back to baseColor".
        const matTextures = await Promise.all(matsForModel.map(async (mat) => {
            if (!meshData.hasUVs) return null;
            const vid = findVideoForMaterial(mat.props[0]);
            if (!vid) return null;
            try { return await loadTextureFromVideo(vid, url); }
            catch (e) { console.warn('Texture load failed:', e); return null; }
        }));
        // Build a per-material uniform buffer + bind group for each material
        // index actually referenced by the geometry (one per group). Material
        // colors and texture-presence are static after load, so we fill the
        // uniform buffer here once instead of every frame.
        const matBindings = gpu.groups.map(g => {
            const buf = device.createBuffer({
                size: MAT_U_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            const tex = matTextures[g.matIdx] ?? dummyTexture;
            const bindGroup = device.createBindGroup({
                layout: matBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: buf } },
                    { binding: 1, resource: tex.createView() },
                    { binding: 2, resource: sampler },
                ],
            });
            const bc = matColors[g.matIdx];
            const data = new Float32Array(MAT_U_FLOAT_COUNT);
            const flags = new Uint32Array(data.buffer);
            data[MAT_U_OFF.baseColor    ] = bc ? bc[0] : 0.85;
            data[MAT_U_OFF.baseColor + 1] = bc ? bc[1] : 0.85;
            data[MAT_U_OFF.baseColor + 2] = bc ? bc[2] : 0.9;
            data[MAT_U_OFF.baseColor + 3] = 1.0;
            flags[MAT_U_OFF.flags    ] = matTextures[g.matIdx] ? 1 : 0;
            flags[MAT_U_OFF.flags + 1] = 0;
            flags[MAT_U_OFF.flags + 2] = 0;
            flags[MAT_U_OFF.flags + 3] = 0;
            device.queue.writeBuffer(buf, 0, data);
            return { matIdx: g.matIdx, bindGroup };
        });
        // Display name for the mesh (used by the per-channel morph GUI).
        const rawModelName = modelById.get(modelId)?.props[1] ?? '';
        const sep = rawModelName.indexOf('\x00');
        const modelName = sep >= 0 ? rawModelName.slice(0, sep) : rawModelName;
        meshes.push({ gpu, matColors, matBindings, modelId, modelName, skin, morph });
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

// Scratch Float32Array for the per-mesh uniform buffer; reused every frame
// to avoid garbage. The matching Uint32 view is for the `flags` slot.
const U_DATA  = new Float32Array(U_FLOAT_COUNT);
const U_FLAGS = new Uint32Array(U_DATA.buffer);

function render(timeMs) {
    const currentDuration = scene?.clips[scene.currentClip]?.duration ?? 0;
    if (PARAMS.animate && currentDuration) {
        PARAMS.time = (timeMs / 1000) % currentDuration;
    }

    resize();

    if (!scene || scene.meshes.length === 0) {
        // Still need a render pass to clear the canvas.
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view: ctx.getCurrentTexture().createView(),
                clearValue: { r: 0.627, g: 0.627, b: 0.627, a: 1 },
                loadOp: 'clear', storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthTexture.createView(),
                depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
            },
        });
        pass.end();
        device.queue.submit([enc.finish()]);
        requestAnimationFrame(render);
        return;
    }

    const aspect = canvas.width / canvas.height;
    // WebGPU's clip-space Z is [0, 1] (vs. WebGL's [-1, 1]), so use perspectiveZO.
    mat4.perspectiveZO(projection, 45 * Math.PI / 180, aspect, 1, 2000);
    mat4.lookAt(view, cameraEye, cameraTarget, cameraUp);
    mat4.multiply(viewProj, projection, view);

    const scaleMat = scene.scale !== 1 ? mat4.fromScaling(mat4.create(), [scene.scale, scene.scale, scene.scale]) : null;
    const tmpNormal3 = mat3.create();

    for (const mesh of scene.meshes) {
        const isSkinned = !!mesh.skin;

        // Non-skinned: world matrix from mesh's own node hierarchy + scale.
        // Skinned:     bind matrices baked into bone palette, so model is identity.
        const model = mat4.create();
        if (!isSkinned) {
            mat4.copy(model, getWorldMatrix(mesh.modelId, PARAMS.time, scene));
            if (scaleMat) mat4.multiply(model, scaleMat, model);
        }
        mat3.normalFromMat4(tmpNormal3, model);

        // ---- Fill the per-mesh uniform buffer ----
        U_DATA.set(viewProj, U_OFF.viewProj);
        U_DATA.set(model,    U_OFF.model);
        // Repack mat3 -> mat4 (drop translation row, last column zero).
        U_DATA.fill(0, U_OFF.normalMat, U_OFF.normalMat + 16);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
            U_DATA[U_OFF.normalMat + c * 4 + r] = tmpNormal3[c * 3 + r];
        }
        U_DATA[U_OFF.lightDir    ] = 0.3;
        U_DATA[U_OFF.lightDir + 1] = 1.0;
        U_DATA[U_OFF.lightDir + 2] = 0.5;
        U_DATA[U_OFF.lightDir + 3] = 0.0;
        U_DATA[U_OFF.ambient]      = 0.25;
        U_FLAGS[U_OFF.flags    ] = mesh.gpu.hasVertexColor ? 1 : 0;
        U_FLAGS[U_OFF.flags + 1] = 0;
        U_FLAGS[U_OFF.flags + 2] = isSkinned ? 1 : 0;
        U_FLAGS[U_OFF.flags + 3] = 0;

        if (isSkinned) {
            for (let i = 0; i < mesh.skin.boneModelIds.length; i++) {
                const boneWorld = getWorldMatrix(mesh.skin.boneModelIds[i], PARAMS.time, scene);
                const skinMat = mat4.create();
                mat4.multiply(skinMat, boneWorld, mesh.skin.bindInverses[i]);
                if (scaleMat) mat4.multiply(skinMat, scaleMat, skinMat);
                U_DATA.set(skinMat, U_OFF.bones + i * 16);
            }
            // Fill remaining bone slots with identity so unused indices stay sane.
            const ident = mat4.create();
            for (let i = mesh.skin.boneModelIds.length; i < MAX_BONES; i++) {
                U_DATA.set(ident, U_OFF.bones + i * 16);
            }
        } else {
            // Identity matrices for all bone slots when not skinned.
            const ident = mat4.create();
            for (let i = 0; i < MAX_BONES; i++) U_DATA.set(ident, U_OFF.bones + i * 16);
        }

        // Per-channel morph weights — animated where the current clip has a
        // DeformPercent curve, else from the per-channel slider value.
        const morphChannels = mesh.morph?.channels ?? [];
        const morphAnims = scene.clips[scene.currentClip]?.morphAnimsByChannel ?? new Map();
        U_DATA[U_OFF.morphWeights    ] = 0;
        U_DATA[U_OFF.morphWeights + 1] = 0;
        U_DATA[U_OFF.morphWeights + 2] = 0;
        U_DATA[U_OFF.morphWeights + 3] = 0;
        for (let m = 0; m < Math.min(MAX_MORPHS, morphChannels.length); m++) {
            const ch = morphChannels[m];
            const anim = morphAnims.get(ch.channelId);
            U_DATA[U_OFF.morphWeights + m] = anim
                ? sampleCurve(anim.curve, PARAMS.time, 0) / 100
                : ch.weight;
        }

        device.queue.writeBuffer(mesh.gpu.uniformBuf, 0, U_DATA);
    }

    // ---- Encode the render pass ----
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
        colorAttachments: [{
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0.627, g: 0.627, b: 0.627, a: 1 },
            loadOp: 'clear', storeOp: 'store',
        }],
        depthStencilAttachment: {
            view: depthTexture.createView(),
            depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
        },
    });
    pass.setPipeline(pipeline);
    for (const mesh of scene.meshes) {
        pass.setBindGroup(0, mesh.gpu.meshBindGroup);
        for (let i = 0; i < mesh.gpu.vb.length; i++) pass.setVertexBuffer(i, mesh.gpu.vb[i]);
        pass.setIndexBuffer(mesh.gpu.idxBuf, mesh.gpu.idxFormat);
        // One draw call per material group. Each group rebinds its own bind
        // group(1) (baseColor uniform + matching texture) so multi-material
        // meshes (e.g. morph-translation's paillottes split between
        // paillotte.png and paillotte_extremite.png) render with the right
        // art per polygon.
        for (let gi = 0; gi < mesh.gpu.groups.length; gi++) {
            const g = mesh.gpu.groups[gi];
            pass.setBindGroup(1, mesh.matBindings[gi].bindGroup);
            pass.drawIndexed(g.count, 1, g.offset, 0, 0);
        }
    }
    pass.end();
    device.queue.submit([enc.finish()]);

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
        await initWebGPU();
        OrbitControls.create({ canvas, cameraEye, cameraTarget, cameraUp, vec3 });
        initGui();
        window.addEventListener('resize', resize);
        resize(); // create the initial depth texture
        await loadModel(PARAMS.asset);
        requestAnimationFrame(render);
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`);
    }
}

main();

})();
