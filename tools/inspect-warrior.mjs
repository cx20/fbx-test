// Inspect warrior/Warrior.fbx — dump bone RotationOrder, PreRotation, LclRotation,
// and TransformLink so we can compare with what fbx-loader.js computes.
import { readFileSync } from 'fs';
import { inflate } from 'zlib';
import { promisify } from 'util';
const inflateAsync = promisify(inflate);

const FBX_TIME_UNIT_SECONDS = 1 / 46186158000;

// ---- binary reader ----
function makeReader(buf) {
    let o = 0;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
        get pos() { return o; },
        u8()  { return buf[o++]; },
        i16() { const v = dv.getInt16(o,true);  o+=2; return v; },
        i32() { const v = dv.getInt32(o,true);  o+=4; return v; },
        u32() { const v = dv.getUint32(o,true); o+=4; return v; },
        f32() { const v = dv.getFloat32(o,true);o+=4; return v; },
        f64() { const v = dv.getFloat64(o,true);o+=8; return v; },
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
    if (t==='F') return r.f32();
    if (t==='D') return r.f64();
    if (t==='L') return r.i64();
    if (t==='S') { const n=r.u32(); return r.str(n); }
    if (t==='R') { const n=r.u32(); return r.buf(n); }
    if ('fdilbc'.includes(t)) {
        const count=r.u32(), enc=r.u32(), clen=r.u32();
        let raw = r.buf(clen);
        if (enc===1) raw = await inflateAsync(raw);
        if (t==='l') {
            const ab2 = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            const dv2 = new DataView(ab2);
            const out=[];
            for(let i=0;i<count;i++){const lo=dv2.getUint32(i*8,true),hi=dv2.getInt32(i*8+4,true);out.push(hi*4294967296+lo);}
            return out;
        }
        const Ctor={f:Float32Array,d:Float64Array,i:Int32Array,b:Uint8Array,c:Uint8Array}[t];
        const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        return Array.from(new Ctor(ab));
    }
    throw new Error(`unknown type ${t}`);
}

