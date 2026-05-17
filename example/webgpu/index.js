// WebGPU + FBX viewer
//
// Same feature set as the WebGL 1.0 / 2.0 samples (multi-mesh, hierarchy
// animation, skinning, morph targets, multi-clip, per-polygon material
// colors), ported to WebGPU. One render pipeline; per-mesh uniform buffer
// + bind group holding matrices, flags, morph weights, the bone palette,
// the diffuse texture (or a 1×1 white fallback) and a sampler.

(() => {

const { parseFBX, findNode, findNodes, prop0, FBX_TIME_UNIT_SECONDS } = window.FBXParser;
const { mat4, mat3, vec3 } = window.glMatrix;

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
    // Unit-test assets
    'test/anim_euler_jump',
    'test/anim_skin_bend',
    'test/anim_root_motion',
    // glTF sample models converted to FBX
    'gltf/AnimatedTriangle',
    'gltf/SimpleSkin',
    'gltf/RiggedSimple',
    'gltf/RiggedFigure',
    'gltf/Fox',
];

const FBX_BASE = '../../assets/models/fbx/';
const MAX_BONES  = 64; // must match uBones[] in vertex shader
const MAX_MORPHS = 4;  // must match aMorph0..3 / uMorphWeights in vertex shader

const SCALES = new Map([
    ['warrior/Warrior',    100],
    ['archer/ArcherRi01',  100],
    ['stanford-bunny',     0.001],
    ['Head_69',            100],
    ['gltf/Fox',           0.01],
]);

function modelUrl(name) {
    return FBX_BASE + name.split('/').map(encodeURIComponent).join('/') + '.fbx';
}

const SEARCH_PARAMS = new URLSearchParams(window.location.search);

function getBoolParam(key, defaultValue) {
    const v = SEARCH_PARAMS.get(key);
    if (v === null) return defaultValue;
    return !['0', 'false', 'off', 'no'].includes(v.toLowerCase());
}

function getInitialModel() {
    const wanted = SEARCH_PARAMS.get('model');
    return ASSETS.includes(wanted) ? wanted : ASSETS[0];
}

const PARAMS = {
    asset:    getInitialModel(),
    animate:  getBoolParam('animation', true),
    time:     Number(SEARCH_PARAMS.get('time')) || 0,
    morph:    Number(SEARCH_PARAMS.get('morph')) || 0,
    clip:     SEARCH_PARAMS.get('clip') ?? null, // honored once on first load
};

// =====================================================================
// WebGPU setup
// =====================================================================

let canvas, ctx, device, adapter;
let pipeline, bindGroupLayout, sampler;
let depthTexture = null;
let dummyTexture; // 1x1 white texture used as the diffuse for non-textured meshes
let presentationFormat;

// Uniform buffer layout matches the WGSL `Uniforms` struct in index.html.
//   viewProj     (mat4 = 16 floats)
//   model        (mat4 = 16 floats)
//   normalMat    (mat4 = 16 floats)
//   baseColor    (vec4 = 4 floats)
//   lightDir     (vec4 = 4 floats)
//   ambient      (vec4 = 4 floats)
//   morphWeights (vec4 = 4 floats)
//   flags        (vec4u = 4 u32) — same 16 bytes; written through Uint32 view
//   bones        (array<mat4, 64> = 64 * 16 floats)
const U_FLOAT_COUNT = 16 + 16 + 16 + 4 + 4 + 4 + 4 + 4 + 64 * 16;
const U_BYTES = U_FLOAT_COUNT * 4;
const U_OFF = {
    viewProj:     0,
    model:        16,
    normalMat:    32,
    baseColor:    48,
    lightDir:     52,
    ambient:      56,
    morphWeights: 60,
    flags:        64,
    bones:        68,
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

    bindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
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
// FBX → renderable mesh
// =====================================================================

function getProps70(modelNode) {
    const p70 = findNode(modelNode.children, 'Properties70');
    const out = {
        T: [0, 0, 0], R: [0, 0, 0], S: [1, 1, 1], preR: [0, 0, 0], rotOrder: 0,
        geoT: [0, 0, 0], geoR: [0, 0, 0], geoS: [1, 1, 1],
    };
    if (!p70) return out;
    for (const p of p70.children) {
        if (p.name !== 'P' || !p.props) continue;
        const k = p.props[0];
        const v3 = p.props.length > 6 ? [p.props[4], p.props[5], p.props[6]] : null;
        if      (k === 'Lcl Translation'      && v3) out.T    = v3;
        else if (k === 'Lcl Rotation'         && v3) out.R    = v3;
        else if (k === 'Lcl Scaling'          && v3) out.S    = v3;
        else if (k === 'PreRotation'          && v3) out.preR = v3;
        else if (k === 'GeometricTranslation' && v3) out.geoT = v3;
        else if (k === 'GeometricRotation'    && v3) out.geoR = v3;
        else if (k === 'GeometricScaling'     && v3) out.geoS = v3;
        else if (k === 'RotationOrder' && p.props.length > 4) out.rotOrder = p.props[4];
    }
    return out;
}

// FBX rotations are intrinsic XYZ Euler (degrees). With RotationOrder=0 the
// combined matrix is Rz * Ry * Rx (column-vector). We mirror that here.
function eulerToMat4(out, deg) {
    const rx = deg[0] * Math.PI / 180;
    const ry = deg[1] * Math.PI / 180;
    const rz = deg[2] * Math.PI / 180;
    mat4.identity(out);
    mat4.rotateZ(out, out, rz);
    mat4.rotateY(out, out, ry);
    mat4.rotateX(out, out, rx);
    return out;
}

// Local matrix: T * preR * R * S
function makeLocalMatrix(T, preR, R, S) {
    const m = mat4.create();
    mat4.translate(m, m, T);
    if (preR && (preR[0] || preR[1] || preR[2])) {
        const pm = mat4.create();
        eulerToMat4(pm, preR);
        mat4.multiply(m, m, pm);
    }
    const rm = mat4.create();
    eulerToMat4(rm, R);
    mat4.multiply(m, m, rm);
    mat4.scale(m, m, S);
    return m;
}

// Extract a renderable mesh from an FBX Geometry node.
//
// FBX stores each face as a list of vertex indices in PolygonVertexIndex,
// with the LAST index of a face negated (and bitwise-NOT'd to recover the
// real index) to mark the polygon end. Normals/UVs can be indexed in a few
// different ways (ByPolygonVertex / ByVertex / ByPolygon / AllSame, with an
// optional indirect IndexToDirect remap).
//
// We expand each polygon corner into its own vertex (one vertex per FBX
// polygon-vertex) so per-corner normals can vary across adjacent faces,
// and emit a fan triangulation per polygon.
//
// If `skinPerVertex` is provided ({ boneIndices, boneWeights }), per-vertex
// skinning attributes (4 bones per vertex) are expanded alongside positions.
// If `morphDeltas` is provided (Float32Array[], one per channel), per-vertex
// position deltas are expanded alongside positions.
// If `materialColors` is provided (Array<[r,g,b]>, indexed by the per-polygon
// material index from LayerElementMaterial) AND the geometry has a ByPolygon
// material layer that references more than one material, the per-polygon
// diffuse colors are baked into aColor / vColor — the cleanest way to render
// multi-material meshes (e.g. Head_69) without splitting them into sub-meshes.
// If `geometricTransform` is provided ({ T, R, S }) it is baked into vertex
// positions and normals here so skinned meshes (which skip the model matrix)
// still pick it up.
function buildMesh(geoNode, skinPerVertex, morphDeltas, materialColors, geometricTransform) {
    const verts = prop0(findNode(geoNode.children, 'Vertices'));
    const polyIdxNode = findNode(geoNode.children, 'PolygonVertexIndex');
    if (!verts || !polyIdxNode) return null;
    const polyIndex = polyIdxNode.props[0];

    // Helper to read a LayerElement{Normal,Color,UV,...} attribute.
    function readLayer(layerName, dataName, indexName, defaultMapping = 'ByPolygonVertex') {
        const layer = findNode(geoNode.children, layerName);
        if (!layer) return null;
        const arr = prop0(findNode(layer.children, dataName));
        if (!arr) return null;
        const idx = findNode(layer.children, indexName);
        const map = findNode(layer.children, 'MappingInformationType');
        const ref = findNode(layer.children, 'ReferenceInformationType');
        return {
            arr,
            index:   idx ? idx.props[0] : null,
            mapping: map ? map.props[0] : defaultMapping,
            ref:     ref ? ref.props[0] : 'Direct',
        };
    }

    const normalsData = readLayer('LayerElementNormal', 'Normals', 'NormalsIndex');
    const colorsData  = readLayer('LayerElementColor',  'Colors',  'ColorIndex');
    const uvsData     = readLayer('LayerElementUV',     'UV',      'UVIndex');

    // Per-polygon material index (when the FBX assigns multiple materials to
    // a single mesh, e.g. Head_69 with 43 face materials). We only treat it
    // as "multi-material" when the layer actually references more than one
    // distinct material; AllSame / single-index cases fall back to the
    // existing single-uBaseColor path.
    const materialLayer = findNode(geoNode.children, 'LayerElementMaterial');
    const matsArrNode   = materialLayer ? findNode(materialLayer.children, 'Materials') : null;
    const matMappingNode = materialLayer ? findNode(materialLayer.children, 'MappingInformationType') : null;
    const matsArr = matsArrNode?.props[0] ?? null;
    const matMapping = matMappingNode?.props[0] ?? 'AllSame';
    const useMatColors = materialColors && matsArr && matMapping === 'ByPolygon'
        && new Set(matsArr).size > 1;

    function lookup(layer, stride, pvIdx, polyIdx, vIdx, fallback) {
        if (!layer) return fallback;
        const { mapping, ref, index, arr } = layer;
        let i;
        switch (mapping) {
            case 'ByPolygonVertex':            i = ref === 'IndexToDirect' && index ? index[pvIdx]   : pvIdx;   break;
            case 'ByVertex': case 'ByVertice': i = ref === 'IndexToDirect' && index ? index[vIdx]    : vIdx;    break;
            case 'ByPolygon':                  i = ref === 'IndexToDirect' && index ? index[polyIdx] : polyIdx; break;
            default:                           i = 0; break; // AllSame
        }
        const out = new Array(stride);
        for (let k = 0; k < stride; k++) out[k] = arr[i * stride + k];
        return out;
    }

    // Bake the geometric transform into vertex positions / normals so skinned
    // meshes (which don't see a model matrix in the shader) still pick it up.
    let geoMat = null, geoNormMat = null;
    if (geometricTransform) {
        const { T = [0,0,0], R = [0,0,0], S = [1,1,1] } = geometricTransform;
        const hasAny = T[0] || T[1] || T[2] || R[0] || R[1] || R[2]
                     || S[0] !== 1 || S[1] !== 1 || S[2] !== 1;
        if (hasAny) {
            geoMat = makeLocalMatrix(T, null, R, S);
            geoNormMat = mat3.create();
            mat3.normalFromMat4(geoNormMat, geoMat);
        }
    }
    const tmpPos = vec3.create();
    const tmpNrm = vec3.create();

    const outPositions = [];
    const outNormals   = [];
    const outColors    = [];
    const outUVs       = [];
    const outBoneIdx   = [];
    const outBoneWt    = [];
    const morphCount   = morphDeltas ? morphDeltas.length : 0;
    const outMorphs    = morphDeltas ? morphDeltas.map(() => []) : [];
    const outIndices   = [];
    let polyCornerStart = 0;
    let polyId = 0;

    for (let i = 0; i < polyIndex.length; i++) {
        const raw = polyIndex[i];
        const isEnd = raw < 0;
        const v = isEnd ? ~raw : raw;

        if (geoMat) {
            vec3.set(tmpPos, verts[v*3], verts[v*3+1], verts[v*3+2]);
            vec3.transformMat4(tmpPos, tmpPos, geoMat);
            outPositions.push(tmpPos[0], tmpPos[1], tmpPos[2]);
        } else {
            outPositions.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
        }
        const n = lookup(normalsData, 3, i, polyId, v, [0, 0, 1]);
        if (geoNormMat) {
            vec3.set(tmpNrm, n[0], n[1], n[2]);
            vec3.transformMat3(tmpNrm, tmpNrm, geoNormMat);
            vec3.normalize(tmpNrm, tmpNrm);
            outNormals.push(tmpNrm[0], tmpNrm[1], tmpNrm[2]);
        } else {
            outNormals.push(n[0], n[1], n[2]);
        }
        if (useMatColors) {
            const mi = matsArr[polyId] ?? 0;
            const mc = materialColors[mi] ?? [1, 1, 1];
            outColors.push(mc[0], mc[1], mc[2], 1);
        } else {
            const c = lookup(colorsData, 4, i, polyId, v, [1, 1, 1, 1]);
            outColors.push(c[0], c[1], c[2], c[3]);
        }
        const uv = lookup(uvsData, 2, i, polyId, v, [0, 0]);
        outUVs.push(uv[0], 1.0 - uv[1]); // FBX UV V=0 is top; WebGL V=0 is bottom
        if (skinPerVertex) {
            const bi = skinPerVertex.boneIndices;
            const bw = skinPerVertex.boneWeights;
            outBoneIdx.push(bi[v*4], bi[v*4+1], bi[v*4+2], bi[v*4+3]);
            outBoneWt.push (bw[v*4], bw[v*4+1], bw[v*4+2], bw[v*4+3]);
        }
        for (let m = 0; m < morphCount; m++) {
            const d = morphDeltas[m];
            outMorphs[m].push(d[v*3], d[v*3+1], d[v*3+2]);
        }

        if (isEnd) {
            for (let j = polyCornerStart + 1; j < i; j++) {
                outIndices.push(polyCornerStart, j, j + 1);
            }
            polyCornerStart = i + 1;
            polyId++;
        }
    }

    return {
        positions: new Float32Array(outPositions),
        normals:   new Float32Array(outNormals),
        colors:    new Float32Array(outColors),
        uvs:       new Float32Array(outUVs),
        boneIndices: skinPerVertex ? new Float32Array(outBoneIdx) : null,
        boneWeights: skinPerVertex ? new Float32Array(outBoneWt)  : null,
        morphs:    outMorphs.map(a => new Float32Array(a)),
        indices:   outIndices,               // plain number[] — converted to Uint16Array/Uint32Array in uploadMesh
        triangleCount: outIndices.length / 3,
        hasVertexColor: !!colorsData || useMatColors,
        hasUVs: !!uvsData,
        hasSkin: !!skinPerVertex,
    };
}

// Upload a mesh and return a VAO that binds every attribute exactly once.
// Subsequent draws only need `gl.bindVertexArray(gpu.vao)` plus uniforms.
// Upload a mesh's vertex/index data + create the per-mesh uniform buffer and
// bind group. The bind group's texture binding starts as the 1x1 white
// fallback and is rebuilt later once the FBX texture loads asynchronously.
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

    function makeBindGroup(textureView) {
        return device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuf } },
                { binding: 1, resource: textureView },
                { binding: 2, resource: sampler },
            ],
        });
    }
    const bindGroup = makeBindGroup(dummyTexture.createView());

    return {
        vb, idxBuf, idxFormat: needU32 ? 'uint32' : 'uint16',
        count: meshData.indices.length,
        uniformBuf, bindGroup, makeBindGroup,
        hasVertexColor: meshData.hasVertexColor,
        hasUVs: meshData.hasUVs,
        hasSkin: meshData.hasSkin,
    };
}

