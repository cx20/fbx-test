// fbx-loader.js
// Binary and ASCII FBX parser + Babylon.js mesh builder
// Supports: static mesh, basic skinning, and sampled skeleton animation (Phase 1)

const FBX_TIME_UNIT_SECONDS = 1 / 46186158000;

// ============================================================
// Binary Reader
// ============================================================
class FBXReader {
    constructor(buffer) {
        this.dv = new DataView(buffer);
        this.offset = 0;
    }
    getUint8()   { return this.dv.getUint8(this.offset++); }
    getInt16()   { const v = this.dv.getInt16(this.offset, true);  this.offset += 2; return v; }
    getInt32()   { const v = this.dv.getInt32(this.offset, true);  this.offset += 4; return v; }
    getUint32()  { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
    getFloat32() { const v = this.dv.getFloat32(this.offset, true);this.offset += 4; return v; }
    getFloat64() { const v = this.dv.getFloat64(this.offset, true);this.offset += 8; return v; }
    getInt64()   {
        const lo = this.getUint32(), hi = this.getUint32();
        return hi * 4294967296 + lo;
    }
    getString(len) {
        const s = new TextDecoder().decode(new Uint8Array(this.dv.buffer, this.offset, len));
        this.offset += len;
        return s;
    }
    getArrayBuffer(len) {
        const buf = this.dv.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return buf;
    }
    skip(n)       { this.offset += n; }
    skipTo(pos)   { this.offset = pos; }
    get pos()     { return this.offset; }
    get size()    { return this.dv.buffer.byteLength; }
}

// ============================================================
// Zlib decompression (browser DecompressionStream)
// ============================================================
async function zlibDecompress(arrayBuffer) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(arrayBuffer));
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
}

// ============================================================
// Property parser
// ============================================================
async function parseProp(reader) {
    const type = reader.getString(1);
    switch (type) {
        case 'C': return reader.getUint8() !== 0;
        case 'Y': return reader.getInt16();
        case 'I': return reader.getInt32();
        case 'F': return reader.getFloat32();
        case 'D': return reader.getFloat64();
        case 'L': return reader.getInt64();
        case 'S': { const n = reader.getUint32(); return reader.getString(n); }
        case 'R': { const n = reader.getUint32(); return reader.getArrayBuffer(n); }
        case 'f': case 'd': case 'i': case 'l': case 'b': case 'c': {
            const count = reader.getUint32();
            const enc   = reader.getUint32();
            const clen  = reader.getUint32();
            let raw = reader.getArrayBuffer(clen);
            if (enc === 1) raw = await zlibDecompress(raw);
            if (type === 'l') return decodeInt64Array(raw, count);
            const Ctor = { f: Float32Array, d: Float64Array, i: Int32Array,
                           b: Uint8Array,   c: Uint8Array }[type];
            return Array.from(new Ctor(raw));
        }
        default: throw new Error(`Unknown FBX property type: ${type}`);
    }
}

function decodeInt64Array(raw, count) {
    const dv = new DataView(raw);
    const values = [];
    for (let i = 0; i < count; i++) {
        const off = i * 8;
        const lo = dv.getUint32(off, true);
        const hi = dv.getInt32(off + 4, true);
        values.push(hi * 4294967296 + lo);
    }
    return values;
}

// ============================================================
// Node parser
// ============================================================
async function parseNodes(reader, endOffset, is64bit) {
    const nullSize = is64bit ? 25 : 13;
    const nodes = [];
    while (reader.pos < endOffset) {
        const nodeEnd  = is64bit ? reader.getInt64() : reader.getUint32();
        const numProps = is64bit ? reader.getInt64() : reader.getUint32();
        is64bit ? reader.getInt64() : reader.getUint32(); // propListLen
        const nameLen  = reader.getUint8();
        const name     = reader.getString(nameLen);
        if (nodeEnd === 0) break;

        const props = [];
        for (let i = 0; i < numProps; i++) props.push(await parseProp(reader));

        const children = [];
        if (reader.pos < nodeEnd - nullSize) {
            const sub = await parseNodes(reader, nodeEnd - nullSize, is64bit);
            children.push(...sub);
        }
        reader.skipTo(nodeEnd);
        nodes.push({ name, props, children });
    }
    return nodes;
}

// ============================================================
// ASCII FBX parser → same {name, props, children} tree
// ============================================================
function parseAsciiNodes(text) {
    const lines = text.split(/\r?\n/);
    let pos = 0;

    function nextContentLine() {
        while (pos < lines.length) {
            const line = lines[pos++].trim();
            if (line && !line.startsWith(';')) return line;
        }
        return null;
    }

    function parseScalarProps(str) {
        const props = [];
        let i = 0;
        while (i < str.length) {
            while (i < str.length && (str[i] === ',' || str[i] === ' ' || str[i] === '\t')) i++;
            if (i >= str.length) break;
            if (str[i] === '"') {
                let j = i + 1;
                while (j < str.length && str[j] !== '"') j++;
                props.push(str.slice(i + 1, j));
                i = j + 1;
            } else {
                let j = i;
                while (j < str.length && str[j] !== ',' && str[j] !== ' ' && str[j] !== '\t') j++;
                const token = str.slice(i, j).trim();
                if (token.length) {
                    const num = Number(token);
                    props.push(Number.isNaN(num) ? token : num);
                }
                i = j;
            }
        }
        return props;
    }

    function readArrayValues() {
        const values = [];
        while (pos < lines.length) {
            const line = lines[pos++].trim();
            if (!line || line.startsWith(';')) continue;
            if (line === '}') break;
            const start = line.startsWith('a:') ? 2 : 0;
            for (const token of line.slice(start).split(',')) {
                const t = token.trim();
                if (t) values.push(Number(t));
            }
        }
        return values;
    }

    function parseNode(line) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) return null;
        const name = line.slice(0, colonIdx).trim();
        let rest = line.slice(colonIdx + 1).trim();

        const hasBlock = rest.endsWith('{');
        if (hasBlock) rest = rest.slice(0, -1).trim();

        const props = [];
        const children = [];

        if (rest.startsWith('*')) {
            if (hasBlock) props.push(readArrayValues());
        } else {
            if (rest.length > 0) props.push(...parseScalarProps(rest));
            if (hasBlock) {
                while (true) {
                    const child = nextContentLine();
                    if (!child || child === '}') break;
                    const node = parseNode(child);
                    if (node) children.push(node);
                }
            }
        }

        return { name, props, children };
    }

    const nodes = [];
    while (true) {
        const line = nextContentLine();
        if (!line) break;
        if (line === '}') continue;
        const node = parseNode(line);
        if (node) nodes.push(node);
    }
    return nodes;
}

