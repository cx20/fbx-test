// Inspect keyframe data for mv_tar21 animation in warrior/Warrior.fbx
import { readFileSync } from 'fs';
import { inflate } from 'zlib';
import { promisify } from 'util';
const inflateAsync = promisify(inflate);

const FBX_TIME_UNIT_SECONDS = 1 / 46186158000;

function makeReader(buf) {
    let o = 0;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
        get pos() { return o; },
        u8()  { return buf[o++]; },
        i16() { const v=dv.getInt16(o,true);  o+=2; return v; },
        i32() { const v=dv.getInt32(o,true);  o+=4; return v; },
        u32() { const v=dv.getUint32(o,true); o+=4; return v; },
        f32() { const v=dv.getFloat32(o,true);o+=4; return v; },
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
            const ab=raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength);
            const dv2=new DataView(ab);
            const out=[];
            for(let i=0;i<count;i++){const lo=dv2.getUint32(i*8,true),hi=dv2.getInt32(i*8+4,true);out.push(hi*4294967296+lo);}
            return out;
        }
        const Ctor={f:Float32Array,d:Float64Array,i:Int32Array,b:Uint8Array,c:Uint8Array}[t];
        const ab=raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength);
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

async function parseFBX(filePath) {
    const raw = readFileSync(filePath);
    const r = makeReader(raw);
    r.skip(23);
    const version = r.u32();
    const is64 = version >= 7500;
    const nodes = await parseNodes(r, raw.byteLength, is64);
    return nodes;
}

function findNode(nodes, name) { return nodes.find(n=>n.name===name)??null; }
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

const nodes = await parseFBX('assets/models/fbx/warrior/Warrior.fbx');
const objectsNode = findNode(nodes,'Objects');
const connsNode   = findNode(nodes,'Connections');
const connList    = connsNode
    ? connsNode.children.filter(c=>c.name==='C').map(c=>({type:c.props[0],from:c.props[1],to:c.props[2],prop:c.props[3]??null}))
    : [];

const allModelById      = new Map();
const animStackById     = new Map();
const animLayerById     = new Map();
const animCurveNodeById = new Map();
const animCurveById     = new Map();

for(const obj of objectsNode.children){
    const id=obj.props[0];
    if(obj.name==='Model') allModelById.set(id,obj);
    if(obj.name==='AnimationStack') animStackById.set(id,obj);
    if(obj.name==='AnimationLayer') animLayerById.set(id,obj);
    if(obj.name==='AnimationCurveNode') animCurveNodeById.set(id,obj);
    if(obj.name==='AnimationCurve') animCurveById.set(id,obj);
}

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

function dispName(id){
    const n=allModelById.get(id);
    return (n?.props[1]??'').split('\0')[0].replace(/Model$/,'') || `id_${id}`;
}

// Find mv_tar21 stack
const mv_tar21Stack=[...animStackById.entries()].find(([,n])=>n.props[1]?.includes('mv_tar21'));
if(!mv_tar21Stack) { console.log('mv_tar21 not found'); process.exit(1); }
const [stackId] = mv_tar21Stack;

// Find its layer
const layerId = [...animLayerToStack.entries()].find(([,sid])=>sid===stackId)?.[0];
if(!layerId) { console.log('no layer for mv_tar21'); process.exit(1); }

// Find curves for key bones
const KEY_BONE_NAMES = ['Bip001','Bip001 Pelvis','Bip001 Spine','Bip001 L Thigh','Bip001 R Thigh','Bip001 Head','Bip001 L UpperArm','Bip001 R UpperArm'];

// build name→id map
const modelByName = new Map();
for(const [id,node] of allModelById){
    const name=(node.props[1]??'').split('\0')[0].replace(/Model$/,'');
    modelByName.set(name,id);
}

console.log('=== mv_tar21 Animation Curves (key bones) ===\n');
console.log('Sample time: t=0.433s (= 1.0s % 0.567s duration)\n');