async function parseNodes(r, end, is64) {
    const nullSz = is64?25:13;
    const nodes=[];
    while(r.pos < end) {
        const ne  = is64?r.i64():r.u32();
        const np  = is64?r.i64():r.u32();
        is64?r.i64():r.u32(); // propListLen
        const nl  = r.u8();
        const name= r.str(nl);
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

async function parseFBX(filePath) {
    const raw = readFileSync(filePath);
    const magic = raw.slice(0,23).toString('utf8');
    if (!magic.startsWith('Kaydara FBX Binary')) throw new Error('not binary FBX');
    const r = makeReader(raw);
    r.skip(23);
    const version = r.u32();
    const is64 = version >= 7500;
    const nodes = await parseNodes(r, raw.byteLength, is64);
    return nodes;
}

function findNode(nodes, name) { return nodes.find(n=>n.name===name)??null; }
function findNodes(nodes, name) { return nodes.filter(n=>n.name===name); }
function prop0(n) { return n?.props[0]??null; }

function parseProps70(node) {
    const map=new Map();
    if(!node) return map;
    for(const p of node.children) {
        if(p.name!=='P'||p.props.length<5) continue;
        map.set(p.props[0], p.props.length===5 ? p.props[4] : p.props.slice(4));
    }
    return map;
}

// ---- Matrix helpers ----
function m4fromColMajor(tl) {
    // tl: column-major (FBX) → return 4x4 as [[r0c0,r0c1,r0c2,r0c3],[r1...],...]
    const m=[];
    for(let r=0;r<4;r++) m.push([tl[0*4+r],tl[1*4+r],tl[2*4+r],tl[3*4+r]]);
    return m;
}
function m4fmt(m) {
    return m.map(row=>row.map(v=>v.toFixed(4).padStart(8)).join(' ')).join('\n         ');
}
function m4mul(A,B) {
    const C=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
    for(let r=0;r<4;r++) for(let c=0;c<4;c++) for(let k=0;k<4;k++) C[r][c]+=A[r][k]*B[k][c];
    return C;
}
function m4inv(m) {
    // Cofactor expansion for 4x4
    const a=m[0],b=m[1],c=m[2],d=m[3];
    const det = (row,col)=>{
        const rows=[0,1,2,3].filter(r=>r!==row);
        const cols=[0,1,2,3].filter(c2=>c2!==col);
        const s=rows.map(r=>cols.map(c2=>m[r][c2]));
        return s[0][0]*(s[1][1]*s[2][2]-s[1][2]*s[2][1])
              -s[0][1]*(s[1][0]*s[2][2]-s[1][2]*s[2][0])
              +s[0][2]*(s[1][0]*s[2][1]-s[1][1]*s[2][0]);
    };
    const D = a[0]*det(0,0)-a[1]*det(0,1)+a[2]*det(0,2)-a[3]*det(0,3);
    if(Math.abs(D)<1e-12) return null;
    const inv=[];
    for(let r=0;r<4;r++){
        inv.push([]);
        for(let cc=0;cc<4;cc++){
            inv[r].push(((r+cc)%2===0?1:-1)*det(cc,r)/D);
        }
    }
    return inv;
}
function eulerToMat3(rx,ry,rz,order) {
    const cx=Math.cos(rx),sx=Math.sin(rx);
    const cy=Math.cos(ry),sy=Math.sin(ry);
    const cz=Math.cos(rz),sz=Math.sin(rz);
    const Rx=[[1,0,0],[0,cx,-sx],[0,sx,cx]];
    const Ry=[[cy,0,sy],[0,1,0],[-sy,0,cy]];
    const Rz=[[cz,-sz,0],[sz,cz,0],[0,0,1]];
    function mm3(A,B){const C=[[0,0,0],[0,0,0],[0,0,0]];for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++)C[r][c]+=A[r][k]*B[k][c];return C;}
    switch(order){
        case 1: return mm3(mm3(Rx,Rz),Ry); // XZY
        case 2: return mm3(mm3(Ry,Rz),Rx); // YZX
        case 3: return mm3(mm3(Ry,Rx),Rz); // YXZ
        case 4: return mm3(mm3(Rz,Rx),Ry); // ZXY
        case 5: return mm3(mm3(Rz,Ry),Rx); // ZYX
        default: return mm3(mm3(Rx,Ry),Rz); // XYZ (0)
    }
}
function makeTRSMatrix(T,R_deg,S,preR_deg,rotOrder) {
    const toRad=v=>v*Math.PI/180;
    const preRmat = eulerToMat3(toRad(preR_deg[0]),toRad(preR_deg[1]),toRad(preR_deg[2]),0);
    const Rmat    = eulerToMat3(toRad(R_deg[0]),   toRad(R_deg[1]),   toRad(R_deg[2]),   rotOrder);
    function mm3(A,B){const C=[[0,0,0],[0,0,0],[0,0,0]];for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++)C[r][c]+=A[r][k]*B[k][c];return C;}
    const rot=mm3(preRmat,Rmat);
    return [
        [rot[0][0]*S[0], rot[0][1]*S[1], rot[0][2]*S[2], T[0]],
        [rot[1][0]*S[0], rot[1][1]*S[1], rot[1][2]*S[2], T[1]],
        [rot[2][0]*S[0], rot[2][1]*S[1], rot[2][2]*S[2], T[2]],
        [0,0,0,1]
    ];
}

// ---- main ----
const nodes = await parseFBX('assets/models/fbx/warrior/Warrior.fbx');
const objectsNode = findNode(nodes,'Objects');
const connsNode   = findNode(nodes,'Connections');
const connList    = connsNode
    ? connsNode.children.filter(c=>c.name==='C').map(c=>({type:c.props[0],from:c.props[1],to:c.props[2],prop:c.props[3]??null}))
    : [];

const allModelById  = new Map();
const clusterById   = new Map();
const skinById      = new Map();
const animStackById = new Map();
const animLayerById = new Map();
const animCurveNodeById = new Map();
const animCurveById = new Map();

for(const obj of objectsNode.children){
    const id=obj.props[0];
    if(obj.name==='Model') allModelById.set(id,obj);
    if(obj.name==='Deformer'&&obj.props[2]==='Cluster') clusterById.set(id,obj);
    if(obj.name==='Deformer'&&obj.props[2]==='Skin') skinById.set(id,obj);
    if(obj.name==='AnimationStack') animStackById.set(id,obj);
    if(obj.name==='AnimationLayer') animLayerById.set(id,obj);
    if(obj.name==='AnimationCurveNode') animCurveNodeById.set(id,obj);
    if(obj.name==='AnimationCurve') animCurveById.set(id,obj);
}

