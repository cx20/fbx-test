// WebGL 1.0 + FBX viewer
//
// Loads a small subset of FBX (binary, single static mesh + optional
// LclTranslation/LclRotation/LclScaling animation on the mesh node)
// and renders with a simple Lambert shader.

(() => {

const { parseFBX, findNode, findNodes, prop0, FBX_TIME_UNIT_SECONDS } = window.FBXParser;
const { mat4, mat3, vec3 } = window.glMatrix;

const ASSETS = [
    { name: 'monkey',                   url: '../../assets/models/fbx/monkey.fbx' },
    { name: 'monkey_embedded_texture',  url: '../../assets/models/fbx/monkey_embedded_texture.fbx' },
    { name: 'vCube',                    url: '../../assets/models/fbx/vCube.fbx' },
    { name: 'gltf/AnimatedTriangle',    url: '../../assets/models/fbx/gltf/AnimatedTriangle.fbx' },
];

const SEARCH_PARAMS = new URLSearchParams(window.location.search);

function getBoolParam(key, defaultValue) {
    const v = SEARCH_PARAMS.get(key);
    if (v === null) return defaultValue;
    return !['0', 'false', 'off', 'no'].includes(v.toLowerCase());
}

function getInitialModel() {
    const wanted = SEARCH_PARAMS.get('model');
    return ASSETS.some(a => a.name === wanted) ? wanted : ASSETS[0].name;
}

const PARAMS = {
    asset:    getInitialModel(),
    animate:  getBoolParam('animation', true),
    time:     Number(SEARCH_PARAMS.get('time')) || 0,
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
        position: gl.getAttribLocation(program, 'aPosition'),
        normal:   gl.getAttribLocation(program, 'aNormal'),
        color:    gl.getAttribLocation(program, 'aColor'),
        texCoord: gl.getAttribLocation(program, 'aTexCoord'),
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
    };

    gl.clearColor(0.627, 0.627, 0.627, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
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
    const out = { T: [0, 0, 0], R: [0, 0, 0], S: [1, 1, 1], preR: [0, 0, 0], rotOrder: 0 };
    if (!p70) return out;
    for (const p of p70.children) {
        if (p.name !== 'P' || !p.props) continue;
        const k = p.props[0];
        if (k === 'Lcl Translation' && p.props.length > 6) out.T    = [p.props[4], p.props[5], p.props[6]];
        else if (k === 'Lcl Rotation'    && p.props.length > 6) out.R    = [p.props[4], p.props[5], p.props[6]];
        else if (k === 'Lcl Scaling'     && p.props.length > 6) out.S    = [p.props[4], p.props[5], p.props[6]];
        else if (k === 'PreRotation'     && p.props.length > 6) out.preR = [p.props[4], p.props[5], p.props[6]];
        else if (k === 'RotationOrder'   && p.props.length > 4) out.rotOrder = p.props[4];
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

function makeModelMatrix(T, R, S) {
    const m = mat4.create();
    mat4.translate(m, m, T);
    const rotM = mat4.create();
    eulerToMat4(rotM, R);
    mat4.multiply(m, m, rotM);
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
function buildMesh(geoNode) {
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
        outUVs.push(uv[0], uv[1]);

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
        indices:   new Uint16Array(outIndices),
        triangleCount: outIndices.length / 3,
        hasVertexColor: !!colorsData,
        hasUVs: !!uvsData,
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

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, meshData.indices, gl.STATIC_DRAW);

    return {
        posBuf, normBuf, colorBuf, uvBuf, idxBuf,
        count: meshData.indices.length,
        hasVertexColor: meshData.hasVertexColor,
        hasUVs: meshData.hasUVs,
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

// Find a texture in FBX: returns { type:'embedded', content:ArrayBuffer }
// or { type:'external', url:string }, or null.
function extractTextureInfo(nodes, assetUrl) {
    const objects = findNode(nodes, 'Objects');
    if (!objects) return null;
    const baseUrl = assetUrl.substring(0, assetUrl.lastIndexOf('/') + 1);
    for (const vid of findNodes(objects.children, 'Video')) {
        const contentNode = findNode(vid.children, 'Content');
        if (contentNode && contentNode.props[0] instanceof ArrayBuffer) {
            return { type: 'embedded', content: contentNode.props[0] };
        }
        const relNode = findNode(vid.children, 'RelativeFilename');
        if (relNode && relNode.props[0]) {
            const rel = relNode.props[0].replace(/\\/g, '/');
            return { type: 'external', url: baseUrl + rel };
        }
    }
    return null;
}

async function loadTexture(nodes, assetUrl) {
    const info = extractTextureInfo(nodes, assetUrl);
    if (!info) return null;
    if (info.type === 'embedded') return loadTextureFromBytes(info.content);
    return loadTextureFromUrl(info.url);
}

// =====================================================================
// Scene state
// =====================================================================

let scene = null; // { gpu, baseTRS, animation }
const projection = mat4.create();
const view       = mat4.create();
const viewProj   = mat4.create();
const cameraEye    = vec3.fromValues(220, 220, 320);
const cameraTarget = vec3.fromValues(0, 50, 0);
const cameraUp     = vec3.fromValues(0, 1, 0);

async function loadModel(name) {
    const asset = ASSETS.find(a => a.name === name);
    if (!asset) return;
    setStatus(`Loading ${name} ...`);

    const buffer = await fetch(asset.url).then(r => r.arrayBuffer());
    const { nodes } = await parseFBX(buffer);

    const objects = findNode(nodes, 'Objects');
    const geoNode = findNode(objects.children, 'Geometry');
    const meshModel = findNodes(objects.children, 'Model').find(m => m.props[2] === 'Mesh');
    if (!geoNode || !meshModel) {
        setStatus(`Error: no Geometry or Mesh model in ${name}`);
        return;
    }

    const meshData = buildMesh(geoNode);
    const gpu = uploadMesh(meshData);
    const baseTRS = getProps70(meshModel);
    const animation = buildAnimation(nodes, meshModel.props[0]);

    let texture = null;
    if (meshData.hasUVs) {
        try { texture = await loadTexture(nodes, asset.url); } catch (e) { console.warn('Texture load failed:', e); }
    }

    scene = { gpu, baseTRS, animation, texture, modelName: name };
    setStatus(`${name} — triangles: ${meshData.triangleCount}${animation ? ` — anim ${animation.duration.toFixed(2)}s` : ''}`);
}

function setStatus(msg) {
    document.getElementById('status').textContent = msg;
}

// =====================================================================
// Render loop
// =====================================================================

function render(timeMs) {
    if (PARAMS.animate && scene?.animation) {
        PARAMS.time = (timeMs / 1000) % scene.animation.duration;
    }

    resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (!scene) {
        requestAnimationFrame(render);
        return;
    }

    const aspect = canvas.width / canvas.height;
    mat4.perspective(projection, 45 * Math.PI / 180, aspect, 1, 2000);
    mat4.lookAt(view, cameraEye, cameraTarget, cameraUp);
    mat4.multiply(viewProj, projection, view);

    const trs = sampleAnimation(scene.animation, PARAMS.time, scene.baseTRS);
    const model = makeModelMatrix(trs.T, trs.R, trs.S);
    const normalMat = mat3.create();
    mat3.normalFromMat4(normalMat, model);

    const hasTexture = !!(scene.texture && scene.gpu.hasUVs);

    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.viewProj, false, viewProj);
    gl.uniformMatrix4fv(uniforms.model,    false, model);
    gl.uniformMatrix3fv(uniforms.normalMat, false, normalMat);
    gl.uniform4f(uniforms.baseColor, 0.85, 0.85, 0.9, 1.0);
    gl.uniform3f(uniforms.lightDir, 0.3, 1.0, 0.5);
    gl.uniform1f(uniforms.ambient, 0.25);
    gl.uniform1i(uniforms.hasVertexColor, scene.gpu.hasVertexColor ? 1 : 0);
    gl.uniform1i(uniforms.hasTexture, hasTexture ? 1 : 0);
    gl.uniform1i(uniforms.texture, 0);

    if (hasTexture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, scene.gpu.posBuf);
    gl.enableVertexAttribArray(attribs.position);
    gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, scene.gpu.normBuf);
    gl.enableVertexAttribArray(attribs.normal);
    gl.vertexAttribPointer(attribs.normal, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, scene.gpu.colorBuf);
    gl.enableVertexAttribArray(attribs.color);
    gl.vertexAttribPointer(attribs.color, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, scene.gpu.uvBuf);
    gl.enableVertexAttribArray(attribs.texCoord);
    gl.vertexAttribPointer(attribs.texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scene.gpu.idxBuf);
    gl.drawElements(gl.TRIANGLES, scene.gpu.count, gl.UNSIGNED_SHORT, 0);

    requestAnimationFrame(render);
}

// =====================================================================
// GUI
// =====================================================================

function initGui() {
    const gui = new lil.GUI();
    gui.add(PARAMS, 'asset', ASSETS.map(a => a.name)).name('asset').onChange(loadModel);
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