// =====================================================================
// FBX → animation (single mesh node, T/R/S curves)
// =====================================================================

function getCurveData(curveNode) {
    const keyTimes = prop0(findNode(curveNode.children, 'KeyTime')) ?? [];
    const keyValues = prop0(findNode(curveNode.children, 'KeyValueFloat')) ?? [];
    return {
        times:  keyTimes.map(t => t * FBX_TIME_UNIT_SECONDS),
        values: keyValues,
    };
}

function sampleCurve(curve, time, fallback) {
    if (!curve || !curve.times.length) return fallback;
    const ts = curve.times;
    const vs = curve.values;
    if (time <= ts[0]) return vs[0];
    if (time >= ts[ts.length - 1]) return vs[ts.length - 1];
    let lo = 0, hi = ts.length - 1;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= time) lo = mid; else hi = mid;
    }
    const span = ts[hi] - ts[lo] || 1;
    const t = (time - ts[lo]) / span;
    return vs[lo] + (vs[hi] - vs[lo]) * t;
}

// Walk Connections to find AnimationCurveNodes that target `modelId`, then
// find the AnimationCurves under each ACN by axis (d|X/Y/Z).
//
// `layerAcnIds` (optional): restrict to ACNs in this AnimationLayer set, so
// each AnimationStack ("clip") gets its own curves instead of merging them.
function buildAnimation(roots, modelId, layerAcnIds) {
    const objects = findNode(roots, 'Objects');
    const conns   = findNode(roots, 'Connections');
    if (!objects || !conns) return null;

    const acnById = new Map();
    for (const n of findNodes(objects.children, 'AnimationCurveNode')) {
        acnById.set(n.props[0], n);
    }
    const curveById = new Map();
    for (const n of findNodes(objects.children, 'AnimationCurve')) {
        curveById.set(n.props[0], n);
    }

    // ACN → { targetModelId, property }
    const acnTarget = new Map();
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OP') continue;
        const [, fromId, toId, prop] = c.props;
        if (acnById.has(fromId)) acnTarget.set(fromId, { modelId: toId, prop });
    }

    // ACN → { X, Y, Z }: curves
    const acnCurves = new Map();
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OP') continue;
        const [, fromId, toId, prop] = c.props;
        if (!curveById.has(fromId) || !acnById.has(toId)) continue;
        const axis = prop === 'd|X' ? 0 : prop === 'd|Y' ? 1 : prop === 'd|Z' ? 2 : -1;
        if (axis < 0) continue;
        if (!acnCurves.has(toId)) acnCurves.set(toId, [null, null, null]);
        acnCurves.get(toId)[axis] = getCurveData(curveById.get(fromId));
    }

    // Bucket curves by property for our target model.
    const channels = { T: null, R: null, S: null };
    let duration = 0;
    for (const [acnId, target] of acnTarget) {
        if (target.modelId !== modelId) continue;
        if (layerAcnIds && !layerAcnIds.has(acnId)) continue;
        const key = target.prop === 'Lcl Translation' ? 'T'
                  : target.prop === 'Lcl Rotation'    ? 'R'
                  : target.prop === 'Lcl Scaling'     ? 'S'
                  : null;
        if (!key) continue;
        const cs = acnCurves.get(acnId) ?? [null, null, null];
        channels[key] = cs;
        for (const c of cs) {
            if (c && c.times.length) duration = Math.max(duration, c.times[c.times.length - 1]);
        }
    }

    if (duration === 0) return null;
    return { channels, duration };
}

