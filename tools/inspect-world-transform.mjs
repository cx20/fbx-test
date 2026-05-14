// Compute mesh world matrix from parent chain and compare to cluster Transform
import { readFileSync } from 'fs';
import { inflate } from 'zlib';
import { promisify } from 'util';
const inflateAsync = promisify(inflate);

function makeReader(buf) {
    let o = 0;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
        get pos() { return o; },
        u8()  { return buf[o++]; },
        i32() { const v=dv.getInt32(o,true); o+=4; return v; },
        u32() { const v=dv.getUint32(o,true); o+=4; return v; },
        f64() { const v=dv.getFloat64(o,true);o+=8; return v; },
        i64() { const lo=this.u32(); const hi=dv.getInt32(o,true); o+=4; return hi*4294967296+lo; },
        str(n){ const s=buf.slice(o,o+n).toString('utf8'); o+=n; return s; },
        buf(n){ const b=buf.slice(o,o+n); o+=n; return b; },
        skip(n){ o+=n; },
        to(p){ o=p; },
    };
}
async function parseProp(r) {
    const t = r.str(1);
    if (t==='C') return r.u8()!==0;
    if (t==='Y') return r.i32();
    if (t==='I') return r.i32();
    if (t==='F') { const b=r.buf(4); return new DataView(b.buffer,b.byteOffset).getFloat32(0,true); }
    if (t==='D') return r.f64();
    if (t==='L') return r.i64();
    if (t==='S') { const n=r.u32(); return r.str(n); }
    if (t==='R') { const n=r.u32(); return r.buf(n); }
    if ('fdilbc'.includes(t)) {
        const count=r.u32(), enc=r.u32(), clen=r.u32();
        let raw=r.buf(clen);
        if(enc===1) raw=await inflateAsync(raw);
        if(t==='l'){const ab=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);const dv2=new DataView(ab);const out=[];for(let i=0;i<count;i++){const lo=dv2.getUint32(i*8,true),hi=dv2.getInt32(i*8+4,true);out.push(hi*4294967296+lo);}return out;}
        const Ctor={f:Float32Array,d:Float64Array,i:Int32Array,b:Uint8Array,c:Uint8Array}[t];
        const ab=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
        return Array.from(new Ctor(ab));
    }
    throw new Error(`unknown type ${t}`);
}
async function parseNodes(r, end, is64) {
    const nullSz=is64?25:13;
    const nodes=[];
    while(r.pos < end) {
        const ne=is64?r.i64():r.u32();
        const np=is64?r.i64():r.u32();
        is64?r.i64():r.u32();
        const nl=r.u8();
        const name=r.str(nl);
        if(ne===0) break;
        const props=[];
        for(let i=0;i<np;i++) props.push(await parseProp(r));
        const children=[];
        if(r.pos < ne-nullSz) children.push(...await parseNodes(r, ne-nullSz, is64));
        r.to(ne);
        nodes.push({name,props,children});
    }
    return nodes;
}
function findNode(children, name) { return children.find(n=>n.name===name)??null; }
function parseProps70(node) {
    const map=new Map();
    if(!node) return map;
    for(const p of node.children) {
        if(p.name!=='P'||p.props.length<5) continue;
        map.set(p.props[0], p.props.length===5 ? p.props[4] : p.props.slice(4));
    }
    return map;
}

// Matrix helpers (column-major, like FBX)
function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mget(m,r,c){return m[c*4+r];}
function mfmt(m) {
    return Array.from({length:4},(_,row)=>
        Array.from({length:4},(_,col)=>mget(m,row,col).toFixed(4).padStart(9)).join(' ')
    ).join('\n  ');
}
function m4mul(A,B){
    const C=new Array(16).fill(0);
    for(let r=0;r<4;r++)for(let c=0;c<4;c++)for(let k=0;k<4;k++) C[c*4+r]+=mget(A,r,k)*mget(B,k,c);
    return C;
}

// Build TRS matrix from FBX euler angles (degrees), column-major
// Default rotation order XYZ
function eulerToMatrix(tx,ty,tz, rx,ry,rz) {
    const toRad = d => d * Math.PI / 180;
    // Rx
    const cx=Math.cos(toRad(rx)), sx=Math.sin(toRad(rx));
    const cy=Math.cos(toRad(ry)), sy=Math.sin(toRad(ry));
    const cz=Math.cos(toRad(rz)), sz=Math.sin(toRad(rz));
    // R = Rx * Ry * Rz (FBX XYZ order: Rz applied first to vector, then Ry, then Rx)
    // Actually FBX XYZ order means: total_R = Rx * Ry * Rz (applied left-to-right to column vector)
    // R = Rz * Ry * Rx (if vectors are columns): v' = Rx * Ry * Rz * v
    // For FBX RotationOrder=0 (XYZ): apply X first, then Y, then Z
    // → R = Rz_mat * Ry_mat * Rx_mat
    const Rx_m = [1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1]; // col-major
    const Ry_m = [cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1];
    const Rz_m = [cz,sz,0,0, -sz,cz,0,0, 0,0,1,0, 0,0,0,1];
    const R = m4mul(m4mul(Rz_m, Ry_m), Rx_m);
    // Apply translation
    R[12]=tx; R[13]=ty; R[14]=tz;
    return R;
}

