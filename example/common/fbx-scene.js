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
const { mat4 } = root.glMatrix;

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
};

})(window);