const nodeToParent      = new Map();
const geoToSkin         = new Map();
const skinToClusters    = new Map();
const clusterToBoneModel= new Map();
const animLayerToStack  = new Map();
const animCurveNodeToLayer  = new Map();
const animCurveNodeToTarget = new Map();
const animCurvesByNode  = new Map();

function getAxis(prop){
    if(!prop) return -1;
    if(prop.endsWith('X')) return 0;
    if(prop.endsWith('Y')) return 1;
    if(prop.endsWith('Z')) return 2;
    return -1;
}

for(const c of connList){
    if(c.type==='OO'&&allModelById.has(c.from)&&!nodeToParent.has(c.from)) nodeToParent.set(c.from,c.to);
    if(skinById.has(c.from)) geoToSkin.set(c.to,c.from);
    if(clusterById.has(c.from)&&skinById.has(c.to)){
        if(!skinToClusters.has(c.to)) skinToClusters.set(c.to,[]);
        skinToClusters.get(c.to).push(c.from);
    }
    if(allModelById.has(c.from)&&clusterById.has(c.to)) clusterToBoneModel.set(c.to,c.from);
    if(animLayerById.has(c.from)&&animStackById.has(c.to)) animLayerToStack.set(c.from,c.to);
    if(animCurveNodeById.has(c.from)&&animLayerById.has(c.to)) animCurveNodeToLayer.set(c.from,c.to);
    if(animCurveNodeById.has(c.from)&&allModelById.has(c.to))
        animCurveNodeToTarget.set(c.from,{modelId:c.to,property:c.prop});
    if(animCurveById.has(c.from)&&animCurveNodeById.has(c.to)){
        const ax=getAxis(c.prop);
        if(ax>=0){
            if(!animCurvesByNode.has(c.to)) animCurvesByNode.set(c.to,[null,null,null]);
            animCurvesByNode.get(c.to)[ax]=animCurveById.get(c.from);
        }
    }
}

function getCurveData(curveNode){
    const keyTimes  = prop0(findNode(curveNode.children,'KeyTime'))??[];
    const keyValues = prop0(findNode(curveNode.children,'KeyValueFloat'))??[];
    return {times:keyTimes.map(t=>t*FBX_TIME_UNIT_SECONDS),values:keyValues};
}
function sampleCurve(curve,t,fb){
    if(!curve||!curve.times.length) return fb;
    const times=curve.times,vals=curve.values;
    if(t<=times[0]) return vals[0];
    const last=times.length-1;
    if(t>=times[last]) return vals[last];
    let lo=0,hi=last;
    while(lo+1<hi){const mid=(lo+hi)>>1;if(times[mid]<=t)lo=mid;else hi=mid;}
    const span=times[hi]-times[lo]||1;
    return vals[lo]+(vals[hi]-vals[lo])*(t-times[lo])/span;
}

// Gather animation layers per stack
const layersByStack = new Map();
for(const [layerId,stackId] of animLayerToStack){
    if(!layersByStack.has(stackId)) layersByStack.set(stackId,[]);
    layersByStack.get(stackId).push(layerId);
}

// Build a map: layerId → { modelId → { T:[curve,curve,curve], R:[...], S:[...] } }
function buildChannels(layerId){
    const ch=new Map();
    for(const [cnId,target] of animCurveNodeToTarget){
        if(animCurveNodeToLayer.get(cnId)!==layerId) continue;
        const key=target.property==='Lcl Translation'?'T':target.property==='Lcl Rotation'?'R':target.property==='Lcl Scaling'?'S':null;
        if(!key) continue;
        const cnNode=animCurveNodeById.get(cnId);
        const p70=parseProps70(findNode(cnNode.children,'Properties70'));
        const curves=(animCurvesByNode.get(cnId)??[null,null,null]).map(cn=>cn?getCurveData(cn):null);
        const defaults=[p70.get('d|X')??0,p70.get('d|Y')??0,p70.get('d|Z')??0];
        if(!ch.has(target.modelId)) ch.set(target.modelId,{});
        ch.get(target.modelId)[key]={curves,defaults};
    }
    return ch;
}

function sampleChannel(ch,key,t,fallback){
    const c=ch?.[key];
    if(!c) return fallback;
    return [
        sampleCurve(c.curves[0],t,c.defaults[0]??fallback[0]),
        sampleCurve(c.curves[1],t,c.defaults[1]??fallback[1]),
        sampleCurve(c.curves[2],t,c.defaults[2]??fallback[2]),
    ];
}