// ============================================================
// Parse FBX buffer (binary or ASCII) → node tree
// ============================================================
async function parseFBX(buffer) {
    const peek = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer, 0, 23));
    if (!peek.startsWith('Kaydara FBX Binary')) {
        const text = new TextDecoder().decode(buffer);
        const nodes = parseAsciiNodes(text);
        const headerExt = nodes.find(n => n.name === 'FBXHeaderExtension');
        const versionNode = headerExt?.children.find(n => n.name === 'FBXVersion');
        const version = typeof versionNode?.props[0] === 'number' ? versionNode.props[0] : 7500;
        return { version, nodes };
    }
    const reader = new FBXReader(buffer);
    reader.skip(23); // magic header
    const version = reader.getUint32();
    if (version < 7000) throw new Error(`FBX version ${version} not supported (need >= 7000)`);
    const is64bit = version >= 7500;
    const nodes = await parseNodes(reader, buffer.byteLength, is64bit);
    return { version, nodes };
}

// ============================================================
// Helpers: navigate node tree
// ============================================================
function findNode(nodes, name) {
    return nodes.find(n => n.name === name) ?? null;
}
function findNodes(nodes, name) {
    return nodes.filter(n => n.name === name);
}
function prop0(node) { return node?.props[0] ?? null; }

// Parse Properties70 block → Map<name, value>
function parseProps70(node) {
    const map = new Map();
    if (!node) return map;
    for (const p of node.children) {
        if (p.name !== 'P' || p.props.length < 5) continue;
        const key = p.props[0];
        // value starts at props[4]
        if (p.props.length === 5) map.set(key, p.props[4]);
        else map.set(key, p.props.slice(4));
    }
    return map;
}

// ============================================================
// Build Babylon.js VertexData from FBX Geometry node
// ============================================================
function buildVertexData(geoNode, geometryTransform = null, skinWeightsByVertex = null) {
    const verts    = prop0(findNode(geoNode.children, 'Vertices'));
    const polyIdx  = prop0(findNode(geoNode.children, 'PolygonVertexIndex'));
    if (!verts || !polyIdx) throw new Error('Geometry missing Vertices or PolygonVertexIndex');

    // --- Normals ---
    const lnNode   = findNode(geoNode.children, 'LayerElementNormal');
    let normVals = null, normIdx = null, normMapping = 'ByPolygonVertex', normRef = 'Direct';
    if (lnNode) {
        normVals    = prop0(findNode(lnNode.children, 'Normals'));
        normIdx     = prop0(findNode(lnNode.children, 'NormalsIndex'));
        normMapping = prop0(findNode(lnNode.children, 'MappingInformationType')) ?? normMapping;
        normRef     = prop0(findNode(lnNode.children, 'ReferenceInformationType')) ?? normRef;
    }

    // --- UVs ---
    const uvNode   = findNode(geoNode.children, 'LayerElementUV');
    let uvVals = null, uvIdx = null, uvMapping = 'ByPolygonVertex', uvRef = 'Direct';
    if (uvNode) {
        uvVals    = prop0(findNode(uvNode.children, 'UV'));
        uvIdx     = prop0(findNode(uvNode.children, 'UVIndex'));
        uvMapping = prop0(findNode(uvNode.children, 'MappingInformationType')) ?? uvMapping;
        uvRef     = prop0(findNode(uvNode.children, 'ReferenceInformationType')) ?? uvRef;
    }

    // --- Vertex Colors ---
    const lcNode = findNode(geoNode.children, 'LayerElementColor');
    let colVals = null, colIdx = null, colMapping = 'ByPolygonVertex', colRef = 'Direct';
    if (lcNode) {
        colVals    = prop0(findNode(lcNode.children, 'Colors'));
        colIdx     = prop0(findNode(lcNode.children, 'ColorIndex'));
        colMapping = prop0(findNode(lcNode.children, 'MappingInformationType')) ?? colMapping;
        colRef     = prop0(findNode(lcNode.children, 'ReferenceInformationType')) ?? colRef;
    }

    // --- Triangulate polygons ---
    // PolygonVertexIndex: negative value = end of polygon, actual index = ~v
    const positions = [], normals = [], uvs = [], colors = [], indices = [];
    const matricesIndices = [], matricesWeights = [];
    let vertexCount = 0;
    let pvGlobal = 0; // running polygon-vertex counter
    let polyGlobal = 0;

    // Split polyIdx into polygon groups
    const polygons = [];
    let curPoly = [];
    for (const v of polyIdx) {
        if (v < 0) { curPoly.push(~v); polygons.push(curPoly); curPoly = []; }
        else        { curPoly.push(v); }
    }

    for (const poly of polygons) {
        const n = poly.length;
        if (n < 3) { pvGlobal += n; polyGlobal++; continue; }

        // Fan triangulation: [0,1,2], [0,2,3], ...
        // NOTE: Z-negate (RH→LH) is absorbed by Babylon.js LH view matrix — no winding reversal needed
        for (let i = 1; i < n - 1; i++) {
            for (const vi of [0, i, i + 1]) {
                const posI = poly[vi];
                const pvI  = pvGlobal + vi;

                // Position (negate Z: RH→LH), then apply FBX geometric transform.
                const px = verts[posI * 3];
                const py = verts[posI * 3 + 1];
                const pz = -verts[posI * 3 + 2];
                const p = geometryTransform
                    ? applyGeometryTransformToPoint(px, py, pz, geometryTransform)
                    : [px, py, pz];
                positions.push(p[0], p[1], p[2]);

                if (skinWeightsByVertex) {
                    const skin = getSkinInfluencesForVertex(skinWeightsByVertex[posI]);
                    matricesIndices.push(skin.indices[0], skin.indices[1], skin.indices[2], skin.indices[3]);
                    matricesWeights.push(skin.weights[0], skin.weights[1], skin.weights[2], skin.weights[3]);
                }

                // Normal (negate Z)
                if (normVals) {
                    let ni;
                    if (normMapping === 'ByPolygonVertex') {
                        ni = normRef === 'IndexToDirect' ? normIdx[pvI] : pvI;
                    } else if (normMapping === 'ByVertice' || normMapping === 'ByVertex') {
                        ni = normRef === 'IndexToDirect' ? normIdx[posI] : posI;
                    } else {
                        ni = normRef === 'IndexToDirect' ? normIdx[polyGlobal] : polyGlobal;
                    }
                    const nx = normVals[ni * 3];
                    const ny = normVals[ni * 3 + 1];
                    const nz = -normVals[ni * 3 + 2];
                    const n = geometryTransform
                        ? applyGeometryTransformToNormal(nx, ny, nz, geometryTransform)
                        : [nx, ny, nz];
                    normals.push(n[0], n[1], n[2]);
                }

                // UV: pass through raw FBX UVs; Babylon.js Texture default invertY=true handles V flip
                if (uvVals) {
                    let ui;
                    if (uvMapping === 'ByPolygonVertex') {
                        ui = uvRef === 'IndexToDirect' ? uvIdx[pvI] : pvI;
                    } else if (uvMapping === 'ByVertice' || uvMapping === 'ByVertex') {
                        ui = uvRef === 'IndexToDirect' ? uvIdx[posI] : posI;
                    } else {
                        ui = uvRef === 'IndexToDirect' ? uvIdx[polyGlobal] : polyGlobal;
                    }
                    uvs.push(uvVals[ui * 2], uvVals[ui * 2 + 1]);
                }

                // Vertex Color (RGBA)
                if (colVals) {
                    let ci;
                    if (colMapping === 'ByPolygonVertex') {
                        ci = colRef === 'IndexToDirect' ? colIdx[pvI] : pvI;
                    } else if (colMapping === 'ByVertice' || colMapping === 'ByVertex') {
                        ci = colRef === 'IndexToDirect' ? colIdx[posI] : posI;
                    } else {
                        ci = colRef === 'IndexToDirect' ? colIdx[polyGlobal] : polyGlobal;
                    }
                    colors.push(colVals[ci * 4], colVals[ci * 4 + 1], colVals[ci * 4 + 2], colVals[ci * 4 + 3]);
                }

                indices.push(vertexCount++);
            }
        }
        pvGlobal += n;
        polyGlobal++;
    }

    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices   = indices;
    if (normals.length) vd.normals = normals;
    if (uvs.length)     vd.uvs     = uvs;
    if (colors.length)  vd.colors  = colors;
    if (matricesIndices.length) vd.matricesIndices = matricesIndices;
    if (matricesWeights.length) vd.matricesWeights = matricesWeights;
    return vd;
}

