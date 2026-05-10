// fbx-loader.js
// Binary FBX parser + Babylon.js mesh builder
// Supports: static mesh, no skeleton, no animation (Phase 1)

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
function buildVertexData(geoNode) {
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

                // Position (negate Z: RH→LH)
                positions.push(verts[posI * 3], verts[posI * 3 + 1], -verts[posI * 3 + 2]);

                // Normal (negate Z)
                if (normVals) {
                    let ni;
                    if (normMapping === 'ByPolygonVertex') {
                        ni = normRef === 'IndexToDirect' ? normIdx[pvI] : pvI;
                    } else {
                        ni = normRef === 'IndexToDirect' ? normIdx[polyGlobal] : polyGlobal;
                    }
                    normals.push(normVals[ni * 3], normVals[ni * 3 + 1], -normVals[ni * 3 + 2]);
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
    return vd;
}

// ============================================================
// Build transform from Model node
// ============================================================
function getModelTransform(modelNode) {
    const p70 = parseProps70(findNode(modelNode.children, 'Properties70'));
    const T    = p70.get('Lcl Translation') ?? [0, 0, 0];
    const R    = p70.get('Lcl Rotation')    ?? [0, 0, 0];
    const S    = p70.get('Lcl Scaling')     ?? [1, 1, 1];
    const preR = p70.get('PreRotation')     ?? [0, 0, 0];
    return { T, R, S, preR };
}

// Convert FBX Euler XYZ (degrees) → Babylon.js quaternion under Z-negate conversion.
// Derivation: R_bjs = M_Z·R_fbx·M_Z  (where M_Z negates the Z axis)
//   gives  Rx(-rx)·Ry(-ry)·Rz(+rz)  in explicit XYZ order.
function fbxEulerToQuat(deg) {
    const rx = BABYLON.Tools.ToRadians(deg[0]);
    const ry = BABYLON.Tools.ToRadians(deg[1]);
    const rz = BABYLON.Tools.ToRadians(deg[2]);
    return BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, -rx)
        .multiply(BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, -ry))
        .multiply(BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z,  rz));
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
    const geoById   = new Map();
    const modelById = new Map();
    const matById   = new Map();
    const texById   = new Map(); // id → { relativeFilename }
    for (const obj of objectsNode.children) {
        const id = obj.props[0];
        if (obj.name === 'Geometry' && obj.props[2] === 'Mesh') geoById.set(id, obj);
        if (obj.name === 'Model'    && obj.props[2] === 'Mesh') modelById.set(id, obj);
        if (obj.name === 'Material') matById.set(id, obj);
        if (obj.name === 'Texture') {
            const relFn = prop0(findNode(obj.children, 'RelativeFilename'));
            if (relFn) texById.set(id, { relativeFilename: relFn.replace(/\\/g, '/') });
        }
    }

    // Build connection maps
    const geoToModel  = new Map(); // geoId  → modelId
    const modelToMat  = new Map(); // modelId → matId  (first match)
    const matToTex    = new Map(); // matId   → texId  (first match)
    for (const c of connList) {
        if (geoById.has(c.from) && modelById.has(c.to)) geoToModel.set(c.from, c.to);
        if (matById.has(c.from) && modelById.has(c.to) && !modelToMat.has(c.to))  modelToMat.set(c.to, c.from);
        if (texById.has(c.from) && matById.has(c.to)   && !matToTex.has(c.to))    matToTex.set(c.to, c.from);
    }

    console.log(`[FBX] Geometries: ${geoById.size}, Models: ${modelById.size}, Materials: ${matById.size}, Textures: ${texById.size}`);

    const createdMeshes = [];
    for (const [geoId, geoNode] of geoById) {
        const modelId   = geoToModel.get(geoId);
        const modelNode = modelId !== undefined ? modelById.get(modelId) : null;

        // Mesh name from Model node
        const rawName = modelNode ? (modelNode.props[1] ?? '') : '';
        const meshName = rawName.split('\0')[0].replace(/Model$/, '') || `mesh_${geoId}`;

        console.log(`[FBX] Building mesh: ${meshName}`);
        const vd   = buildVertexData(geoNode);
        const mesh = new BABYLON.Mesh(meshName, scene);
        vd.applyToMesh(mesh);

        // Transform
        if (modelNode) {
            const { T, R, S, preR } = getModelTransform(modelNode);
            console.log(`[FBX] ${meshName} T=${JSON.stringify(T)} R=${JSON.stringify(R)} preR=${JSON.stringify(preR)} S=${JSON.stringify(S)}`);
            mesh.position.set(T[0], T[1], -T[2]);
            // FBX order: PreRotation then LclRotation.
            // lclQ.multiply(preQ) = Q_lcl * Q_pre → applies preR first, then R.
            const preQ = fbxEulerToQuat(preR);
            const lclQ = fbxEulerToQuat(R);
            mesh.rotationQuaternion = lclQ.multiply(preQ);
            mesh.scaling.set(S[0], S[1], S[2]);
        }

        // Material
        const mat = new BABYLON.StandardMaterial(`${meshName}_mat`, scene);
        mat.backFaceCulling = true;

        const matId   = modelId !== undefined ? modelToMat.get(modelId) : undefined;
        const texId   = matId   !== undefined ? matToTex.get(matId)     : undefined;
        const texInfo = texId   !== undefined ? texById.get(texId)       : undefined;

        if (texInfo) {
            const texUrl = baseDir + texInfo.relativeFilename;
            console.log(`[FBX] Texture: ${texUrl}`);
            mat.diffuseTexture = new BABYLON.Texture(texUrl, scene);
        } else if (vd.colors) {
            mat.vertexColorsEnabled = true;
            mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        }
        mesh.material = mat;

        createdMeshes.push(mesh);
    }

    console.log(`[FBX] Done — created ${createdMeshes.length} mesh(es)`);
    return createdMeshes;
}

// Expose globally (for use in index.js and Babylon.js Playground)
window.FBXLoader = { loadFBX };