// Walk Connections to find an AnimationCurveNode targeting `channelId`'s
// DeformPercent (BlendShapeChannel weight). Returns a single curve or null.
// `layerAcnIds` filters to a specific AnimationLayer (see `buildAnimation`).
function buildMorphAnimation(roots, channelId, layerAcnIds) {
    const objects = findNode(roots, 'Objects');
    const conns   = findNode(roots, 'Connections');
    if (!objects || !conns) return null;

    const acnById = new Map();
    for (const n of findNodes(objects.children, 'AnimationCurveNode')) {
        acnById.set(n.props[0], n);
    }
    const curveById = new Map();
    for (const n of findNodes(objects.children, 'AnimationCurve')) {
        curveById.set(n.props[0], n);
    }

    // Find ACN that targets DeformPercent on this channel (and is part of
    // the requested layer, when one was supplied).
    let targetAcn = null;
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OP') continue;
        const [, fromId, toId, prop] = c.props;
        if (toId === channelId && acnById.has(fromId) && prop === 'DeformPercent') {
            if (layerAcnIds && !layerAcnIds.has(fromId)) continue;
            targetAcn = fromId; break;
        }
    }
    if (targetAcn === null) return null;

    // Find the scalar curve attached to that ACN (FBX uses d|DeformPercent).
    let curveData = null;
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OP') continue;
        const [, fromId, toId, prop] = c.props;
        if (toId === targetAcn && curveById.has(fromId)
                && (prop === 'd|DeformPercent' || prop === 'd|X')) {
            curveData = getCurveData(curveById.get(fromId)); break;
        }
    }
    if (!curveData || !curveData.times.length) return null;

    const duration = curveData.times[curveData.times.length - 1];
    return { curve: curveData, duration };
}

