#!/usr/bin/env python3
"""Inspect FBX skinning structure (Deformer/Cluster nodes and connections)."""
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

if len(sys.argv) < 2:
    print("Usage: python inspect_skinning.py <fbx-file>")
    sys.exit(1)

path = sys.argv[1]
roots = load(path)

# Find all Deformers
print(f"\n=== Deformers in {os.path.basename(path)} ===")
for d in iter_nodes(roots, "Deformer"):
    if d.props:
        deformer_type = d.props[2] if len(d.props) > 2 else "?"
        print(f"  id={d.props[0]} name={d.props[1]!r} type={deformer_type!r}")
        if deformer_type == "Cluster":
            for c in d.children:
                if c.name in ("Indexes", "Weights", "TransformLink", "Transform"):
                    p = c.props[0] if c.props else None
                    if isinstance(p, list):
                        print(f"    {c.name}: array (len={len(p)}) first 8={p[:8]}")
                    else:
                        print(f"    {c.name}: {p}")

# Find Models (bones)
print(f"\n=== LimbNode/Mesh Models ===")
limb_count = 0
for m in iter_nodes(roots, "Model"):
    if m.props and len(m.props) > 2:
        mtype = m.props[2]
        if mtype in ("LimbNode", "Limb"):
            print(f"  id={m.props[0]} name={m.props[1]!r} type={mtype!r}")
            limb_count += 1
        elif mtype == "Mesh":
            print(f"  [Mesh] id={m.props[0]} name={m.props[1]!r}")
print(f"  Total LimbNodes: {limb_count}")

# Print all Connections relevant to skinning
print(f"\n=== Skin-related Connections ===")
conns = find_child(N("root", None, roots), "Connections")
if conns is None:
    for n in roots:
        if n.name == "Connections":
            conns = n; break

geoIds = set()
for g in iter_nodes(roots, "Geometry"):
    if g.props: geoIds.add(g.props[0])

deformerIds = set()
clusterIds = set()
for d in iter_nodes(roots, "Deformer"):
    if d.props and len(d.props) > 2:
        if d.props[2] == "Skin": deformerIds.add(d.props[0])
        elif d.props[2] == "Cluster": clusterIds.add(d.props[0])

limbIds = set()
for m in iter_nodes(roots, "Model"):
    if m.props and len(m.props) > 2 and m.props[2] in ("LimbNode", "Limb"):
        limbIds.add(m.props[0])

if conns:
    print(f"  Connection types between skinning objects:")
    for c in conns.children:
        if c.name != "C": continue
        fromId = c.props[1]
        toId   = c.props[2]
        # Skin → Geometry
        if fromId in deformerIds and toId in geoIds:
            print(f"  [Skin->Geo] {fromId} -> {toId}")
        # Cluster → Skin
        elif fromId in clusterIds and toId in deformerIds:
            print(f"  [Cluster->Skin] {fromId} -> {toId}")
        # Limb → Cluster
        elif fromId in limbIds and toId in clusterIds:
            print(f"  [Limb->Cluster] {fromId} -> {toId}")
