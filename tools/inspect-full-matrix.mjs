// Print full Transform and TransformLink for Bip001 Pelvis cluster
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

// Matrix helpers (column-major FBX)
function mget(m,row,col){return m[col*4+row];}
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
function m4inv(m){
    // 4x4 inverse by cofactors
    const d=new Array(16).fill(0);
    // use flat row major for computation
    const a=(r,c)=>mget(m,r,c);
    const minor=(r0,c0)=>{
        const rows=[0,1,2,3].filter(r=>r!==r0),cols=[0,1,2,3].filter(c=>c!==c0);
        const [r1,r2,r3]=rows,[c1,c2,c3]=cols;
        return a(r1,c1)*(a(r2,c2)*a(r3,c3)-a(r2,c3)*a(r3,c2))
              -a(r1,c2)*(a(r2,c1)*a(r3,c3)-a(r2,c3)*a(r3,c1))
              +a(r1,c3)*(a(r2,c1)*a(r3,c2)-a(r2,c2)*a(r3,c1));
    };
    let det=0;
    for(let c=0;c<4;c++) det+=(c%2===0?1:-1)*a(0,c)*minor(0,c);
    if(Math.abs(det)<1e-12) return null;
    const inv=new Array(16).fill(0);
    for(let r=0;r<4;r++)for(let c=0;c<4;c++){
        const sign=((r+c)%2===0?1:-1);
        // cofactor(r,c) / det, transposed
        inv[r*4+c]=sign*minor(c,r)/det;
    }
    // convert row-major result back to column-major
    const out=new Array(16);
    for(let r=0;r<4;r++)for(let c=0;c<4;c++) out[c*4+r]=inv[r*4+c];
    return out;
}

// Check key bones
const KEY_BONES = ['Bip001 Pelvis', 'Bip001 L Thigh', 'Bip001 Head'];
for(const [skinId] of skinById) {
    for(const cid of (skinToClusters.get(skinId)??[])) {
        const boneId = clusterToBoneModel.get(cid);
        const boneName = (modelById.get(boneId)?.props[1]??'').split('\0')[0].replace(/Model$/,'');
        if(!KEY_BONES.includes(boneName)) continue;
        const clNode = clusterById.get(cid);
        const T = prop0(findNode(clNode.children,'Transform'));
        const TL = prop0(findNode(clNode.children,'TransformLink'));
        if(!T||!TL) continue;

        console.log(`\n=== ${boneName} ===`);
        console.log(`Transform (col-major):\n  ${mfmt(T)}`);
        console.log(`TransformLink (col-major):\n  ${mfmt(TL)}`);

        // Compute inv(TL)*T
        const invTL = m4inv(TL);
        if(invTL) {
            const invTL_T = m4mul(invTL, T);
            console.log(`inv(TL)*T:\n  ${mfmt(invTL_T)}`);
        }

        // Compute inv(T)*TL
        const invT = m4inv(T);
        if(invT) {
            const invT_TL = m4mul(invT, TL);
            console.log(`inv(T)*TL:\n  ${mfmt(invT_TL)}`);
        }

        // Check if inv(TL)*T is a simple rotation
        const invTL_T = m4mul(m4inv(TL), T);
        const pos = [mget(invTL_T,0,3), mget(invTL_T,1,3), mget(invTL_T,2,3)];
        console.log(`inv(TL)*T translation: (${pos.map(v=>v.toFixed(4)).join(', ')})`);
    }
}