const raw = readFileSync('assets/models/fbx/warrior/Warrior.fbx');
const r = makeReader(raw); r.skip(23); const version=r.u32(); const is64=version>=7500;
const nodes = await parseNodes(r, raw.byteLength, is64);
const objs = nodes.find(n=>n.name==='Objects');
const conns = nodes.find(n=>n.name==='Connections');
const connList = conns.children.filter(c=>c.name==='C').map(c=>({type:c.props[0],from:c.props[1],to:c.props[2]}));
const modelById = new Map();
const clusterById = new Map();
const skinById = new Map();
for(const o of objs.children) {
    if(o.name==='Model') modelById.set(o.props[0], o);
    if(o.name==='Deformer'&&o.props[2]==='Cluster') clusterById.set(o.props[0], o);
    if(o.name==='Deformer'&&o.props[2]==='Skin') skinById.set(o.props[0], o);
}
const nodeToParent = new Map();
const geoToModel = new Map();
const modelToSkin = new Map();
const skinToClusters = new Map();
const clusterToBoneModel = new Map();
for(const c of connList) {
    if(c.type==='OO'&&modelById.has(c.from)&&!nodeToParent.has(c.from)) nodeToParent.set(c.from,c.to);
    if(c.type==='OO'&&c.from in {} || true) {
        if(modelById.has(c.from)&&!nodeToParent.has(c.from)); // already done above
    }
    if(c.type==='OO'&&modelById.has(c.from)&&clusterById.has(c.to)) clusterToBoneModel.set(c.to,c.from);
    if(clusterById.has(c.from)&&skinById.has(c.to)){
        if(!skinToClusters.has(c.to)) skinToClusters.set(c.to,[]);
        skinToClusters.get(c.to).push(c.from);
    }
}

// Get local matrix for a model node
function getLocalMatrix(modelId) {
    const m = modelById.get(modelId);
    if(!m) return identity();
    const p70 = parseProps70(findNode(m.children,'Properties70'));
    const T = p70.get('Lcl Translation')??[0,0,0];
    const R = p70.get('Lcl Rotation')??[0,0,0];
    const S = p70.get('Lcl Scaling')??[1,1,1];
    const preR = p70.get('PreRotation')??[0,0,0];
    // TODO: handle rotOrder properly for now assume XYZ
    const matR = eulerToMatrix(0,0,0, R[0],R[1],R[2]);
    const matPreR = eulerToMatrix(0,0,0, preR[0],preR[1],preR[2]);
    const matT = identity(); matT[12]=T[0]; matT[13]=T[1]; matT[14]=T[2];
    const matS = identity(); matS[0]=S[0]; matS[5]=S[1]; matS[10]=S[2];
    // Full local = T * Roff * Rp * PreR * R * Rpost_inv * Rp_inv * Soff * Sp * S * Sp_inv
    // For typical case: local = T * preR * R * S (ignoring pivot stuff)
    return m4mul(matT, m4mul(m4mul(matPreR, matR), matS));
}

// Compute world matrix by climbing parent chain
function getWorldMatrix(modelId) {
    const chain = [];
    let id = modelId;
    while(id && modelById.has(id)) {
        chain.push(id);
        id = nodeToParent.get(id);
    }
    // chain is [leaf, ..., root]
    let world = identity();
    for(let i=chain.length-1; i>=0; i--) {
        world = m4mul(world, getLocalMatrix(chain[i]));
    }
    return world;
}

// Find the mesh model
let meshModelId = null;
for(const [id,m] of modelById) {
    if((m.props[1]??'').split('\0')[0].replace(/Model$/,'') === '100800_kl_npc_mo_0') {
        meshModelId = id;
        break;
    }
}

console.log(`\n=== Mesh model: 100800_kl_npc_mo_0 (id=${meshModelId}) ===`);
const meshWorld = getWorldMatrix(meshModelId);
console.log(`Computed world matrix:\n  ${mfmt(meshWorld)}`);

// Get cluster Transform for one bone
const prop0 = n => n?.props[0]??null;
for(const [skinId] of skinById) {
    for(const cid of (skinToClusters.get(skinId)??[])) {
        const clNode = clusterById.get(cid);
        const boneId = clusterToBoneModel.get(cid);
        const boneName = (modelById.get(boneId)?.props[1]??'').split('\0')[0].replace(/Model$/,'');
        if(boneName !== 'Bip001 Pelvis') continue;
        const T = prop0(findNode(clNode.children,'Transform'));
        const TL = prop0(findNode(clNode.children,'TransformLink'));
        console.log(`\n=== Cluster Transform for ${boneName} ===`);
        console.log(`Transform (cluster):\n  ${mfmt(T)}`);
        console.log(`\nTransformLink:\n  ${mfmt(TL)}`);

        console.log(`\n--- Translation comparison ---`);
        console.log(`Computed world T: [${meshWorld[12].toFixed(4)}, ${meshWorld[13].toFixed(4)}, ${meshWorld[14].toFixed(4)}]`);
        console.log(`Cluster Transform T: [${T[12].toFixed(4)}, ${T[13].toFixed(4)}, ${T[14].toFixed(4)}]`);
    }
}

// Show parent chain world matrices
console.log('\n=== Parent chain matrices ===');
const chain = [];
let id = meshModelId;
while(id && modelById.has(id)) {
    const name = (modelById.get(id).props[1]??'').split('\0')[0].replace(/Model$/,'');
    const local = getLocalMatrix(id);
    chain.push({id, name, local});
    id = nodeToParent.get(id);
}
for(const {name, local} of chain.reverse()) {
    console.log(`"${name}" local:\n  ${mfmt(local)}`);
}