function sampleAnimation(animation, time, baseTRS) {
    if (!animation) return baseTRS;
    const out = {
        T: baseTRS.T.slice(),
        R: baseTRS.R.slice(),
        S: baseTRS.S.slice(),
    };
    for (const [key, fallback] of [['T', baseTRS.T], ['R', baseTRS.R], ['S', baseTRS.S]]) {
        const cs = animation.channels[key];
        if (!cs) continue;
        for (let i = 0; i < 3; i++) {
            out[key][i] = sampleCurve(cs[i], time, fallback[i]);
        }
    }
    return out;
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
// Skinning
// =====================================================================

// Gather skinning info for a Geometry node, if it has a Skin Deformer.
// Returns:
//   { boneModelIds: Int[],           // ordered list of bone Model IDs
//     bindInverses: mat4[],          // per-bone: cluster.Transform (mesh-local → bone-local at bind)
//     boneIndices: Float32Array,     // per-vertex (vertexCount * 4)
//     boneWeights: Float32Array }    // per-vertex (vertexCount * 4)
// or null if not skinned. Bones are dropped silently beyond MAX_BONES.
//
// Skinning math: per FBX spec, `Transform = inverse(TransformLink) * meshWorldAtBind`
// maps a mesh-local vertex to its bind-pose position in the bone's local frame.
// So `skinMatrix = boneCurrentWorld * Transform` gives the world-space deformed
// position directly — no separate mesh world matrix is needed.
function buildSkinForGeometry(geoNode, vertexCount, conns, deformerById, modelById) {
    const geoId = geoNode.props[0];

    // 1. Geometry → Skin deformer (OO)
    let skinId = null;
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (toId === geoId && deformerById.has(fromId)
                && deformerById.get(fromId).props[2] === 'Skin') {
            skinId = fromId; break;
        }
    }
    if (skinId === null) return null;

    // 2. Skin → Cluster (Deformer "Cluster" subDeformers)
    const clusters = [];
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (toId === skinId && deformerById.has(fromId)
                && deformerById.get(fromId).props[2] === 'Cluster') {
            clusters.push(deformerById.get(fromId));
        }
    }
    if (clusters.length === 0) return null;

    // 3. For each cluster, find its bone LimbNode + extract bind matrix.
    const boneModelIds = [];
    const bindInverses = [];
    const perCluster = []; // { boneIndex, indexes, weights }
    for (const cluster of clusters) {
        const clusterId = cluster.props[0];
        let boneModelId = null;
        for (const c of conns.children) {
            if (c.name !== 'C' || c.props[0] !== 'OO') continue;
            const [, fromId, toId] = c.props;
            if (toId === clusterId && modelById.has(fromId)) { boneModelId = fromId; break; }
        }
        if (boneModelId === null) continue;

        const transform = prop0(findNode(cluster.children, 'Transform'));
        if (!transform || transform.length !== 16) continue;
        const bindInv = mat4.fromValues(...transform);

        const indexes = prop0(findNode(cluster.children, 'Indexes')) ?? [];
        const weights = prop0(findNode(cluster.children, 'Weights')) ?? [];

        const boneIndex = boneModelIds.length;
        if (boneIndex >= MAX_BONES) {
            console.warn(`Skipping bone ${boneModelId}: exceeds MAX_BONES (${MAX_BONES})`);
            continue;
        }
        boneModelIds.push(boneModelId);
        bindInverses.push(bindInv);
        perCluster.push({ boneIndex, indexes, weights });
    }
    if (boneModelIds.length === 0) return null;

    // 4. Per-vertex influences (top-4 by weight, normalized).
    const influences = Array.from({ length: vertexCount }, () => []);
    for (const ci of perCluster) {
        for (let k = 0; k < ci.indexes.length; k++) {
            const v = ci.indexes[k];
            const w = ci.weights[k];
            if (v >= 0 && v < vertexCount && w > 0) {
                influences[v].push({ idx: ci.boneIndex, w });
            }
        }
    }
    const boneIndices = new Float32Array(vertexCount * 4);
    const boneWeights = new Float32Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) {
        const inf = influences[v];
        inf.sort((a, b) => b.w - a.w);
        const top = inf.slice(0, 4);
        let total = 0;
        for (const e of top) total += e.w;
        if (total > 0) {
            for (let i = 0; i < top.length; i++) {
                boneIndices[v * 4 + i] = top[i].idx;
                boneWeights[v * 4 + i] = top[i].w / total;
            }
        }
    }

    return { boneModelIds, bindInverses, boneIndices, boneWeights };
}

