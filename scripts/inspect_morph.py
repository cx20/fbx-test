#!/usr/bin/env python3
"""Inspect FBX morph target (BlendShape) structure."""
import os, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import struct, zlib

class R:
    def __init__(self, path):
        with open(path,"rb") as f: self.data=f.read()
        self.pos=27; self.version=struct.unpack_from("<I",self.data,23)[0]; self.is64=self.version>=7500
    def u8(self): v=struct.unpack_from("B",self.data,self.pos)[0]; self.pos+=1; return v
    def u32(self): v=struct.unpack_from("<I",self.data,self.pos)[0]; self.pos+=4; return v
    def u64(self): v=struct.unpack_from("<Q",self.data,self.pos)[0]; self.pos+=8; return v
    def off(self): return self.u64() if self.is64 else self.u32()
    def arr(self,fmt,sz):
        c=self.u32(); e=self.u32(); cl=self.u32()
        if e==1: raw=zlib.decompress(self.data[self.pos:self.pos+cl]); self.pos+=cl
        else: raw=self.data[self.pos:self.pos+c*sz]; self.pos+=c*sz
        return list(struct.unpack_from(f"<{c}{fmt}",raw))
    def i16(self): v=struct.unpack_from("<h",self.data,self.pos)[0]; self.pos+=2; return v
    def i32(self): v=struct.unpack_from("<i",self.data,self.pos)[0]; self.pos+=4; return v
    def i64(self): v=struct.unpack_from("<q",self.data,self.pos)[0]; self.pos+=8; return v
    def f32(self): v=struct.unpack_from("<f",self.data,self.pos)[0]; self.pos+=4; return v
    def f64(self): v=struct.unpack_from("<d",self.data,self.pos)[0]; self.pos+=8; return v
    def str(self):
        n=self.u32(); v=self.data[self.pos:self.pos+n].decode("utf-8","replace"); self.pos+=n; return v
    def prop(self):
        t=chr(self.u8())
        if t=="C": return bool(self.u8())
        elif t=="Y": return self.i16()
        elif t=="I": return self.i32()
        elif t=="L": return self.i64()
        elif t=="F": return self.f32()
        elif t=="D": return self.f64()
        elif t in("f","d","i","l","b","c"):
            fmts={"f":"f","d":"d","i":"i","l":"q","b":"B","c":"B"}; szs={"f":4,"d":8,"i":4,"l":8,"b":1,"c":1}
            return self.arr(fmts[t],szs[t])
        elif t=="S": return self.str()
        elif t=="R": n=self.u32(); v=self.data[self.pos:self.pos+n]; self.pos+=n; return bytes(v)
        else: raise ValueError(f"Unknown {t!r}")

class N:
    __slots__=("name","props","children")
    def __init__(self,n,p,c): self.name=n; self.props=p; self.children=c

def pnode(r):
    e=r.off(); np=r.off(); _=r.off(); nl=r.u8()
    name=r.data[r.pos:r.pos+nl].decode("utf-8","replace"); r.pos+=nl
    ns=25 if r.is64 else 13
    if e==0 and np==0 and nl==0: return None
    props=[r.prop() for _ in range(np)]
    children=[]
    if r.pos<e:
        while r.pos<e-ns:
            child=pnode(r)
            if child is None: break
            children.append(child)
        r.pos=e
    return N(name,props,children)

def load(path):
    r=R(path); roots=[]; ns=25 if r.is64 else 13
    while r.pos<len(r.data)-ns:
        node=pnode(r)
        if node is None: break
        roots.append(node)
    return roots

def iter_nodes(nodes, name=None):
    for n in nodes:
        if name is None or n.name==name: yield n
        yield from iter_nodes(n.children, name)

def find_child(node, name):
    return next((c for c in node.children if c.name==name), None)

path = sys.argv[1]
roots = load(path)

print(f"\n=== {os.path.basename(path)} ===")

# Geometries
geo_ids = set()
print("\n--- Geometries ---")
for g in iter_nodes(roots, "Geometry"):
    if g.props:
        gtype = g.props[2] if len(g.props) > 2 else "?"
        verts_node = find_child(g, "Vertices")
        vcount = len(verts_node.props[0])//3 if verts_node and verts_node.props else 0
        print(f"  id={g.props[0]} type={gtype!r} verts={vcount}")
        if gtype == "Shape":
            indexes = find_child(g, "Indexes")
            normals = find_child(g, "Normals")
            print(f"    Indexes: {len(indexes.props[0]) if indexes and indexes.props else 0}")
            print(f"    Vertices (deltas): {vcount}")
            print(f"    Normals (deltas): {'yes' if normals else 'no'}")
        geo_ids.add(g.props[0])

# Deformers (BlendShape and BlendShapeChannel)
print("\n--- Deformers ---")
bs_ids = set()
bsc_ids = set()
for d in iter_nodes(roots, "Deformer"):
    if d.props and len(d.props) > 2:
        dt = d.props[2]
        if dt in ("BlendShape", "BlendShapeChannel"):
            print(f"  id={d.props[0]} name={d.props[1]!r} type={dt!r}")
            if dt == "BlendShape": bs_ids.add(d.props[0])
            elif dt == "BlendShapeChannel":
                bsc_ids.add(d.props[0])
                # Show DeformPercent and FullWeights
                deform_pct = find_child(d, "DeformPercent")
                full_weights = find_child(d, "FullWeights")
                if deform_pct:
                    print(f"    DeformPercent: {deform_pct.props[0]}")
                if full_weights:
                    print(f"    FullWeights: {full_weights.props[0]}")

# Connections
print("\n--- Morph-related Connections ---")
for n in roots:
    if n.name == "Connections":
        for c in n.children:
            if c.name != "C": continue
            fromId = c.props[1]
            toId = c.props[2]
            ctype = c.props[0]
            if fromId in bs_ids and toId in geo_ids:
                print(f"  [BS->Geo] {fromId} -> {toId}")
            elif fromId in bsc_ids and toId in bs_ids:
                print(f"  [BSC->BS] {fromId} -> {toId}")
            elif fromId in geo_ids and toId in bsc_ids:
                print(f"  [Shape->BSC] {fromId} -> {toId}")
            elif ctype == "OP" and toId in bsc_ids:
                print(f"  [Anim->BSC] {fromId} -> {toId} prop={c.props[3] if len(c.props)>3 else '?'!r}")
        break
