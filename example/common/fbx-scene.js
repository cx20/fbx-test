// fbx-scene.js — shared FBX scene helpers used by the WebGL / WebGPU viewers.
//
// Exposes a global `FBXScene` namespace with:
//   Asset config:        ASSETS, FBX_BASE, MAX_BONES, MAX_MORPHS, SCALES, modelUrl
//   URL parameters:      createParams() → { asset, animate, time, morph, clip }
//   Transform helpers:   getProps70, eulerToMat4, makeLocalMatrix
//   Animation sampling:  getCurveData, sampleCurve, buildAnimation,
//                        buildMorphAnimation, sampleAnimation
//
// Everything in this file is GPU-API independent — it only depends on
// FBXParser (binary/ASCII parser) and gl-matrix.

(function (root) {

const { findNode, findNodes, prop0, FBX_TIME_UNIT_SECONDS } = root.FBXParser;
const { mat4, mat3, vec3 } = root.glMatrix;

// =====================================================================
// Asset configuration
// =====================================================================

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

// =====================================================================
// URL parameters → initial PARAMS object
// =====================================================================

function getBoolParam(searchParams, key, defaultValue) {
    const v = searchParams.get(key);
    if (v === null) return defaultValue;
    return !['0', 'false', 'off', 'no'].includes(v.toLowerCase());
}

function getInitialModel(searchParams) {
    const wanted = searchParams.get('model');
    return ASSETS.includes(wanted) ? wanted : ASSETS[0];
}

function createParams() {
    const sp = new URLSearchParams(root.location.search);
    return {
        asset:    getInitialModel(sp),
        animate:  getBoolParam(sp, 'animation', true),
        time:     Number(sp.get('time')) || 0,
        morph:    Number(sp.get('morph')) || 0,
        clip:     sp.get('clip') ?? null, // honored once on first load
        skeleton: getBoolParam(sp, 'skeleton', false),
    };
}

// =====================================================================
// FBX transform helpers
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

// =====================================================================
// Animation curve sampling
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
// FBX Geometry → renderable mesh (CPU-side expansion)
// =====================================================================

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
// `materialColors` is currently unused but kept for future per-polygon color
// baking experiments; the caller passes it for forward compatibility.
// If `geometricTransform` is provided ({ T, R, S }) it is baked into vertex
// positions and normals here so skinned meshes (where it can't be applied
// externally via the model matrix) still see it. The non-skinned path in
// getWorldMatrix() no longer needs to append it for these meshes.
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

    // Per-polygon material index. The geometry can carry a LayerElementMaterial
    // that assigns a material slot to each polygon (e.g. Head_69 with 43 slots,
    // or morph-translation's paillottes whose 576 polygons split 50/50 between
    // two textured materials). We bucket the polygon-corner indices by material
    // index here so the renderer can issue one draw call per material with the
    // matching baseColor / texture.
    const materialLayer = findNode(geoNode.children, 'LayerElementMaterial');
    const matsArrNode   = materialLayer ? findNode(materialLayer.children, 'Materials') : null;
    const matsArr = matsArrNode?.props[0] ?? null;

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

    // Precompute the geometric transform as a 4x4 matrix (or null when identity)
    // so it can be applied to every vertex position / normal at expansion time.
    let geoMat = null, geoNormMat = null, geoDeltaMat = null;
    if (geometricTransform) {
        const { T = [0,0,0], R = [0,0,0], S = [1,1,1] } = geometricTransform;
        const hasAny = T[0] || T[1] || T[2] || R[0] || R[1] || R[2]
                     || S[0] !== 1 || S[1] !== 1 || S[2] !== 1;
        if (hasAny) {
            geoMat = makeLocalMatrix(T, null, R, S);
            // Normal transform: rotation-only part of geoMat (no translation; uniform-scale
            // safe since we don't expect non-uniform scale on geometric transforms here).
            geoNormMat = mat3.create();
            mat3.normalFromMat4(geoNormMat, geoMat);
            // Morph deltas are direction vectors (per-vertex offsets in object space).
            // We bake the rotation+scale part of geoMat into them so they stay aligned
            // with the already-baked vertex positions; translation must not be applied
            // to a direction. morph-translation.fbx has GeometricRotation=(-180,0,0)
            // on most meshes — without this, the slider moved verts the wrong way.
            geoDeltaMat = mat3.create();
            mat3.fromMat4(geoDeltaMat, geoMat);
        }
    }
    const tmpPos = vec3.create();
    const tmpNrm = vec3.create();
    const tmpDlt = vec3.create();

    const outPositions = [];
    const outNormals   = [];
    const outColors    = [];
    const outUVs       = [];
    const outBoneIdx   = [];
    const outBoneWt    = [];
    const morphCount   = morphDeltas ? morphDeltas.length : 0;
    const outMorphs    = morphDeltas ? morphDeltas.map(() => []) : [];
    const indexBucket  = new Map(); // matIdx -> number[]
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
            if (geoDeltaMat) {
                vec3.set(tmpDlt, d[v*3], d[v*3+1], d[v*3+2]);
                vec3.transformMat3(tmpDlt, tmpDlt, geoDeltaMat);
                outMorphs[m].push(tmpDlt[0], tmpDlt[1], tmpDlt[2]);
            } else {
                outMorphs[m].push(d[v*3], d[v*3+1], d[v*3+2]);
            }
        }

        if (isEnd) {
            const matIdx = matsArr ? (matsArr[polyId] ?? 0) : 0;
            let bucket = indexBucket.get(matIdx);
            if (!bucket) { bucket = []; indexBucket.set(matIdx, bucket); }
            for (let j = polyCornerStart + 1; j < i; j++) {
                bucket.push(polyCornerStart, j, j + 1);
            }
            polyCornerStart = i + 1;
            polyId++;
        }
    }

    // Concatenate per-material index buckets into a single flat array; record
    // each material's offset/count so the renderer can drawElements / drawIndexed
    // per group. Sort by matIdx for deterministic ordering.
    const sortedKeys = [...indexBucket.keys()].sort((a, b) => a - b);
    const allIndices = [];
    const groups = [];
    for (const matIdx of sortedKeys) {
        const inds = indexBucket.get(matIdx);
        groups.push({ matIdx, offset: allIndices.length, count: inds.length });
        for (const idx of inds) allIndices.push(idx);
    }

    return {
        positions: new Float32Array(outPositions),
        normals:   new Float32Array(outNormals),
        colors:    new Float32Array(outColors),
        uvs:       new Float32Array(outUVs),
        boneIndices: skinPerVertex ? new Float32Array(outBoneIdx) : null,
        boneWeights: skinPerVertex ? new Float32Array(outBoneWt)  : null,
        morphs:    outMorphs.map(a => new Float32Array(a)),
        indices:   allIndices,               // plain number[] — converted to Uint16/Uint32 by the GPU upload layer
        groups,                              // [{ matIdx, offset, count }] — offsets/counts are in indices, not bytes
        triangleCount: allIndices.length / 3,
        // LayerElementColor takes precedence ONLY when no LayerElementMaterial
        // exists (e.g. vCube: rainbow vertex colors, no material). When the
        // geometry has a material layer, the per-group baseColor wins so that
        // stray vertex color data (e.g. Head_69's white/black LayerElementColor)
        // does not overwrite the per-polygon material colors.
        hasVertexColor: !!colorsData && !matsArr,
        hasUVs: !!uvsData,
        hasSkin: !!skinPerVertex,
    };
}

// =====================================================================
// FBX skin (Skin → Cluster → bone LimbNode)
// =====================================================================

// Walk the Geometry → Skin → Cluster → bone chain and produce per-vertex
// 4-bone influences plus parallel arrays of bone Model IDs and bind-inverse
// matrices. Returns null when the geometry isn't skinned.
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

// =====================================================================
// FBX morph targets (BlendShape → BlendShapeChannel → Shape)
// =====================================================================

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

// Compute the world matrix for a mesh / bone node by walking up its parent
// chain and accumulating local transforms (with animations applied).
// GeometricTransform is no longer appended here: it gets baked into the
// mesh's vertex positions and normals at buildMesh time, so both skinned
// and non-skinned paths see it without needing the model matrix.
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

    return world;
}

root.FBXScene = {
    ASSETS,
    FBX_BASE,
    MAX_BONES,
    MAX_MORPHS,
    SCALES,
    modelUrl,
    createParams,
    getProps70,
    eulerToMat4,
    makeLocalMatrix,
    getCurveData,
    sampleCurve,
    buildAnimation,
    buildMorphAnimation,
    sampleAnimation,
    buildMesh,
    buildSkinForGeometry,
    buildMorphForGeometry,
    getWorldMatrix,
};

})(window);