for(const boneName of KEY_BONE_NAMES){
    const boneId = modelByName.get(boneName);
    if(!boneId) { console.log(`  ${boneName}: NOT FOUND in model list`); continue; }

    // find curve nodes targeting this bone in mv_tar21 layer
    const channels = {T:[null,null,null], R:[null,null,null], S:[null,null,null]};
    let hasCurves = false;
    for(const [cnId,target] of animCurveNodeToTarget){
        if(target.modelId !== boneId) continue;
        if(animCurveNodeToLayer.get(cnId) !== layerId) continue;
        const key = target.property==='Lcl Translation'?'T':target.property==='Lcl Rotation'?'R':target.property==='Lcl Scaling'?'S':null;
        if(!key) continue;
        hasCurves = true;
        const curveNodes = animCurvesByNode.get(cnId)??[null,null,null];
        for(let ax=0;ax<3;ax++){
            if(curveNodes[ax]) channels[key][ax] = curveNodes[ax];
        }
    }

    if(!hasCurves){ console.log(`  ${boneName}: no animation curves in mv_tar21`); continue; }

    console.log(`  ${boneName}:`);
    const AXES=['X','Y','Z'];
    for(const key of ['T','R','S']){
        for(let ax=0;ax<3;ax++){
            const curveNode = channels[key][ax];
            if(!curveNode) continue;
            const keyTimes  = prop0(findNode(curveNode.children,'KeyTime'))??[];
            const keyValues = prop0(findNode(curveNode.children,'KeyValueFloat'))??[];
            if(!keyTimes.length) continue;
            const times = keyTimes.map(t=>t*FBX_TIME_UNIT_SECONDS);
            // find keyframes around t=0.433
            const TARGET_T = 0.433;
            let lo=0;
            for(let i=0;i<times.length;i++) if(times[i]<=TARGET_T) lo=i;
            const hi=Math.min(lo+1,times.length-1);
            const loT=times[lo], loV=keyValues[lo];
            const hiT=times[hi], hiV=keyValues[hi];
            const span=hiT-loT||1;
            const t=(TARGET_T-loT)/span;
            const interp=loV+(hiV-loV)*t;
            // also show max abs value in full curve
            const maxAbs=Math.max(...keyValues.map(Math.abs));
            // show first 3 and last 2 keyframe values
            const nk=times.length;
            const preview = [
                `t=${times[0].toFixed(3)}=${keyValues[0].toFixed(1)}`,
                nk>2?`t=${times[1].toFixed(3)}=${keyValues[1].toFixed(1)}`:'',
                nk>3?`...`:'',
                nk>2?`t=${times[nk-2].toFixed(3)}=${keyValues[nk-2].toFixed(1)}`:'',
                `t=${times[nk-1].toFixed(3)}=${keyValues[nk-1].toFixed(1)}`,
            ].filter(Boolean).join('  ');
            console.log(`    ${key}${AXES[ax]}: nKeys=${nk}  maxAbs=${maxAbs.toFixed(1)}  @0.433s: [${loV.toFixed(1)} → ${hiV.toFixed(1)}] = ${interp.toFixed(2)}   (${preview})`);
        }
    }
    console.log('');
}

// Also check: does Bip001 have any animation data?
console.log('=== All bones with curves in mv_tar21 ===');
const bonesWithCurves=new Set();
for(const [cnId,target] of animCurveNodeToTarget){
    if(animCurveNodeToLayer.get(cnId)!==layerId) continue;
    const curveNodes=animCurvesByNode.get(cnId)??[null,null,null];
    if(curveNodes.some(c=>c!==null)) bonesWithCurves.add(target.modelId);
}
console.log(`  Total bones with animation curves: ${bonesWithCurves.size}`);
for(const id of bonesWithCurves){
    const name=dispName(id);
    console.log(`  ${name}`);
}
