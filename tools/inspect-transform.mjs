// Check cluster Transform vs TransformLink for warrior/Warrior.fbx
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
        i16() { const v=dv.getInt16(o,true);  o+=2; return v; },
        i32() { const v=dv.getInt32(o,true);  o+=4; return v; },
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
    if (t==='Y') return r.i16();
    if (t==='I') return r.i32();
    if (t==='F') { const buf=r.buf(4); return new DataView(buf.buffer,buf.byteOffset).getFloat32(0,true); }
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

// Build maps
const clusterToBoneModel = new Map();
const skinToClusters = new Map();
for(const c of connList) {
    if(c.type==='OO'&&modelById.has(c.from)&&clusterById.has(c.to)) clusterToBoneModel.set(c.to,c.from);
    if(clusterById.has(c.from)&&skinById.has(c.to)){
        if(!skinToClusters.has(c.to)) skinToClusters.set(c.to,[]);
        skinToClusters.get(c.to).push(c.from);
    }
}

function findNode(nodes, name) { return nodes.find(n=>n.name===name)??null; }
function prop0(n) { return n?.props[0]??null; }

function matFmt(m16, label) {
    // m16 is column-major FBX → show as 4x4
    const rows = [];
    for(let r=0;r<4;r++) {
        const row = [0,1,2,3].map(c=>m16[c*4+r].toFixed(4).padStart(9));
        rows.push(row.join(' '));
    }
    return `    ${label}:\n      ${rows.join('\n      ')}`;
}

function isIdentity(m16) {
    const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    return m16.every((v,i) => Math.abs(v - identity[i]) < 1e-4);
}

console.log('=== Cluster Transform vs TransformLink for warrior/Warrior.fbx ===');
console.log('(First few clusters shown)\n');

let count = 0;
for(const [skinId] of skinById) {
    for(const cid of (skinToClusters.get(skinId)??[])) {
        const clNode = clusterById.get(cid);
        const boneId = clusterToBoneModel.get(cid);
        const boneName = (modelById.get(boneId)?.props[1]??'').split('\0')[0].replace(/Model$/,'');
        const transform = prop0(findNode(clNode.children,'Transform'));
        const transformLink = prop0(findNode(clNode.children,'TransformLink'));
        const tIsId = Array.isArray(transform) ? isIdentity(transform) : 'N/A';
        const tlIsId = Array.isArray(transformLink) ? isIdentity(transformLink) : 'N/A';
        if(count < 5 || !tIsId) {
            console.log(`Cluster for "${boneName}":`);
            if(Array.isArray(transform)) {
                console.log(`  Transform ${tIsId?'[IDENTITY]':'[NON-IDENTITY]'}: pos=(${transform[12].toFixed(4)},${transform[13].toFixed(4)},${transform[14].toFixed(4)})`);
            }
            if(Array.isArray(transformLink)) {
                console.log(`  TransformLink ${tlIsId?'[IDENTITY]':'[NON-IDENTITY]'}: pos=(${transformLink[12].toFixed(4)},${transformLink[13].toFixed(4)},${transformLink[14].toFixed(4)})`);
            }
        }
        count++;
    }
}

// Summary
let nonIdCount = 0;
for(const [skinId] of skinById) {
    for(const cid of (skinToClusters.get(skinId)??[])) {
        const clNode = clusterById.get(cid);
        const transform = prop0(findNode(clNode.children,'Transform'));
        if(Array.isArray(transform) && !isIdentity(transform)) nonIdCount++;
    }
}
console.log(`\nTotal clusters: ${count}`);
console.log(`Clusters with non-identity Transform: ${nonIdCount}`);
