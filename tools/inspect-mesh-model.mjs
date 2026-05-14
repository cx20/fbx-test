// Inspect the mesh model node's transforms and understand coordinate system
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

const raw = readFileSync('assets/models/fbx/warrior/Warrior.fbx');
const r = makeReader(raw); r.skip(23); const version=r.u32(); const is64=version>=7500;
const nodes = await parseNodes(r, raw.byteLength, is64);
const objs = nodes.find(n=>n.name==='Objects');
const conns = nodes.find(n=>n.name==='Connections');
const globalSettings = nodes.find(n=>n.name==='GlobalSettings');
const connList = conns.children.filter(c=>c.name==='C').map(c=>({type:c.props[0],from:c.props[1],to:c.props[2]}));
const modelById = new Map();
const geoById = new Map();
const skinById = new Map();
const clusterById = new Map();
for(const o of objs.children) {
    if(o.name==='Model') modelById.set(o.props[0], o);
    if(o.name==='Geometry') geoById.set(o.props[0], o);
    if(o.name==='Deformer'&&o.props[2]==='Skin') skinById.set(o.props[0], o);
    if(o.name==='Deformer'&&o.props[2]==='Cluster') clusterById.set(o.props[0], o);
}

// Build parent map and geo-to-model map
const nodeToParent = new Map();
const geoToModel = new Map();
const modelToSkin = new Map();
const skinToModel = new Map();
for(const c of connList) {
    if(c.type==='OO'&&modelById.has(c.from)&&!nodeToParent.has(c.from)) nodeToParent.set(c.from,c.to);
    if(c.type==='OO'&&geoById.has(c.from)) geoToModel.set(c.from, c.to);
    if(c.type==='OO'&&skinById.has(c.from)) {
        skinToModel.set(c.from, c.to); // skin → geo
        modelToSkin.set(c.to, c.from); // geo → skin
    }
}

// Show FBX GlobalSettings
console.log('=== GlobalSettings ===');
if(globalSettings) {
    const p70 = parseProps70(findNode(globalSettings.children,'Properties70'));
    console.log(`  UpAxis: ${p70.get('UpAxis')}, UpAxisSign: ${p70.get('UpAxisSign')}`);
    console.log(`  FrontAxis: ${p70.get('FrontAxis')}, FrontAxisSign: ${p70.get('FrontAxisSign')}`);
    console.log(`  CoordAxis: ${p70.get('CoordAxis')}, CoordAxisSign: ${p70.get('CoordAxisSign')}`);
    console.log(`  UnitScaleFactor: ${p70.get('UnitScaleFactor')}`);
    console.log(`  CustomFrameRate: ${p70.get('CustomFrameRate')}`);
}

// Find mesh models (those with geometry)
console.log('\n=== Mesh models (Models connected to Geometry) ===');
for(const [geoId, modelId] of geoToModel) {
    if(!modelById.has(modelId)) continue;
    const m = modelById.get(modelId);
    const name = (m.props[1]??'').split('\0')[0].replace(/Model$/,'');
    const type = m.props[2];
    if(type !== 'Mesh') continue;
    const p70 = parseProps70(findNode(m.children,'Properties70'));
    const T = p70.get('Lcl Translation')??[0,0,0];
    const R = p70.get('Lcl Rotation')??[0,0,0];
    const S = p70.get('Lcl Scaling')??[1,1,1];
    const preR = p70.get('PreRotation')??[0,0,0];
    const geoT = p70.get('GeometricTranslation')??[0,0,0];
    const geoR = p70.get('GeometricRotation')??[0,0,0];
    const geoS = p70.get('GeometricScaling')??[1,1,1];
    const isIdentityT = T.every(v=>Math.abs(v)<1e-4);
    const isIdentityR = R.every(v=>Math.abs(v)<1e-4);
    const isIdentityS = S.every(v=>Math.abs(v-1)<1e-4);
    const isIdentityPreR = preR.every(v=>Math.abs(v)<1e-4);
    const isIdentityGeoT = geoT.every(v=>Math.abs(v)<1e-4);
    const isIdentityGeoR = geoR.every(v=>Math.abs(v)<1e-4);
    const isIdentityGeoS = geoS.every(v=>Math.abs(v-1)<1e-4);
    console.log(`  Model: "${name}" type="${type}" id=${modelId}`);
    console.log(`    Lcl T=[${T.map(v=>v.toFixed(4)).join(',')}] ${isIdentityT?'[=0]':''}`);
    console.log(`    Lcl R=[${R.map(v=>v.toFixed(4)).join(',')}] ${isIdentityR?'[=0]':''}`);
    console.log(`    Lcl S=[${S.map(v=>v.toFixed(4)).join(',')}] ${isIdentityS?'[=1]':''}`);
    if(!isIdentityPreR) console.log(`    PreR=[${preR.map(v=>v.toFixed(4)).join(',')}]`);
    if(!isIdentityGeoT||!isIdentityGeoR||!isIdentityGeoS) {
        console.log(`    Geo T=[${geoT.map(v=>v.toFixed(4)).join(',')}]`);
        console.log(`    Geo R=[${geoR.map(v=>v.toFixed(4)).join(',')}]`);
        console.log(`    Geo S=[${geoS.map(v=>v.toFixed(4)).join(',')}]`);
    }
    // Show parent chain
    let parentId = nodeToParent.get(modelId);
    let parentNames = [];
    for(let i=0;i<4;i++) {
        if(!parentId||!modelById.has(parentId)) break;
        const pm = modelById.get(parentId);
        parentNames.push(`"${(pm.props[1]??'').split('\0')[0].replace(/Model$/,'')}"(${pm.props[2]})`);
        parentId = nodeToParent.get(parentId);
    }
    if(parentNames.length) console.log(`    Parents: ${parentNames.join(' → ')}`);
}