function getSkinInfluencesForVertex(influences) {
    if (!influences || !influences.length) {
        return { indices: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
    }

    const sorted = influences
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 4);

    const total = sorted.reduce((sum, item) => sum + item.weight, 0) || 1;
    const indices = [0, 0, 0, 0];
    const weights = [0, 0, 0, 0];
    for (let i = 0; i < sorted.length; i++) {
        indices[i] = sorted[i].boneIndex;
        weights[i] = sorted[i].weight / total;
    }
    return { indices, weights };
}

// ============================================================
// Build transform from Model node
// ============================================================
function getModelTransform(modelNode) {
    const p70 = parseProps70(findNode(modelNode.children, 'Properties70'));
    const T        = p70.get('Lcl Translation') ?? [0, 0, 0];
    const R        = p70.get('Lcl Rotation')    ?? [0, 0, 0];
    const S        = p70.get('Lcl Scaling')     ?? [1, 1, 1];
    const preR     = p70.get('PreRotation')     ?? [0, 0, 0];
    const rotOrder = p70.get('RotationOrder')   ?? 0;
    const geoT     = p70.get('GeometricTranslation') ?? [0, 0, 0];
    const geoR     = p70.get('GeometricRotation')    ?? [0, 0, 0];
    const geoS     = p70.get('GeometricScaling')     ?? [1, 1, 1];
    return { T, R, S, preR, rotOrder, geoT, geoR, geoS };
}

// Convert FBX Euler (degrees) → Babylon.js quaternion under RH→LH (Z-negate) conversion.
// M_Z conjugation rules: Rx(a)→Rx(-a), Ry(a)→Ry(-a), Rz(a)→Rz(a).
// FBX RotationOrder specifies the application order (first letter applied first to vector).
// For order ABC: R_fbx = Rc·Rb·Ra in matrix form; BJS q1.multiply(q2) applies q2 first.
// PreRotation is always XYZ (order=0) per FBX spec; LclRotation uses the node's rotOrder.
function fbxEulerToQuat(deg, rotOrder = 0) {
    const rx = BABYLON.Tools.ToRadians(deg[0]);
    const ry = BABYLON.Tools.ToRadians(deg[1]);
    const rz = BABYLON.Tools.ToRadians(deg[2]);
    const Rx = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, -rx);
    const Ry = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, -ry);
    const Rz = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z,  rz);
    switch (rotOrder) {
        case 1: return Ry.multiply(Rz).multiply(Rx); // XZY
        case 2: return Rx.multiply(Rz).multiply(Ry); // YZX
        case 3: return Rz.multiply(Rx).multiply(Ry); // YXZ
        case 4: return Ry.multiply(Rx).multiply(Rz); // ZXY
        case 5: return Rx.multiply(Ry).multiply(Rz); // ZYX
        default: return Rz.multiply(Ry).multiply(Rx); // XYZ (0) — default
    }
}

function hasNonIdentityGeometryTransform({ geoT, geoR, geoS }) {
    const eps = 1e-8;
    return Math.abs(geoT[0]) > eps || Math.abs(geoT[1]) > eps || Math.abs(geoT[2]) > eps ||
           Math.abs(geoR[0]) > eps || Math.abs(geoR[1]) > eps || Math.abs(geoR[2]) > eps ||
           Math.abs(geoS[0] - 1) > eps || Math.abs(geoS[1] - 1) > eps || Math.abs(geoS[2] - 1) > eps;
}

function makeGeometryTransform(modelTransform) {
    if (!hasNonIdentityGeometryTransform(modelTransform)) return null;
    const { geoT, geoR, geoS, rotOrder } = modelTransform;
    return {
        translation: new BABYLON.Vector3(geoT[0], geoT[1], -geoT[2]),
        rotation: fbxEulerToQuat(geoR, rotOrder),
        scaling: new BABYLON.Vector3(geoS[0], geoS[1], geoS[2]),
    };
}

function rotateVectorByQuaternion(x, y, z, q) {
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    return [
        x + q.w * tx + (q.y * tz - q.z * ty),
        y + q.w * ty + (q.z * tx - q.x * tz),
        z + q.w * tz + (q.x * ty - q.y * tx),
    ];
}

function applyGeometryTransformToPoint(x, y, z, transform) {
    const sx = x * transform.scaling.x;
    const sy = y * transform.scaling.y;
    const sz = z * transform.scaling.z;
    const r = rotateVectorByQuaternion(sx, sy, sz, transform.rotation);
    return [
        r[0] + transform.translation.x,
        r[1] + transform.translation.y,
        r[2] + transform.translation.z,
    ];
}

function applyGeometryTransformToNormal(x, y, z, transform) {
    // Inverse-scale before rotation is the normal-matrix equivalent for TRS.
    const sx = transform.scaling.x !== 0 ? x / transform.scaling.x : x;
    const sy = transform.scaling.y !== 0 ? y / transform.scaling.y : y;
    const sz = transform.scaling.z !== 0 ? z / transform.scaling.z : z;
    const r = rotateVectorByQuaternion(sx, sy, sz, transform.rotation);
    const len = Math.hypot(r[0], r[1], r[2]) || 1;
    return [r[0] / len, r[1] / len, r[2] / len];
}

function makeBabylonLocalMatrixFromTransform({ T, R, S, preR, rotOrder }) {
    const position = new BABYLON.Vector3(T[0], T[1], -T[2]);
    const rotation = fbxEulerToQuat(preR, 0).multiply(fbxEulerToQuat(R, rotOrder));
    const scaling = new BABYLON.Vector3(S[0], S[1], S[2]);
    return BABYLON.Matrix.Compose(scaling, rotation, position);
}

function makeBabylonLocalMatrix(modelNode) {
    return makeBabylonLocalMatrixFromTransform(getModelTransform(modelNode));
}

function getAnimationAxis(prop) {
    if (!prop) return -1;
    if (prop.endsWith('X')) return 0;
    if (prop.endsWith('Y')) return 1;
    if (prop.endsWith('Z')) return 2;
    return -1;
}

function getCurveData(curveNode) {
    const keyTimes = prop0(findNode(curveNode.children, 'KeyTime')) ?? [];
    const keyValues = prop0(findNode(curveNode.children, 'KeyValueFloat')) ?? [];
    return {
        times: keyTimes.map(t => t * FBX_TIME_UNIT_SECONDS),
        values: keyValues,
    };
}