// Build bone list from clusters
function getBoneModelIds(){
    const ids=new Set();
    for(const skinId of skinById.keys()){
        for(const cid of (skinToClusters.get(skinId)??[])){
            const bmid=clusterToBoneModel.get(cid);
            if(bmid!==undefined&&allModelById.has(bmid)) ids.add(bmid);
        }
    }
    return ids;
}

const boneModelIds=getBoneModelIds();

// Build display name
function dispName(id){
    const n=allModelById.get(id);
    return (n?.props[1]??'').split('\0')[0].replace(/Model$/,'') || `id_${id}`;
}

// Build hierarchy (parent lookup)
function worldMatrix(boneId,channelsByModel,t){
    // accumulate from root
    const chain=[];
    let cur=boneId;
    while(cur&&cur!==0&&allModelById.has(cur)){
        chain.push(cur);
        cur=nodeToParent.get(cur);
    }
    chain.reverse();
    let W=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
    for(const id of chain){
        const model=allModelById.get(id);
        const p70=parseProps70(findNode(model.children,'Properties70'));
        const T0  =p70.get('Lcl Translation')??[0,0,0];
        const R0  =p70.get('Lcl Rotation')??[0,0,0];
        const S0  =p70.get('Lcl Scaling')??[1,1,1];
        const preR=p70.get('PreRotation')??[0,0,0];
        const rotOrder=p70.get('RotationOrder')??0;
        const ch=channelsByModel?.get(id);
        const T=sampleChannel(ch,'T',t,T0);
        const R=sampleChannel(ch,'R',t,R0);
        const S=sampleChannel(ch,'S',t,S0);
        const local=makeTRSMatrix(T,R,S,preR,rotOrder);
        W=m4mul(W,local);
    }
    return W;
}

// ---- Report ----
console.log('\n=== Warrior.fbx — Bone RotationOrder & PreRotation ===');
for(const boneId of boneModelIds){
    const model=allModelById.get(boneId);
    const p70=parseProps70(findNode(model.children,'Properties70'));
    const preR=p70.get('PreRotation')??[0,0,0];
    const rotOrder=p70.get('RotationOrder')??0;
    const R0  =p70.get('Lcl Rotation')??[0,0,0];
    const name=dispName(boneId);
    const orderNames=['XYZ','XZY','YZX','YXZ','ZXY','ZYX'];
    if(rotOrder!==0||Math.abs(preR[0])>0.01||Math.abs(preR[1])>0.01||Math.abs(preR[2])>0.01){
        console.log(`  ${name.padEnd(30)} rotOrder=${orderNames[rotOrder]??rotOrder} preR=[${preR.map(v=>v.toFixed(2)).join(',')}] R0=[${R0.map(v=>v.toFixed(2)).join(',')}]`);
    }
}

console.log('\n=== Warrior.fbx — Animation Clips ===');
for(const [stackId,stackNode] of animStackById){
    const name=stackNode.props[1]?.split('\0')[0]??'?';
    const p70=parseProps70(findNode(stackNode.children,'Properties70'));
    const localStart=p70.get('LocalStart');
    const localStop =p70.get('LocalStop');
    const ls=localStart!=null?localStart*FBX_TIME_UNIT_SECONDS:null;
    const le=localStop !=null?localStop *FBX_TIME_UNIT_SECONDS:null;
    const layers=layersByStack.get(stackId)??[];
    const layerId=layers[0];
    const ch=layerId?buildChannels(layerId):new Map();
    let start=Infinity,stop=-Infinity;
    for(const [,bch] of ch){
        for(const key of ['T','R','S']){
            const c=bch[key];
            if(!c) continue;
            for(const curve of c.curves){
                if(!curve||!curve.times.length) continue;
                start=Math.min(start,curve.times[0]);
                stop =Math.max(stop, curve.times[curve.times.length-1]);
            }
        }
    }
    console.log(`  "${name}" frames=[${isFinite(start)?start.toFixed(4):'?'} .. ${isFinite(stop)?stop.toFixed(4):'?'}] LocalStart=${ls!=null?ls.toFixed(4):'(none)'} LocalStop=${le!=null?le.toFixed(4):'(none)'}`);
}

console.log('\n=== TransformLink vs computed world matrix at bind pose (t=0) ===');
console.log('(Columns: T_x T_y T_z / TL_x TL_y TL_z — translation components only)');

