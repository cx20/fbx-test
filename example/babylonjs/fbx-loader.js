// fbx-loader.js
// Binary FBX parser + Babylon.js mesh builder
// Supports: static mesh and basic skinning, no animation playback (Phase 1)

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
            const Ctor = { f: Float32Array, d: Float64Array, i: Int32Array,
                           l: Float64Array, b: Uint8Array,   c: Uint8Array }[type];
            return Array.from(new Ctor(raw));
        }
        default: throw new Error(`Unknown FBX property type: ${type}`);
    }
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
// Parse binary FBX buffer → node tree
// ============================================================
async function parseFBX(buffer) {
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
    let uvVals = null, uvIdx = null;
    if (uvNode) {
        uvVals = prop0(findNode(uvNode.children, 'UV'));
        uvIdx  = prop0(findNode(uvNode.children, 'UVIndex'));
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
                    const ui = uvIdx ? uvIdx[pvI] : pvI;
                    uvs.push(uvVals[ui * 2], uvVals[ui * 2 + 1]);
                }

                // Vertex Color (RGBA)
                if (colVals) {
                    let ci;
                    if (colMapping === 'ByPolygonVertex') {
                        ci = colRef === 'IndexToDirect' ? colIdx[pvI] : pvI;
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

function makeBabylonLocalMatrix(modelNode) {
    const { T, R, S, preR, rotOrder } = getModelTransform(modelNode);
    const position = new BABYLON.Vector3(T[0], T[1], -T[2]);
    const rotation = fbxEulerToQuat(preR, 0).multiply(fbxEulerToQuat(R, rotOrder));
    const scaling = new BABYLON.Vector3(S[0], S[1], S[2]);
    return BABYLON.Matrix.Compose(scaling, rotation, position);
}

// ============================================================
// Main: load FBX URL and build Babylon.js meshes
// ============================================================
async function loadFBX(url, scene) {
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
    const texById   = new Map(); // id → { relativeFilename }
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
        if (obj.name === 'Texture') {
            const relFn = prop0(findNode(obj.children, 'RelativeFilename'));
            if (relFn) texById.set(id, { relativeFilename: relFn.replace(/\\/g, '/') });
        }
    }

    // Build connection maps
    const geoToModel   = new Map(); // geoId  → modelId
    const modelToMat   = new Map(); // modelId → matId  (first match)
    const matToTex     = new Map(); // matId   → texId  (first match)
    const nodeToParent = new Map(); // nodeId  → parentId (OO; 0 = scene root)
    const geoToSkin    = new Map(); // geoId   → skinId
    const skinToClusters = new Map(); // skinId → clusterId[]
    const clusterToBoneModel = new Map(); // clusterId → modelId
    for (const c of connList) {
        if (geoById.has(c.from) && modelById.has(c.to)) geoToModel.set(c.from, c.to);
        if (matById.has(c.from) && modelById.has(c.to) && !modelToMat.has(c.to)) modelToMat.set(c.to, c.from);
        if (texById.has(c.from) && matById.has(c.to)   && !matToTex.has(c.to))   matToTex.set(c.to, c.from);
        if (skinById.has(c.from) && geoById.has(c.to)) geoToSkin.set(c.to, c.from);
        if (clusterById.has(c.from) && skinById.has(c.to)) {
            if (!skinToClusters.has(c.to)) skinToClusters.set(c.to, []);
            skinToClusters.get(c.to).push(c.from);
        }
        if (allModelById.has(c.from) && clusterById.has(c.to)) clusterToBoneModel.set(c.to, c.from);
        if (c.type === 'OO' && allModelById.has(c.from) && !nodeToParent.has(c.from)) {
            nodeToParent.set(c.from, c.to);
        }
    }

    console.log(`[FBX] Geometries: ${geoById.size}, Models: ${modelById.size}, Materials: ${matById.size}, Textures: ${texById.size}, Skins: ${skinById.size}`);

    function applyFbxTransform(bjsNode, fbxModelNode) {
        const { T, R, S, preR, rotOrder, geoT, geoR, geoS } = getModelTransform(fbxModelNode);
        bjsNode.position.set(T[0], T[1], -T[2]);
        // FBX total rotation = M_preR × M_LclR; in BJS q1.multiply(q2)=M_q1×M_q2, so preR goes first.
        // PreRotation is always XYZ (order 0) per FBX spec; LclRotation uses the node's rotOrder.
        bjsNode.rotationQuaternion = fbxEulerToQuat(preR, 0).multiply(fbxEulerToQuat(R, rotOrder));
        bjsNode.scaling.set(S[0], S[1], S[2]);
        return { T, R, S, preR, rotOrder, geoT, geoR, geoS };
    }

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

        const skeleton = new BABYLON.Skeleton(`${nameHint}_skeleton`, `${nameHint}_skeleton`, scene);
        const boneByModelId = new Map();
        const boneIndexByModelId = new Map();
        for (const boneModelId of orderedBoneIds) {
            const boneModelNode = allModelById.get(boneModelId);
            const rawName = boneModelNode.props[1] ?? '';
            const boneName = rawName.split('\0')[0].replace(/Model$/, '') || `bone_${boneModelId}`;
            const parentBone = boneByModelId.get(nodeToParent.get(boneModelId)) ?? null;
            const bone = new BABYLON.Bone(boneName, skeleton, parentBone, makeBabylonLocalMatrix(boneModelNode));
            boneByModelId.set(boneModelId, bone);
            boneIndexByModelId.set(boneModelId, skeleton.bones.length - 1);
        }

        return { skeleton, boneIndexByModelId, clusterByBoneModelId };
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

    const bjsNodeById     = new Map();
    const allCreatedNodes = [];
    const createdMeshes   = [];
    const skinInfoBySkinId = new Map();
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
        const mat = new BABYLON.StandardMaterial(`${meshName}_mat`, scene);
        mat.backFaceCulling = true;

        const matId   = modelId !== undefined ? modelToMat.get(modelId) : undefined;
        const texId   = matId   !== undefined ? matToTex.get(matId)     : undefined;
        const texInfo = texId   !== undefined ? texById.get(texId)       : undefined;
        const matNode = matId   !== undefined ? matById.get(matId)       : undefined;
        const matProps = matNode ? parseProps70(findNode(matNode.children, 'Properties70')) : null;
        const diffuseColor = matProps?.get('Diffuse') ?? matProps?.get('DiffuseColor');
        const specularColor = matProps?.get('Specular') ?? matProps?.get('SpecularColor');
        if (Array.isArray(diffuseColor) && diffuseColor.length >= 3) {
            mat.diffuseColor = new BABYLON.Color3(diffuseColor[0], diffuseColor[1], diffuseColor[2]);
        }
        if (Array.isArray(specularColor) && specularColor.length >= 3) {
            mat.specularColor = new BABYLON.Color3(specularColor[0], specularColor[1], specularColor[2]);
        }

        if (texInfo) {
            const texUrl = baseDir + texInfo.relativeFilename;
            console.log(`[FBX] Texture: ${texUrl}`);
            mat.diffuseTexture = new BABYLON.Texture(texUrl, scene);
        } else if (vd.colors) {
            mat.vertexColorsEnabled = true;
            mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        }
        mesh.material = mat;

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
            const parentFbxNode = allModelById.get(parentId);
            if (parentFbxNode) {
                const rawName  = parentFbxNode.props[1] ?? '';
                const nodeName = rawName.split('\0')[0].replace(/Model$/, '') || `node_${parentId}`;
                const tn = new BABYLON.TransformNode(nodeName, scene);
                const { T, R, preR, rotOrder } = applyFbxTransform(tn, parentFbxNode);
                console.log(`[FBX] TransformNode: ${nodeName} T=${JSON.stringify(T)} R=${JSON.stringify(R)} preR=${JSON.stringify(preR)} rotOrder=${rotOrder}`);
                bjsNodeById.set(parentId, tn);
                allCreatedNodes.push(tn);
            }
            parentId = nodeToParent.get(parentId);
        }
    }

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
    const modelRoot = new BABYLON.TransformNode('__model_root__', scene);
    for (const bjsNode of bjsNodeById.values()) {
        if (!bjsNode.parent) bjsNode.parent = modelRoot;
    }
    allCreatedNodes.push(modelRoot);

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