function sampleCurve(curve, time, fallback) {
    if (!curve || !curve.times.length || !curve.values.length) return fallback;
    const times = curve.times;
    const values = curve.values;
    if (time <= times[0]) return values[0];
    const last = times.length - 1;
    if (time >= times[last]) return values[last];

    let lo = 0;
    let hi = last;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= time) lo = mid;
        else hi = mid;
    }

    const span = times[hi] - times[lo] || 1;
    const t = (time - times[lo]) / span;
    return values[lo] + (values[hi] - values[lo]) * t;
}

function sampleCurveNode(channel, time, fallback) {
    return [
        sampleCurve(channel?.curves[0], time, channel?.defaults[0] ?? fallback[0]),
        sampleCurve(channel?.curves[1], time, channel?.defaults[1] ?? fallback[1]),
        sampleCurve(channel?.curves[2], time, channel?.defaults[2] ?? fallback[2]),
    ];
}

// Detect image MIME type from raw bytes (for embedded FBX textures)
function detectImageMimeType(buffer) {
    const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    return 'image/png';
}

// ============================================================
// Main: load FBX URL and build Babylon.js meshes
// ============================================================
async function loadFBX(url, scene, options = {}) {
    console.log(`[FBX] Fetching: ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const buffer = await response.arrayBuffer();

    console.log(`[FBX] Parsing binary FBX (${buffer.byteLength} bytes)...`);
    const { version, nodes } = await parseFBX(buffer);
    console.log(`[FBX] Version: ${version}, top-level nodes: ${nodes.map(n => n.name).join(', ')}`);

    const objectsNode = findNode(nodes, 'Objects');
    if (!objectsNode) throw new Error('No Objects section found');

    const connsNode  = findNode(nodes, 'Connections');
    const connList   = connsNode
        ? connsNode.children.filter(c => c.name === 'C')
              .map(c => ({ type: c.props[0], from: c.props[1], to: c.props[2], prop: c.props[3] ?? null }))
        : [];

    // Base directory URL for resolving relative texture paths
    const baseDir = url.substring(0, url.lastIndexOf('/') + 1);

    // Index objects by id
    const geoById      = new Map();
    const modelById    = new Map(); // Mesh-type Model nodes
    const allModelById = new Map(); // ALL Model nodes (Mesh, LimbNode, Null, ...)
    const matById      = new Map();
    const skinById     = new Map();
    const clusterById  = new Map();
    const animStackById = new Map();
    const animLayerById = new Map();
    const animCurveNodeById = new Map();
    const animCurveById = new Map();
    const texById   = new Map(); // id → { relativeFilename }
    const videoById = new Map(); // id → ArrayBuffer (embedded image content)
    for (const obj of objectsNode.children) {
        const id = obj.props[0];
        if (obj.name === 'Geometry' && obj.props[2] === 'Mesh') geoById.set(id, obj);
        if (obj.name === 'Model') {
            allModelById.set(id, obj);
            if (obj.props[2] === 'Mesh') modelById.set(id, obj);
        }
        if (obj.name === 'Material') matById.set(id, obj);
        if (obj.name === 'Deformer' && obj.props[2] === 'Skin') skinById.set(id, obj);
        if (obj.name === 'Deformer' && obj.props[2] === 'Cluster') clusterById.set(id, obj);
        if (obj.name === 'AnimationStack') animStackById.set(id, obj);
        if (obj.name === 'AnimationLayer') animLayerById.set(id, obj);
        if (obj.name === 'AnimationCurveNode') animCurveNodeById.set(id, obj);
        if (obj.name === 'AnimationCurve') animCurveById.set(id, obj);
        if (obj.name === 'Texture') {
            const relFn = prop0(findNode(obj.children, 'RelativeFilename')) ?? '';
            texById.set(id, { relativeFilename: relFn.replace(/\\/g, '/') });
        }
        if (obj.name === 'Video') {
            const raw = findNode(obj.children, 'Content')?.props[0];
            if (raw instanceof ArrayBuffer && raw.byteLength > 0) videoById.set(id, raw);
        }
    }

    // Build connection maps
    const geoToModel   = new Map(); // geoId  → modelId
    const modelToMats  = new Map(); // modelId → matId[] (all materials in connection order)
    const matToTex     = new Map(); // matId   → texId  (first match)
    const texToVideo   = new Map(); // texId   → videoId (embedded texture)
    const nodeToParent = new Map(); // nodeId  → parentId (OO; 0 = scene root)
    const geoToSkin    = new Map(); // geoId   → skinId
    const skinToClusters = new Map(); // skinId → clusterId[]
    const clusterToBoneModel = new Map(); // clusterId → modelId
    const animLayerToStack = new Map(); // layerId → stackId
    const animCurveNodeToLayer = new Map(); // curveNodeId → layerId
    const animCurveNodeToTarget = new Map(); // curveNodeId → { modelId, property }
    const animCurvesByNode = new Map(); // curveNodeId → AnimationCurve[3]
    for (const c of connList) {
        if (geoById.has(c.from) && modelById.has(c.to)) geoToModel.set(c.from, c.to);
        if (matById.has(c.from) && modelById.has(c.to)) {
            if (!modelToMats.has(c.to)) modelToMats.set(c.to, []);
            modelToMats.get(c.to).push(c.from);
        }
        if (texById.has(c.from) && matById.has(c.to)   && !matToTex.has(c.to))   matToTex.set(c.to, c.from);
        if (videoById.has(c.from) && texById.has(c.to)) texToVideo.set(c.to, c.from);
        if (skinById.has(c.from) && geoById.has(c.to)) geoToSkin.set(c.to, c.from);
        if (clusterById.has(c.from) && skinById.has(c.to)) {
            if (!skinToClusters.has(c.to)) skinToClusters.set(c.to, []);
            skinToClusters.get(c.to).push(c.from);
        }
        if (allModelById.has(c.from) && clusterById.has(c.to)) clusterToBoneModel.set(c.to, c.from);
        if (animLayerById.has(c.from) && animStackById.has(c.to)) animLayerToStack.set(c.from, c.to);
        if (animCurveNodeById.has(c.from) && animLayerById.has(c.to)) animCurveNodeToLayer.set(c.from, c.to);
        if (animCurveNodeById.has(c.from) && allModelById.has(c.to)) {
            animCurveNodeToTarget.set(c.from, { modelId: c.to, property: c.prop });
        }
        if (animCurveById.has(c.from) && animCurveNodeById.has(c.to)) {
            const axis = getAnimationAxis(c.prop);
            if (axis >= 0) {
                if (!animCurvesByNode.has(c.to)) animCurvesByNode.set(c.to, [null, null, null]);
                animCurvesByNode.get(c.to)[axis] = animCurveById.get(c.from);
            }
        }
        if (c.type === 'OO' && allModelById.has(c.from) && !nodeToParent.has(c.from)) {
            nodeToParent.set(c.from, c.to);
        }
    }

    console.log(`[FBX] Geometries: ${geoById.size}, Models: ${modelById.size}, Materials: ${matById.size}, Textures: ${texById.size}, Videos: ${videoById.size}, Skins: ${skinById.size}, AnimationStacks: ${animStackById.size}`);

    // Return the material index (into the per-model materials array) used by the most polygons.
    // Parses LayerElementMaterial so multi-material meshes select their dominant material.
    function getDominantMaterialIndex(geoNode) {
        const lmNode = findNode(geoNode.children, 'LayerElementMaterial');
        if (!lmNode) return 0;
        const mapping   = prop0(findNode(lmNode.children, 'MappingInformationType')) ?? 'AllSame';
        const matIndices = prop0(findNode(lmNode.children, 'Materials')) ?? [];
        if (mapping === 'AllSame' || !matIndices.length) return matIndices[0] ?? 0;
        const counts = new Map();
        for (const idx of matIndices) counts.set(idx, (counts.get(idx) ?? 0) + 1);
        let best = 0, bestCount = 0;
        for (const [idx, count] of counts) {
            if (count > bestCount) { best = idx; bestCount = count; }
        }
        return best;
    }

    function getTriangleMaterialIndices(geoNode) {
        const lmNode = findNode(geoNode.children, 'LayerElementMaterial');
        if (!lmNode) return null;
        const mapping    = prop0(findNode(lmNode.children, 'MappingInformationType')) ?? 'AllSame';
        const matIndices = prop0(findNode(lmNode.children, 'Materials')) ?? [];
        if (mapping === 'AllSame' || !matIndices.length) return null;
        const polyIdx = prop0(findNode(geoNode.children, 'PolygonVertexIndex')) ?? [];
        const triMatIndices = [];
        let polyGlobal = 0, polyLen = 0;
        for (const v of polyIdx) {
            polyLen++;
            if (v < 0) {
                if (polyLen >= 3) {
                    const matIdx = matIndices[polyGlobal] ?? 0;
                    for (let t = 0; t < polyLen - 2; t++) triMatIndices.push(matIdx);
                }
                polyLen = 0;
                polyGlobal++;
            }
        }
        return triMatIndices.length ? triMatIndices : null;
    }

    function applyFbxTransform(bjsNode, fbxModelNode) {
        const { T, R, S, preR, rotOrder, geoT, geoR, geoS } = getModelTransform(fbxModelNode);
        bjsNode.position.set(T[0], T[1], -T[2]);
        // FBX total rotation = M_preR × M_LclR; in BJS q1.multiply(q2)=M_q1×M_q2, so preR goes first.
        // PreRotation is always XYZ (order 0) per FBX spec; LclRotation uses the node's rotOrder.
        bjsNode.rotationQuaternion = fbxEulerToQuat(preR, 0).multiply(fbxEulerToQuat(R, rotOrder));
        bjsNode.scaling.set(S[0], S[1], S[2]);
        return { T, R, S, preR, rotOrder, geoT, geoR, geoS };
    }

    function getModelDisplayName(modelNode, fallback) {
        const rawName = modelNode?.props[1] ?? '';
        return rawName.split('\0')[0].replace(/Model$/, '') || fallback;
    }

    function orderBoneModelIds(boneModelIds) {
        const boneModelSet = new Set(boneModelIds);
        const childrenByBoneId = new Map();
        const rootBoneIds = [];
        for (const boneModelId of boneModelIds) {
            const parentId = nodeToParent.get(boneModelId);
            if (boneModelSet.has(parentId)) {
                if (!childrenByBoneId.has(parentId)) childrenByBoneId.set(parentId, []);
                childrenByBoneId.get(parentId).push(boneModelId);
            } else {
                rootBoneIds.push(boneModelId);
            }
        }

        const orderedBoneIds = [];
        const visited = new Set();
        function visit(boneModelId) {
            if (visited.has(boneModelId)) return;
            visited.add(boneModelId);
            orderedBoneIds.push(boneModelId);
            for (const childId of childrenByBoneId.get(boneModelId) ?? []) visit(childId);
        }
        for (const rootBoneId of rootBoneIds) visit(rootBoneId);
        for (const boneModelId of boneModelIds) visit(boneModelId);
        return { orderedBoneIds, rootBoneIds, boneModelSet };
    }

    function getSkeletonName(orderedBoneIds, rootBoneIds, nameHint) {
        const rootParentIds = [...new Set(rootBoneIds.map(id => nodeToParent.get(id)).filter(id => id && id !== 0))];
        if (rootParentIds.length === 1 && allModelById.has(rootParentIds[0])) {
            return getModelDisplayName(allModelById.get(rootParentIds[0]), nameHint);
        }

        const firstBoneName = getModelDisplayName(allModelById.get(orderedBoneIds[0]), '');
        if (firstBoneName.startsWith('mixamorig:')) return 'Armature';
        return `${nameHint}_skeleton`;
    }

    const sharedSkeletonByBoneKey = new Map();

    function createSkeletonForSkin(skinId, nameHint) {
        const clusterIds = skinToClusters.get(skinId) ?? [];
        const boneModelIds = [];
        const clusterByBoneModelId = new Map();

        for (const clusterId of clusterIds) {
            const boneModelId = clusterToBoneModel.get(clusterId);
            if (boneModelId === undefined || !allModelById.has(boneModelId)) continue;
            if (!clusterByBoneModelId.has(boneModelId)) boneModelIds.push(boneModelId);
            clusterByBoneModelId.set(boneModelId, clusterId);
        }

        if (!boneModelIds.length) return null;

        // Add bridge bones: LimbNode ancestors that have no vertex weights themselves
        // but sit between two skinned bones (e.g. clavicles between Neck and UpperArm).
        // Walk up from each skinned bone; if a skinned ancestor is found before the
        // scene root, every intermediate LimbNode/Root bone in the chain is a bridge.
        {
            const boneSet = new Set(boneModelIds);
            const bridgeBones = [];
            for (const boneModelId of boneModelIds) {
                const chain = [];
                let parentId = nodeToParent.get(boneModelId);
                while (parentId && parentId !== 0 && allModelById.has(parentId)) {
                    if (boneSet.has(parentId)) {
                        for (const bid of chain) {
                            const btype = allModelById.get(bid)?.props[2];
                            if ((btype === 'LimbNode' || btype === 'Root') && !boneSet.has(bid)) {
                                boneSet.add(bid);
                                bridgeBones.push(bid);
                            }
                        }
                        break;
                    }
                    chain.push(parentId);
                    parentId = nodeToParent.get(parentId);
                }
            }
            boneModelIds.push(...bridgeBones);
        }

        // Climb up one level from the current skeleton root bones. If all roots share a
        // single LimbNode/Root parent that is not yet in the skeleton, add it so it can
        // be animated. Without this, the top-most biped bone (e.g. "Bip001") becomes a
        // static TransformNode whose rotation is never updated, corrupting skinning.
        // We intentionally stop after one level — climbing further risks adding FBX
        // container/grouping nodes (which also use LimbNode type) that have non-trivial
        // transforms, which would corrupt the skeleton's world-space positions.
        {
            const tempSet = new Set(boneModelIds);
            const tempRoots = boneModelIds.filter(id => !tempSet.has(nodeToParent.get(id)));
            const rootParentIds = [...new Set(
                tempRoots.map(id => nodeToParent.get(id)).filter(id => id && id !== 0)
            )];
            if (rootParentIds.length === 1) {
                const parentId = rootParentIds[0];
                if (!tempSet.has(parentId) && allModelById.has(parentId)) {
                    const ptype = allModelById.get(parentId)?.props[2];
                    if (ptype === 'LimbNode' || ptype === 'Root') {
                        boneModelIds.push(parentId);
                    }
                }
            }
        }

        const { orderedBoneIds, rootBoneIds, boneModelSet } = orderBoneModelIds(boneModelIds);
        const boneKey = orderedBoneIds.join('|');
        let shared = sharedSkeletonByBoneKey.get(boneKey);
        if (!shared) {
            const skeletonName = getSkeletonName(orderedBoneIds, rootBoneIds, nameHint);
            const skeleton = new BABYLON.Skeleton(skeletonName, skeletonName, scene);
            const boneByModelId = new Map();
            const boneIndexByModelId = new Map();
            const nodeByModelId = new Map();
            for (const boneModelId of orderedBoneIds) {
                const boneModelNode = allModelById.get(boneModelId);
                const boneName = getModelDisplayName(boneModelNode, `bone_${boneModelId}`);
                const parentBone = boneByModelId.get(nodeToParent.get(boneModelId)) ?? null;
                const bone = new BABYLON.Bone(boneName, skeleton, parentBone, makeBabylonLocalMatrix(boneModelNode));
                boneByModelId.set(boneModelId, bone);
                boneIndexByModelId.set(boneModelId, skeleton.bones.length - 1);
            }
            shared = {
                skeleton,
                boneByModelId,
                boneIndexByModelId,
                nodeByModelId,
                orderedBoneIds,
                rootBoneIds,
                boneModelSet,
            };
            sharedSkeletonByBoneKey.set(boneKey, shared);
        }

        return { ...shared, clusterByBoneModelId };
    }

    function buildSkinWeightsByVertex(geoNode, skinInfo) {
        if (!skinInfo) return null;
        const verts = prop0(findNode(geoNode.children, 'Vertices'));
        if (!verts) return null;
        const weightsByVertex = Array.from({ length: verts.length / 3 }, () => []);

        for (const [boneModelId, clusterId] of skinInfo.clusterByBoneModelId) {
            const clusterNode = clusterById.get(clusterId);
            const vertexIndices = prop0(findNode(clusterNode.children, 'Indexes')) ?? [];
            const weights = prop0(findNode(clusterNode.children, 'Weights')) ?? [];
            const boneIndex = skinInfo.boneIndexByModelId.get(boneModelId);
            if (boneIndex === undefined) continue;

            for (let i = 0; i < vertexIndices.length; i++) {
                const vertexIndex = vertexIndices[i];
                const weight = weights[i] ?? 0;
                if (weight > 0 && weightsByVertex[vertexIndex]) {
                    weightsByVertex[vertexIndex].push({ boneIndex, weight });
                }
            }
        }

        return weightsByVertex;
    }

    function getAllAnimationLayerIds() {
        // Return one layerId per AnimationStack, in FBX file order.
        const seen = new Set();
        const result = [];
        for (const stackId of animStackById.keys()) {
            for (const [layerId, sid] of animLayerToStack) {
                if (sid === stackId && !seen.has(layerId)) {
                    seen.add(layerId);
                    result.push(layerId);
                    break;
                }
            }
        }
        return result;
    }

    function makeAnimationChannel(curveNodeId) {
        const curveNode = animCurveNodeById.get(curveNodeId);
        const props = parseProps70(findNode(curveNode.children, 'Properties70'));
        const curveNodes = animCurvesByNode.get(curveNodeId) ?? [null, null, null];
        const curves = curveNodes.map(curveNode => curveNode ? getCurveData(curveNode) : null);
        return {
            defaults: [
                props.get('d|X') ?? 0,
                props.get('d|Y') ?? 0,
                props.get('d|Z') ?? 0,
            ],
            curves,
        };
    }

    function createSkeletonAnimationRuntime(skinInfo, layerId) {
        if (!layerId || !skinInfo?.boneByModelId?.size) return null;

        const channelsByBoneModelId = new Map();
        let start = Infinity;
        let stop = -Infinity;

        for (const [curveNodeId, target] of animCurveNodeToTarget) {
            if (animCurveNodeToLayer.get(curveNodeId) !== layerId) continue;
            if (!skinInfo.boneByModelId.has(target.modelId)) continue;

            const key = target.property === 'Lcl Translation'
                ? 'T'
                : target.property === 'Lcl Rotation'
                    ? 'R'
                    : target.property === 'Lcl Scaling'
                        ? 'S'
                        : null;
            if (!key) continue;

            const channel = makeAnimationChannel(curveNodeId);
            for (const curve of channel.curves) {
                if (!curve?.times.length) continue;
                start = Math.min(start, curve.times[0]);
                stop = Math.max(stop, curve.times[curve.times.length - 1]);
            }

            if (!channelsByBoneModelId.has(target.modelId)) channelsByBoneModelId.set(target.modelId, {});
            channelsByBoneModelId.get(target.modelId)[key] = channel;
        }

        if (!channelsByBoneModelId.size || stop <= start) return null;

        const stackId = animLayerToStack.get(layerId);
        const stackName = animStackById.get(stackId)?.props[1]?.split('\0')[0] ?? 'animation';
        return {
            name: stackName,
            start,
            stop,
            duration: stop - start,
            channelsByBoneModelId,
            elapsed: 0,
        };
    }

    function applySkeletonAnimation(skinInfo, runtime, time) {
        for (const [boneModelId, channels] of runtime.channelsByBoneModelId) {
            const bone = skinInfo.boneByModelId.get(boneModelId);
            const modelNode = allModelById.get(boneModelId);
            if (!bone || !modelNode) continue;

            const base = getModelTransform(modelNode);
            const T = sampleCurveNode(channels.T, time, base.T);
            const R = sampleCurveNode(channels.R, time, base.R);
            const S = sampleCurveNode(channels.S, time, base.S);
            const matrix = makeBabylonLocalMatrixFromTransform({
                T,
                R,
                S,
                preR: base.preR,
                rotOrder: base.rotOrder,
            });

            if (typeof bone.updateMatrix === 'function') {
                bone.updateMatrix(matrix, false, true);
            }
            const boneNode = skinInfo.nodeByModelId?.get(boneModelId);
            if (boneNode) {
                const scaling = new BABYLON.Vector3();
                const rotation = new BABYLON.Quaternion();
                const position = new BABYLON.Vector3();
                matrix.decompose(scaling, rotation, position);
                boneNode.position.copyFrom(position);
                boneNode.rotationQuaternion = rotation;
                boneNode.scaling.copyFrom(scaling);
            }
        }
        if (typeof skinInfo.skeleton.prepare === 'function') skinInfo.skeleton.prepare();
    }

    function createSkeletonAnimationControl(skinInfo, runtime, initiallyPlaying = true) {
        const control = {
            name: runtime.name,
            duration: runtime.duration,
            time: 0,
            playing: initiallyPlaying && options.animation !== false,
            observer: null,
            setTime(time) {
                this.time = ((time % runtime.duration) + runtime.duration) % runtime.duration;
                runtime.elapsed = this.time;
                applySkeletonAnimation(skinInfo, runtime, runtime.start + this.time);
            },
            setPlaying(playing) {
                this.playing = playing;
            },
            dispose() {
                if (this.observer) scene.onBeforeRenderObservable.remove(this.observer);
                this.observer = null;
            },
        };

        control.setTime(Number.isFinite(options.animationTime) ? options.animationTime : 0);
        control.observer = scene.onBeforeRenderObservable.add(() => {
            if (!control.playing) return;
            const engine = scene.getEngine?.();
            const delta = engine ? engine.getDeltaTime() / 1000 : 1 / 60;
            control.setTime(control.time + delta);
        });
        return control;
    }

    function uniqueSkinInfos(skinInfos) {
        const seen = new Set();
        const unique = [];
        for (const skinInfo of skinInfos) {
            if (!skinInfo?.skeleton || seen.has(skinInfo.skeleton)) continue;
            seen.add(skinInfo.skeleton);
            unique.push(skinInfo);
        }
        return unique;
    }

    const bjsNodeById     = new Map();
    const allCreatedNodes = [];
    const createdMeshes   = [];
    const skinInfoBySkinId = new Map();
    const syntheticRootNodes = [];

    function createSyntheticArmatureNode(skinInfo) {
        const armature = new BABYLON.TransformNode(skinInfo.skeleton.name || 'Armature', scene);
        allCreatedNodes.push(armature);
        syntheticRootNodes.push(armature);
        return armature;
    }

    function createTransformNodeForModel(modelId) {
        if (bjsNodeById.has(modelId)) return bjsNodeById.get(modelId);
        const modelNode = allModelById.get(modelId);
        if (!modelNode) return null;

        const nodeName = getModelDisplayName(modelNode, `node_${modelId}`);
        const tn = new BABYLON.TransformNode(nodeName, scene);
        const { T, R, preR, rotOrder } = applyFbxTransform(tn, modelNode);
        console.log(`[FBX] TransformNode: ${nodeName} T=${JSON.stringify(T)} R=${JSON.stringify(R)} preR=${JSON.stringify(preR)} rotOrder=${rotOrder}`);
        bjsNodeById.set(modelId, tn);
        allCreatedNodes.push(tn);
        return tn;
    }

    function createSkeletonTransformNodes(skinInfos) {
        for (const skinInfo of uniqueSkinInfos(skinInfos)) {
            const rootParentIds = [...new Set(skinInfo.rootBoneIds.map(id => nodeToParent.get(id)).filter(id => id && id !== 0))];
            const armatureNode = rootParentIds.length === 1 && allModelById.has(rootParentIds[0])
                ? createTransformNodeForModel(rootParentIds[0])
                : createSyntheticArmatureNode(skinInfo);

            for (const boneModelId of skinInfo.orderedBoneIds) {
                const boneNode = createTransformNodeForModel(boneModelId);
                if (!boneNode) continue;
                skinInfo.nodeByModelId.set(boneModelId, boneNode);

                const parentId = nodeToParent.get(boneModelId);
                if ((!parentId || parentId === 0 || !skinInfo.boneModelSet.has(parentId)) && armatureNode) {
                    boneNode.parent = armatureNode;
                }
            }
        }
    }

    for (const [geoId, geoNode] of geoById) {
        const modelId   = geoToModel.get(geoId);
        const modelNode = modelId !== undefined ? modelById.get(modelId) : null;

        // Mesh name from Model node
        const rawName = modelNode ? (modelNode.props[1] ?? '') : '';
        const meshName = rawName.split('\0')[0].replace(/Model$/, '') || `mesh_${geoId}`;

        console.log(`[FBX] Building mesh: ${meshName}`);
        const modelTransform = modelNode ? getModelTransform(modelNode) : null;
        const geometryTransform = modelTransform ? makeGeometryTransform(modelTransform) : null;
        const skinId = geoToSkin.get(geoId);
        let skinInfo = null;
        if (skinId !== undefined) {
            if (!skinInfoBySkinId.has(skinId)) skinInfoBySkinId.set(skinId, createSkeletonForSkin(skinId, meshName));
            skinInfo = skinInfoBySkinId.get(skinId);
        }
        const skinWeightsByVertex = buildSkinWeightsByVertex(geoNode, skinInfo);
        const vd   = buildVertexData(geoNode, geometryTransform, skinWeightsByVertex);
        const mesh = new BABYLON.Mesh(meshName, scene);
        vd.applyToMesh(mesh);
        if (skinInfo?.skeleton) {
            mesh.skeleton = skinInfo.skeleton;
            console.log(`[FBX] ${meshName} skin bones=${skinInfo.skeleton.bones.length}`);
        }

        if (modelNode) {
            const { T, R, S, preR, rotOrder, geoT, geoR, geoS } = applyFbxTransform(mesh, modelNode);
            console.log(`[FBX] ${meshName} T=${JSON.stringify(T)} R=${JSON.stringify(R)} preR=${JSON.stringify(preR)} rotOrder=${rotOrder} S=${JSON.stringify(S)} geoT=${JSON.stringify(geoT)} geoR=${JSON.stringify(geoR)} geoS=${JSON.stringify(geoS)}`);
        }

        // Material
        const allMatIds = modelId !== undefined ? (modelToMats.get(modelId) ?? []) : [];
        const hasVertexColors = !!(vd.colors?.length);

        function createBabylonMaterial(matId, matName) {
            const mat = new BABYLON.StandardMaterial(matName, scene);
            mat.backFaceCulling = true;
            const texId    = matId !== undefined ? matToTex.get(matId)           : undefined;
            const texInfo  = texId !== undefined ? texById.get(texId)            : undefined;
            const matNode  = matId !== undefined ? matById.get(matId)            : undefined;
            const matProps = matNode ? parseProps70(findNode(matNode.children, 'Properties70')) : null;
            const diffuseColor  = matProps?.get('Diffuse')  ?? matProps?.get('DiffuseColor');
            const specularColor = matProps?.get('Specular') ?? matProps?.get('SpecularColor');
            if (Array.isArray(diffuseColor)  && diffuseColor.length  >= 3)
                mat.diffuseColor  = new BABYLON.Color3(diffuseColor[0],  diffuseColor[1],  diffuseColor[2]);
            if (Array.isArray(specularColor) && specularColor.length >= 3)
                mat.specularColor = new BABYLON.Color3(specularColor[0], specularColor[1], specularColor[2]);
            const videoContent = texId !== undefined ? videoById.get(texToVideo.get(texId)) : undefined;
            if (videoContent) {
                const mimeType = detectImageMimeType(videoContent);
                const blobUrl = URL.createObjectURL(new Blob([videoContent], { type: mimeType }));
                console.log(`[FBX] Embedded texture: ${mimeType} (${videoContent.byteLength} bytes)`);
                mat.diffuseTexture = new BABYLON.Texture(blobUrl, scene);
            } else if (texInfo?.relativeFilename) {
                const texUrl = baseDir + texInfo.relativeFilename;
                console.log(`[FBX] Texture: ${texUrl}`);
                mat.diffuseTexture = new BABYLON.Texture(texUrl, scene);
            } else if (hasVertexColors && !Array.isArray(diffuseColor)) {
                mat.vertexColorsEnabled = true;
                mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
            }
            return mat;
        }

        const triMatIndices  = getTriangleMaterialIndices(geoNode);
        const uniqueMatIdxs  = triMatIndices ? [...new Set(triMatIndices)].sort((a, b) => a - b) : null;

        if (uniqueMatIdxs && uniqueMatIdxs.length > 1 && allMatIds.length > 1) {
            const matIdxToSubIdx = new Map(uniqueMatIdxs.map((mi, si) => [mi, si]));
            const multiMat = new BABYLON.MultiMaterial(`${meshName}_multimat`, scene);
            for (const matIdx of uniqueMatIdxs) {
                multiMat.subMaterials.push(
                    createBabylonMaterial(allMatIds[matIdx], `${meshName}_mat${matIdx}`)
                );
            }
            mesh.material = multiMat;
            mesh.subMeshes = [];
            const totalVerts = vd.positions.length / 3;
            let i = 0;
            while (i < triMatIndices.length) {
                const matIdx = triMatIndices[i];
                let j = i + 1;
                while (j < triMatIndices.length && triMatIndices[j] === matIdx) j++;
                new BABYLON.SubMesh(matIdxToSubIdx.get(matIdx), 0, totalVerts, i * 3, (j - i) * 3, mesh);
                i = j;
            }
        } else {
            const dominantIdx = getDominantMaterialIndex(geoNode);
            const matId = allMatIds[dominantIdx] ?? allMatIds[0];
            mesh.material = createBabylonMaterial(matId, `${meshName}_mat`);
        }

        if (modelId !== undefined) bjsNodeById.set(modelId, mesh);
        createdMeshes.push(mesh);
        allCreatedNodes.push(mesh);
    }

    // Pass 2: create TransformNodes for non-Mesh ancestors of Mesh nodes
    const seenIds = new Set(bjsNodeById.keys());
    for (const meshModelId of [...bjsNodeById.keys()]) {
        let parentId = nodeToParent.get(meshModelId);
        while (parentId && parentId !== 0 && !seenIds.has(parentId)) {
            seenIds.add(parentId);
            createTransformNodeForModel(parentId);
            parentId = nodeToParent.get(parentId);
        }
    }

    // Pass 2.5: create TransformNodes for skeleton bones so the scene hierarchy
    // resembles Babylon.js glTF imports, which expose armature nodes separately.
    createSkeletonTransformNodes([...skinInfoBySkinId.values()]);

    // Pass 3: wire parent-child relationships
    for (const [nodeId, bjsNode] of bjsNodeById) {
        const parentId = nodeToParent.get(nodeId);
        if (parentId && parentId !== 0) {
            const parentBjsNode = bjsNodeById.get(parentId);
            if (parentBjsNode) bjsNode.parent = parentBjsNode;
        }
    }

    // Pass 4: wrap all FBX-root-level nodes in a single modelRoot.
    // This ensures scaleInPlace() in the caller scales positions uniformly
    // (Bip001.position=[0, 0.937, 0] must be multiplied by scale, not left as-is).
    const modelRoot = new BABYLON.TransformNode('__root__', scene);
    for (const bjsNode of [...bjsNodeById.values(), ...syntheticRootNodes]) {
        if (!bjsNode.parent) bjsNode.parent = modelRoot;
    }
    allCreatedNodes.push(modelRoot);

    const loadedSkinInfos = uniqueSkinInfos([...skinInfoBySkinId.values()]);
    const allAnimationControls = [];
    const animationClips = []; // [{ name, controls }]

    const layerIds = getAllAnimationLayerIds();
    for (let clipIdx = 0; clipIdx < layerIds.length; clipIdx++) {
        const layerId = layerIds[clipIdx];
        const stackId = animLayerToStack.get(layerId);
        const clipName = animStackById.get(stackId)?.props[1]?.split('\0')[0] ?? `clip_${clipIdx}`;
        const isFirstClip = clipIdx === 0;
        const clipControls = [];
        for (const skinInfo of loadedSkinInfos) {
            const runtime = createSkeletonAnimationRuntime(skinInfo, layerId);
            if (!runtime) continue;
            const control = createSkeletonAnimationControl(skinInfo, runtime, isFirstClip);
            clipControls.push(control);
            allAnimationControls.push(control);
            console.log(`[FBX] Animation "${runtime.name}" duration=${runtime.duration.toFixed(3)}s bones=${runtime.channelsByBoneModelId.size}`);
        }
        if (clipControls.length) animationClips.push({ name: clipName, controls: clipControls });
    }
    modelRoot.metadata = {
        ...(modelRoot.metadata ?? {}),
        fbxAnimationControls: allAnimationControls,
        fbxAnimationClips: animationClips,
        fbxSkeletons: loadedSkinInfos.map(skinInfo => skinInfo.skeleton),
    };
    if ((allAnimationControls.length || loadedSkinInfos.length) && modelRoot.onDisposeObservable) {
        modelRoot.onDisposeObservable.add(() => {
            for (const control of allAnimationControls) control.dispose();
            for (const skinInfo of loadedSkinInfos) skinInfo.skeleton.dispose();
        });
    }

    console.log(`[FBX] Done — created ${allCreatedNodes.length} node(s) (${createdMeshes.length} mesh(es))`);

    // Debug: log world transforms of entire hierarchy (positions are pre-scale, in FBX units)
    (function debugWorldTransforms() {
        const f4 = v => v.toFixed(4);
        const deg = v => BABYLON.Tools.ToDegrees(v).toFixed(2);
        function traverse(node, depth) {
            node.computeWorldMatrix(true);
            const wm = node.getWorldMatrix();
            const wPos = new BABYLON.Vector3(), wRot = new BABYLON.Quaternion(), wSc = new BABYLON.Vector3();
            wm.decompose(wSc, wRot, wPos);
            const e = wRot.toEulerAngles();
            const lp = node.position;
            const lq = node.rotationQuaternion;
            const le = lq ? lq.toEulerAngles() : null;
            const pad = '  '.repeat(depth);
            console.log(
                `${pad}[${node.name}]` +
                ` lPos=[${f4(lp.x)},${f4(lp.y)},${f4(lp.z)}]` +
                (le ? ` lEul=[${deg(le.x)},${deg(le.y)},${deg(le.z)}]°` : '') +
                ` | wPos=[${f4(wPos.x)},${f4(wPos.y)},${f4(wPos.z)}]` +
                ` wEul=[${deg(e.x)},${deg(e.y)},${deg(e.z)}]°`
            );
            for (const child of node.getChildren()) traverse(child, depth + 1);
        }
        console.log('[FBX] === World transforms (pre-caller-scale) ===');
        traverse(modelRoot, 0);
        console.log('[FBX] ==========================================');
    })();

    return allCreatedNodes;
}

// Expose globally (for use in index.js and Babylon.js Playground)
window.FBXLoader = { loadFBX };
