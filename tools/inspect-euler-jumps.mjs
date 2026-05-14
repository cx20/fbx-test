// Detect bones with >90° per-frame Euler jumps across all animation clips
import { readFileSync } from 'fs';
import { inflate } from 'zlib';
import { promisify } from 'util';
const inflateAsync = promisify(inflate);
const FBX_TIME = 1 / 46186158000;

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
function findNode(c,n){return c.find(x=>x.name===n)??null;}
function prop0(n){return n?.props[0]??null;}

const raw = readFileSync('assets/models/fbx/warrior/Warrior.fbx');
const r = makeReader(raw); r.skip(23); const version=r.u32(); const is64=version>=7500;
const nodes = await parseNodes(r, raw.byteLength, is64);
const objs = nodes.find(n=>n.name==='Objects');
const conns = nodes.find(n=>n.name==='Connections');
const connList = conns.children.filter(c=>c.name==='C').map(c=>({type:c.props[0],from:c.props[1],to:c.props[2],prop:c.props[3]}));

const modelById = new Map();
const curveById = new Map();
const curveNodeById = new Map();
const layerById = new Map();
const stackById = new Map();
for(const o of objs.children) {
    if(o.name==='Model') modelById.set(o.props[0], o);
    if(o.name==='AnimationCurve') curveById.set(o.props[0], o);
    if(o.name==='AnimationCurveNode') curveNodeById.set(o.props[0], o);
    if(o.name==='AnimationLayer') layerById.set(o.props[0], o);
    if(o.name==='AnimationStack') stackById.set(o.props[0], o);
}

// Build maps
const curveToNode = new Map();
const nodeToModel = new Map();
const layerToStack = new Map();
const nodeToLayer = new Map();
for(const c of connList) {
    if(curveById.has(c.from) && curveNodeById.has(c.to)) curveToNode.set(c.from, c.to);
    if(curveNodeById.has(c.from) && modelById.has(c.to)) nodeToModel.set(c.from, {modelId:c.to, prop:c.prop});
    if(layerById.has(c.from) && stackById.has(c.to)) layerToStack.set(c.from, c.to);
    if(curveNodeById.has(c.from) && layerById.has(c.to)) nodeToLayer.set(c.from, c.to);
}

// For each clip, find R channels with large jumps
for(const [layerId] of layerById) {
    const stackId = layerToStack.get(layerId);
    const clipName = (stackById.get(stackId)?.props[1]??'clip').split('\0')[0];

    const jumpBones = [];
    for(const [cnId, {modelId, prop}] of nodeToModel) {
        if(nodeToLayer.get(cnId) !== layerId) continue;
        if(!prop?.includes('Rotation')) continue;
        const name = (modelById.get(modelId)?.props[1]??'').split('\0')[0].replace(/Model$/,'');

        // Get curves for this curveNode
        const curvesForNode = connList.filter(c=>c.to===cnId && curveById.has(c.from));
        const curves = curvesForNode.map(c=>({axis:c.prop, data:curveById.get(c.from)}));

        for(const {axis, data} of curves) {
            const times = prop0(findNode(data.children,'KeyTime'));
            const values = prop0(findNode(data.children,'KeyValueFloat'));
            if(!Array.isArray(times)||!Array.isArray(values)) continue;
            let maxJump = 0;
            for(let i=1;i<values.length;i++) {
                const jump = Math.abs(values[i]-values[i-1]);
                if(jump>maxJump) maxJump=jump;
            }
            if(maxJump > 90) {
                jumpBones.push({name, axis, maxJump: maxJump.toFixed(1)});
            }
        }
    }

    if(jumpBones.length>0) {
        console.log(`\nClip "${clipName}": ${jumpBones.length} bones with >90° frame jumps`);
        for(const {name,axis,maxJump} of jumpBones.sort((a,b)=>b.maxJump-a.maxJump).slice(0,8)) {
            console.log(`  ${name} ${axis}: max_jump=${maxJump}°`);
        }
        if(jumpBones.length>8) console.log(`  ... and ${jumpBones.length-8} more`);
    } else {
        console.log(`\nClip "${clipName}": no large Euler jumps`);
    }
}