// Build clusterByBone
const clusterByBone=new Map();
for(const skinId of skinById.keys()){
    for(const cid of (skinToClusters.get(skinId)??[])){
        const bmid=clusterToBoneModel.get(cid);
        if(bmid!==undefined) clusterByBone.set(bmid,cid);
    }
}

// For each bone with TransformLink, compare world matrix at t=0 with TransformLink
const BONES_TO_CHECK=['Bip001','Bip001 Pelvis','Bip001 Spine','Bip001 L Thigh','Bip001 R Thigh','Bip001 Head'];

// get first layer of idle clip
const idleStack=[...animStackById.entries()].find(([,n])=>n.props[1]?.includes('idle'))?.[0];
const idleLayer=(idleStack&&layersByStack.get(idleStack))||[...animLayerToStack.keys()];
const firstLayerId=Array.isArray(idleLayer)?idleLayer[0]:idleLayer;
const idleChannels=buildChannels(firstLayerId);

for(const boneId of boneModelIds){
    const name=dispName(boneId);
    if(!BONES_TO_CHECK.some(b=>name===b)) continue;
    const cid=clusterByBone.get(boneId);
    if(!cid) continue;
    const clNode=clusterById.get(cid);
    const tlRaw=prop0(findNode(clNode.children,'TransformLink'));
    if(!Array.isArray(tlRaw)||tlRaw.length!==16) continue;
    const TL=m4fromColMajor(tlRaw);

    // Compute world matrix at t=0 from hierarchy + animation curves of idle clip
    const W=worldMatrix(boneId,idleChannels,0);

    const tl_pos=[TL[0][3],TL[1][3],TL[2][3]];
    const w_pos =[W[0][3], W[1][3], W[2][3]];
    const match=tl_pos.every((v,i)=>Math.abs(v-w_pos[i])<0.5);
    console.log(`\n  ${name}`);
    console.log(`    TransformLink  pos=(${tl_pos.map(v=>v.toFixed(2)).join(',\t')})`);
    console.log(`    WorldMatrix(0) pos=(${w_pos.map(v=>v.toFixed(2)).join(',\t')})  ${match?'✓ match':'✗ MISMATCH'}`);
    // Show full rotation rows
    console.log(`    TL  rot row0=[${TL[0].slice(0,3).map(v=>v.toFixed(4)).join(',')}]`);
    console.log(`    W   rot row0=[${W[0].slice(0,3).map(v=>v.toFixed(4)).join(',')}]`);
}

console.log('\n=== Per-clip bone rotation at t=0 for key bones ===');
const KEY_BONES=['Bip001','Bip001 Pelvis','Bip001 L Thigh'];

for(const [stackId,stackNode] of animStackById){
    const stackName=stackNode.props[1]?.split('\0')[0]??'?';
    const layers=layersByStack.get(stackId)??[];
    const layerId=layers[0];
    if(!layerId) continue;
    const ch=buildChannels(layerId);
    // find time range
    let start=Infinity,stop=-Infinity;
    for(const [,bch] of ch){
        for(const key of ['T','R','S']){
            const c=bch[key];if(!c) continue;
            for(const curve of c.curves){
                if(!curve||!curve.times.length) continue;
                start=Math.min(start,curve.times[0]);
                stop=Math.max(stop,curve.times[curve.times.length-1]);
            }
        }
    }
    if(!isFinite(start)) continue;
    const sampleTimes=[start, start+(stop-start)*0.25, start+(stop-start)*0.5];

    console.log(`\n  Clip: "${stackName}" [${start.toFixed(3)}..${stop.toFixed(3)}s]`);
    for(const boneId of boneModelIds){
        const name=dispName(boneId);
        if(!KEY_BONES.some(b=>name===b)) continue;
        const model=allModelById.get(boneId);
        const p70=parseProps70(findNode(model.children,'Properties70'));
        const R0  =p70.get('Lcl Rotation')??[0,0,0];
        const preR=p70.get('PreRotation')??[0,0,0];
        const rotOrder=p70.get('RotationOrder')??0;
        const bch=ch.get(boneId);
        const rots=sampleTimes.map(t=>{
            const R=sampleChannel(bch,'R',t,R0);
            return `[${R.map(v=>v.toFixed(1)).join(',')}]`;
        });
        console.log(`    ${name.padEnd(25)} preR=[${preR.map(v=>v.toFixed(1)).join(',')}] rotOrder=${rotOrder}  R@t=${sampleTimes.map((t,i)=>`${t.toFixed(3)}=${rots[i]}`).join('  ')}`);
    }
}
