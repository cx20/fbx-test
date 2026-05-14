// Show all connections for key nodes
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

const raw = readFileSync('assets/models/fbx/warrior/Warrior.fbx');
const r = makeReader(raw); r.skip(23); const version=r.u32(); const is64=version>=7500;
const nodes = await parseNodes(r, raw.byteLength, is64);
const objs = nodes.find(n=>n.name==='Objects');
const conns = nodes.find(n=>n.name==='Connections');
const connList = conns.children.filter(c=>c.name==='C').map(c=>({
    type:c.props[0], from:c.props[1], to:c.props[2], prop:c.props[3]
}));

const objById = new Map();
for(const o of objs.children) {
    objById.set(o.props[0], { name: o.name, label: (o.props[1]??'').split('\0')[0], sub: o.props[2] });
}

const TARGET_IDS = new Set([
    1987303152, // 100800_kl_npc_mo_0 (mesh)
    650665264,  // 100800_kl_npc_mo (parent LimbNode)
    650663264,  // 100820_kl_npc (grandparent)
    650667264,  // Bip001
]);

// Show all connections involving these nodes
for(const id of TARGET_IDS) {
    const obj = objById.get(id);
    console.log(`\n=== "${obj?.label}" (${obj?.name}/${obj?.sub}) id=${id} ===`);
    const incoming = connList.filter(c => c.to === id);
    const outgoing = connList.filter(c => c.from === id);
    console.log(`  Incoming (from→THIS): ${incoming.length}`);
    for(const c of incoming) {
        const fromObj = objById.get(c.from);
        const label = fromObj ? `"${fromObj.label}" (${fromObj.name}/${fromObj.sub}) id=${c.from}` : `id=${c.from}`;
        console.log(`    [${c.type}] from: ${label} ${c.prop?`prop=${c.prop}`:''}`);
    }
    console.log(`  Outgoing (THIS→to): ${outgoing.length}`);
    for(const c of outgoing) {
        const toObj = objById.get(c.to);
        const label = toObj ? `"${toObj.label}" (${toObj.name}/${toObj.sub}) id=${c.to}` : `id=${c.to} (scene root?)`;
        console.log(`    [${c.type}] to: ${label} ${c.prop?`prop=${c.prop}`:''}`);
    }
}

// Also show what 100820_kl_npc connects to (its parent)
console.log('\n=== Parent of 100820_kl_npc ===');
const pConn = connList.filter(c => c.from === 650663264 && c.type === 'OO');
for(const c of pConn) {
    const toObj = objById.get(c.to);
    console.log(`  [OO] to: ${toObj ? `"${toObj.label}" (${toObj.name}) id=${c.to}` : `id=${c.to} (probably scene root=0)`}`);
}