// Gather morph-target info for a Geometry node, if it has a BlendShape
// deformer chain. Returns:
//   { channels: [{ channelId, deltas: Float32Array(vertexCount * 3) }] }
// or null. Up to MAX_MORPHS channels per geometry. For a channel with multiple
// in-between shapes we use only the last shape (matches Babylon's loader).
function buildMorphForGeometry(geoNode, vertexCount, conns, geoById, deformerById) {
    const geoId = geoNode.props[0];

    // 1. Geometry → BlendShape deformer(s)
    const blendShapeIds = [];
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const [, fromId, toId] = c.props;
        if (toId === geoId && deformerById.has(fromId)
                && deformerById.get(fromId).props[2] === 'BlendShape') {
            blendShapeIds.push(fromId);
        }
    }
    if (blendShapeIds.length === 0) return null;

    // 2. BlendShape → BlendShapeChannel(s) → Shape(s)
    const channels = [];
    for (const bsId of blendShapeIds) {
        for (const c of conns.children) {
            if (c.name !== 'C' || c.props[0] !== 'OO') continue;
            const [, fromId, toId] = c.props;
            if (toId !== bsId) continue;
            if (!deformerById.has(fromId)
                    || deformerById.get(fromId).props[2] !== 'BlendShapeChannel') continue;
            const channelId = fromId;

            // Find all Shape geometries targeting this channel; use the last one.
            const shapes = [];
            for (const c2 of conns.children) {
                if (c2.name !== 'C' || c2.props[0] !== 'OO') continue;
                const [, fromId2, toId2] = c2.props;
                if (toId2 === channelId && geoById.has(fromId2)
                        && geoById.get(fromId2).props[2] === 'Shape') {
                    shapes.push(geoById.get(fromId2));
                }
            }
            if (shapes.length === 0) continue;
            const shape = shapes[shapes.length - 1];

            const indexes = prop0(findNode(shape.children, 'Indexes')) ?? [];
            const dverts  = prop0(findNode(shape.children, 'Vertices')) ?? [];

            // Expand sparse per-vertex deltas into a dense vertexCount-sized array.
            const deltas = new Float32Array(vertexCount * 3);
            for (let i = 0; i < indexes.length; i++) {
                const v = indexes[i];
                if (v >= 0 && v < vertexCount) {
                    deltas[v*3]   = dverts[i*3];
                    deltas[v*3+1] = dverts[i*3+1];
                    deltas[v*3+2] = dverts[i*3+2];
                }
            }
            // Channel display name (strip FBX's "\x00\x01SubDeformer" suffix).
            const channelNode = deformerById.get(channelId);
            const rawName = channelNode?.props[1] ?? '';
            const sep = rawName.indexOf('\x00');
            const name = sep >= 0 ? rawName.slice(0, sep) : rawName;
            channels.push({ channelId, name, deltas, weight: 0 });
            if (channels.length >= MAX_MORPHS) break;
        }
        if (channels.length >= MAX_MORPHS) break;
    }

    if (channels.length === 0) return null;
    return { channels };
}

