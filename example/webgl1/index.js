// WebGL 1.0 + FBX viewer
//
// Loads a small subset of FBX (binary, single static mesh + optional
// LclTranslation/LclRotation/LclScaling animation on the mesh node)
// and renders with a simple Lambert shader.

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
};

// =====================================================================
// WebGL setup
// =====================================================================

let canvas, gl;
let program, attribs, uniforms;

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
    gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('WebGL 1.0 is not supported by this browser.');

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

    gl.clearColor(0.627, 0.627, 0.627, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.getExtension('OES_element_index_uint'); // allow Uint32 indices for large meshes
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
function buildMesh(geoNode, skinPerVertex, morphDeltas) {
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

        outPositions.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
        const n = lookup(normalsData, 3, i, polyId, v, [0, 0, 1]);
        outNormals.push(n[0], n[1], n[2]);
        const c = lookup(colorsData, 4, i, polyId, v, [1, 1, 1, 1]);
        outColors.push(c[0], c[1], c[2], c[3]);
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
        hasVertexColor: !!colorsData,
        hasUVs: !!uvsData,
        hasSkin: !!skinPerVertex,
    };
}

function uploadMesh(meshData) {
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, meshData.positions, gl.STATIC_DRAW);

    const normBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, meshData.normals, gl.STATIC_DRAW);

    const colorBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, meshData.colors, gl.STATIC_DRAW);

    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, meshData.uvs, gl.STATIC_DRAW);

    let boneIdxBuf = null, boneWtBuf = null;
    if (meshData.hasSkin) {
        boneIdxBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, boneIdxBuf);
        gl.bufferData(gl.ARRAY_BUFFER, meshData.boneIndices, gl.STATIC_DRAW);
        boneWtBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, boneWtBuf);
        gl.bufferData(gl.ARRAY_BUFFER, meshData.boneWeights, gl.STATIC_DRAW);
    }

    const morphBufs = [];
    for (const m of meshData.morphs) {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, m, gl.STATIC_DRAW);
        morphBufs.push(b);
    }

    // Use Uint32 indices for meshes with more than 65535 expanded vertices
    const needU32 = meshData.positions.length / 3 > 65535;
    const idxData = needU32 ? new Uint32Array(meshData.indices) : new Uint16Array(meshData.indices);
    const idxType = needU32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxData, gl.STATIC_DRAW);

    return {
        posBuf, normBuf, colorBuf, uvBuf, boneIdxBuf, boneWtBuf, morphBufs, idxBuf, idxType,
        count: meshData.indices.length,
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
function buildAnimation(roots, modelId) {
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
function buildMorphAnimation(roots, channelId) {
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

    // Find ACN that targets DeformPercent on this channel.
    let targetAcn = null;
    for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OP') continue;
        const [, fromId, toId, prop] = c.props;
        if (toId === channelId && acnById.has(fromId) && prop === 'DeformPercent') {
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
            channels.push({ channelId, deltas });
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
    const { parentOf, modelById, baseTRSOf, animationsOf } = scene;

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

    // Apply geometric transform (fixed offset in local space, not animated)
    const base = baseTRSOf.get(leafModelId);
    if (base) {
        const { geoT, geoR, geoS } = base;
        const hasGeo = geoT.some(v => v !== 0) || geoR.some(v => v !== 0) || geoS.some(v => v !== 1);
        if (hasGeo) mat4.multiply(world, world, makeLocalMatrix(geoT, null, geoR, geoS));
    }

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

    // Per-model animations
    const animationsOf = new Map();
    for (const [id] of modelById) {
        const anim = buildAnimation(nodes, id);
        if (anim) animationsOf.set(id, anim);
    }
    let duration = 0;
    for (const a of animationsOf.values()) duration = Math.max(duration, a.duration);

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

    // Read DiffuseColor (× DiffuseFactor) from the first Material attached to a Model.
    function findMaterialColorForModel(modelId) {
        for (const matId of reverseConns.get(modelId) ?? []) {
            if (!matById.has(matId)) continue;
            const p70 = findNode(matById.get(matId).children, 'Properties70');
            if (!p70) continue;
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
            if (diffuse) return [diffuse[0] * factor, diffuse[1] * factor, diffuse[2] * factor];
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
        // Attach a per-channel animation curve (DeformPercent) if present.
        if (morph) {
            for (const ch of morph.channels) {
                ch.animation = buildMorphAnimation(nodes, ch.channelId);
                if (ch.animation) duration = Math.max(duration, ch.animation.duration);
            }
        }
        const morphDeltas = morph ? morph.channels.map(ch => ch.deltas) : null;
        const meshData = buildMesh(geoNode, skin, morphDeltas);
        if (!meshData) continue;
        const gpu = uploadMesh(meshData);
        let texture = null;
        if (meshData.hasUVs) {
            const vid = findVideoForModel(modelId);
            if (vid) {
                try { texture = await loadTextureFromVideo(vid, url); }
                catch (e) { console.warn('Texture load failed:', e); }
            }
        }
        const baseColor = findMaterialColorForModel(modelId);
        meshes.push({ gpu, texture, modelId, skin, morph, baseColor });
        totalTriangles += meshData.triangleCount;
        if (skin) totalBones += skin.boneModelIds.length;
        if (morph) totalMorphs += morph.channels.length;
    }

    const scale = SCALES.get(name) ?? 1;
    scene = { meshes, parentOf, modelById, baseTRSOf, animationsOf, duration, modelName: name, scale };
    const skinNote  = totalBones  ? ` — bones: ${totalBones}`   : '';
    const morphNote = totalMorphs ? ` — morphs: ${totalMorphs}` : '';
    setStatus(`${name} — triangles: ${totalTriangles}${duration ? ` — anim ${duration.toFixed(2)}s` : ''}${skinNote}${morphNote}`);
}

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

// =====================================================================
// Render loop
// =====================================================================

function render(timeMs) {
    if (PARAMS.animate && scene?.duration) {
        PARAMS.time = (timeMs / 1000) % scene.duration;
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
        const hasTexture = !!(mesh.texture && mesh.gpu.hasUVs);

        gl.uniformMatrix4fv(uniforms.model,    false, model);
        gl.uniformMatrix3fv(uniforms.normalMat, false, normalMat);
        gl.uniform1i(uniforms.hasVertexColor, mesh.gpu.hasVertexColor ? 1 : 0);
        gl.uniform1i(uniforms.hasTexture, hasTexture ? 1 : 0);
        gl.uniform1i(uniforms.skinned, isSkinned ? 1 : 0);
        const bc = mesh.baseColor;
        gl.uniform4f(uniforms.baseColor,
            bc ? bc[0] : 0.85,
            bc ? bc[1] : 0.85,
            bc ? bc[2] : 0.9,
            1.0);

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

        if (hasTexture) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, mesh.texture);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.posBuf);
        gl.enableVertexAttribArray(attribs.position);
        gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.normBuf);
        gl.enableVertexAttribArray(attribs.normal);
        gl.vertexAttribPointer(attribs.normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.colorBuf);
        gl.enableVertexAttribArray(attribs.color);
        gl.vertexAttribPointer(attribs.color, 4, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.uvBuf);
        gl.enableVertexAttribArray(attribs.texCoord);
        gl.vertexAttribPointer(attribs.texCoord, 2, gl.FLOAT, false, 0, 0);

        if (isSkinned && attribs.boneIndex >= 0 && attribs.boneWeight >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.boneIdxBuf);
            gl.enableVertexAttribArray(attribs.boneIndex);
            gl.vertexAttribPointer(attribs.boneIndex, 4, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.boneWtBuf);
            gl.enableVertexAttribArray(attribs.boneWeight);
            gl.vertexAttribPointer(attribs.boneWeight, 4, gl.FLOAT, false, 0, 0);
        } else {
            if (attribs.boneIndex  >= 0) { gl.disableVertexAttribArray(attribs.boneIndex);  gl.vertexAttrib4f(attribs.boneIndex,  0, 0, 0, 0); }
            if (attribs.boneWeight >= 0) { gl.disableVertexAttribArray(attribs.boneWeight); gl.vertexAttrib4f(attribs.boneWeight, 0, 0, 0, 0); }
        }

        // Morph targets: bind up to MAX_MORPHS delta-position buffers and set
        // the matching weight components. Unused slots get a zero constant so
        // they cleanly contribute nothing.
        const morphChannels = mesh.morph?.channels ?? [];
        const morphWeights = [0, 0, 0, 0];
        for (let m = 0; m < MAX_MORPHS; m++) {
            const loc = attribs.morph[m];
            if (loc < 0) continue;
            if (m < morphChannels.length) {
                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.gpu.morphBufs[m]);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
                const ch = morphChannels[m];
                const pct = ch.animation
                    ? sampleCurve(ch.animation.curve, PARAMS.time, 0)
                    : 0;
                // Use animated DeformPercent (0..100) if present, else the
                // `?morph=` URL override (0..1) for manual inspection.
                morphWeights[m] = ch.animation ? pct / 100 : PARAMS.morph;
            } else {
                gl.disableVertexAttribArray(loc);
                gl.vertexAttrib3f(loc, 0, 0, 0);
            }
        }
        gl.uniform4f(uniforms.morphWeights, morphWeights[0], morphWeights[1], morphWeights[2], morphWeights[3]);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.gpu.idxBuf);
        gl.drawElements(gl.TRIANGLES, mesh.gpu.count, mesh.gpu.idxType, 0);
    }

    requestAnimationFrame(render);
}

// =====================================================================
// GUI
// =====================================================================

function initGui() {
    const gui = new lil.GUI();
    gui.add(PARAMS, 'asset', ASSETS).name('asset').onChange(loadModel);
    gui.add(PARAMS, 'animate').name('play');
}

// =====================================================================
// Boot
// =====================================================================

async function main() {
    try {
        initGL();
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