// =====================================================================
// Scene graph + world transform
// =====================================================================

// Compute the world matrix for a mesh node by walking up its parent chain,
// accumulating local transforms (with animations) and then appending the
// leaf node's geometric transform (GeometricTranslation/Rotation/Scaling).
function getWorldMatrix(leafModelId, time, scene) {
    const { parentOf, modelById, baseTRSOf } = scene;
    const animationsOf = scene.clips[scene.currentClip]?.animationsOf ?? new Map();

    // Collect ancestor chain from root down to leafModelId
    const chain = [];
    let id = leafModelId;
    const seen = new Set();
    while (id !== undefined && !seen.has(id)) {
        seen.add(id);
        if (modelById.has(id)) chain.unshift(id);
        id = parentOf.get(id);
    }

    // Accumulate local transforms root → leaf
    const world = mat4.create();
    for (const nodeId of chain) {
        const base = baseTRSOf.get(nodeId);
        const trs  = sampleAnimation(animationsOf.get(nodeId) ?? null, time, base);
        mat4.multiply(world, world, makeLocalMatrix(trs.T, base.preR, trs.R, trs.S));
    }

    // GeometricTransform is baked into the mesh's vertex positions / normals
    // at upload time (see buildMesh), so both skinned and non-skinned paths
    // pick it up without applying it externally here.

    return world;
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

// Orbit-style camera controller — see example/webgl1/index.js for the same
// implementation and rationale.
const orbit = (() => {
    const offset = vec3.create();
    vec3.subtract(offset, cameraEye, cameraTarget);
    let distance = vec3.length(offset);
    let polar = Math.acos(Math.max(-1, Math.min(1, offset[1] / distance)));
    let azimuth = Math.atan2(offset[2], offset[0]);
    const EPS = 1e-3;
    function apply() {
        const sp = Math.sin(polar);
        cameraEye[0] = cameraTarget[0] + distance * sp * Math.cos(azimuth);
        cameraEye[1] = cameraTarget[1] + distance * Math.cos(polar);
        cameraEye[2] = cameraTarget[2] + distance * sp * Math.sin(azimuth);
    }
    function rotate(dx, dy) {
        azimuth -= dx;
        polar   = Math.max(EPS, Math.min(Math.PI - EPS, polar - dy));
        apply();
    }
    function zoom(factor) {
        distance = Math.max(0.1, distance * factor);
        apply();
    }
    function pan(dx, dy) {
        const forward = vec3.create();
        vec3.subtract(forward, cameraTarget, cameraEye);
        vec3.normalize(forward, forward);
        const right = vec3.create();
        vec3.cross(right, forward, cameraUp);
        vec3.normalize(right, right);
        const up = vec3.create();
        vec3.cross(up, right, forward);
        const scale = distance * 0.001;
        cameraTarget[0] += (-dx * right[0] + dy * up[0]) * scale;
        cameraTarget[1] += (-dx * right[1] + dy * up[1]) * scale;
        cameraTarget[2] += (-dx * right[2] + dy * up[2]) * scale;
        apply();
    }
    return { rotate, zoom, pan };
})();

function attachCameraControls() {
    let dragMode = null;
    let lastX = 0, lastY = 0;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('mousedown', e => {
        e.preventDefault();
        lastX = e.clientX; lastY = e.clientY;
        if (e.button === 0)      dragMode = 'rotate';
        else if (e.button === 2) dragMode = 'pan';
    });
    window.addEventListener('mouseup', () => { dragMode = null; });
    window.addEventListener('mousemove', e => {
        if (!dragMode) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        if (dragMode === 'rotate') orbit.rotate(dx * 0.005, dy * 0.005);
        else                       orbit.pan(dx, dy);
    });
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        orbit.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    let touchX = 0, touchY = 0;
    canvas.addEventListener('touchstart', e => {
        if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }
    });
    canvas.addEventListener('touchmove', e => {
        if (e.touches.length === 1) {
            const t = e.touches[0];
            orbit.rotate((t.clientX - touchX) * 0.005, (t.clientY - touchY) * 0.005);
            touchX = t.clientX; touchY = t.clientY;
            e.preventDefault();
        }
    }, { passive: false });
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

    // Trace Model→Material→Texture→Video to find the Video node for a mesh
    function findVideoForModel(modelId) {
        for (const matId of reverseConns.get(modelId) ?? []) {
            if (!matById.has(matId)) continue;
            for (const texId of reverseConns.get(matId) ?? []) {
                if (!texById.has(texId)) continue;
                for (const vidId of reverseConns.get(texId) ?? []) {
                    if (vidById.has(vidId)) return vidById.get(vidId);
                }
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

    // First Material's diffuse color (used when the mesh isn't multi-material).
    function findMaterialColorForModel(modelId) {
        const mats = findMaterialsForModel(modelId);
        for (const m of mats) {
            const c = readMaterialColor(m);
            if (c) return c;
        }
        return null;
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
        let texture = null;
        if (meshData.hasUVs) {
            const vid = findVideoForModel(modelId);
            if (vid) {
                try {
                    texture = await loadTextureFromVideo(vid, url);
                    if (texture) {
                        // Rebuild the bind group so binding 1 points at the
                        // real texture rather than the 1x1 white fallback.
                        gpu.bindGroup = gpu.makeBindGroup(texture.createView());
                    }
                } catch (e) { console.warn('Texture load failed:', e); }
            }
        }
        const baseColor = findMaterialColorForModel(modelId);
        // Display name for the mesh (used by the per-channel morph GUI).
        const rawModelName = modelById.get(modelId)?.props[1] ?? '';
        const sep = rawModelName.indexOf('\x00');
        const modelName = sep >= 0 ? rawModelName.slice(0, sep) : rawModelName;
        meshes.push({ gpu, texture, modelId, modelName, skin, morph, baseColor });
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
        const hasTexture = !!(mesh.texture && mesh.gpu.hasUVs);

        // ---- Fill the per-mesh uniform buffer ----
        U_DATA.set(viewProj, U_OFF.viewProj);
        U_DATA.set(model,    U_OFF.model);
        // Repack mat3 -> mat4 (drop translation row, last column zero).
        U_DATA.fill(0, U_OFF.normalMat, U_OFF.normalMat + 16);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
            U_DATA[U_OFF.normalMat + c * 4 + r] = tmpNormal3[c * 3 + r];
        }
        const bc = mesh.baseColor;
        U_DATA[U_OFF.baseColor    ] = bc ? bc[0] : 0.85;
        U_DATA[U_OFF.baseColor + 1] = bc ? bc[1] : 0.85;
        U_DATA[U_OFF.baseColor + 2] = bc ? bc[2] : 0.9;
        U_DATA[U_OFF.baseColor + 3] = 1.0;
        U_DATA[U_OFF.lightDir    ] = 0.3;
        U_DATA[U_OFF.lightDir + 1] = 1.0;
        U_DATA[U_OFF.lightDir + 2] = 0.5;
        U_DATA[U_OFF.lightDir + 3] = 0.0;
        U_DATA[U_OFF.ambient]      = 0.25;
        U_FLAGS[U_OFF.flags    ] = mesh.gpu.hasVertexColor ? 1 : 0;
        U_FLAGS[U_OFF.flags + 1] = hasTexture ? 1 : 0;
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
        pass.setBindGroup(0, mesh.gpu.bindGroup);
        for (let i = 0; i < mesh.gpu.vb.length; i++) pass.setVertexBuffer(i, mesh.gpu.vb[i]);
        pass.setIndexBuffer(mesh.gpu.idxBuf, mesh.gpu.idxFormat);
        pass.drawIndexed(mesh.gpu.count);
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
let morphsFolder = null;
const CLIP_PARAM = { clip: '' };

function initGui() {
    gui = new lil.GUI();
    gui.add(PARAMS, 'asset', ASSETS).name('asset').onChange(loadModel);
    gui.add(PARAMS, 'animate').name('play');
    clipCtrl = gui.add(CLIP_PARAM, 'clip', ['']).name('clip').onChange(name => {
        if (!scene) return;
        const idx = scene.clips.findIndex(c => c.name === name);
        if (idx >= 0) {
            scene.currentClip = idx;
            PARAMS.time = 0;
        }
    });
    clipCtrl.hide();
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
        attachCameraControls();
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
