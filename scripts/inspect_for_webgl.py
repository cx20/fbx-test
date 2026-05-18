#!/usr/bin/env python3
"""Inspect vCube and AnimatedTriangle for WebGL1.0 sample design."""
import os, sys, io
sys.path.insert(0, os.path.dirname(__file__))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# Reuse parser helpers from analyze_simpleskin
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

for label, path in [
    ("vCube", "../assets/models/fbx/vCube.fbx"),
    ("AnimatedTriangle", "../assets/models/fbx/gltf/AnimatedTriangle.fbx"),
]:
    full = os.path.join(os.path.dirname(__file__), path)
    print(f"\n========== {label} ({path}) ==========")
    roots = load(full)
    for n in roots:
        print(f"  top: {n.name}")
    for geo in iter_nodes(roots, "Geometry"):
        if not geo.props: continue
        verts = find_child(geo, "Vertices")
        idx = find_child(geo, "PolygonVertexIndex")
        norms = find_child(geo, "LayerElementNormal")
        uvs = find_child(geo, "LayerElementUV")
        vcount = len(verts.props[0]) // 3 if verts else 0
        icount = len(idx.props[0]) if idx else 0
        print(f"\n  Geometry id={geo.props[0]} name={geo.props[1]!r}")
        print(f"    vertices: {vcount} (first 12 raw values: {verts.props[0][:12] if verts else 'none'})")
        print(f"    PolygonVertexIndex: {icount} entries")
        if idx:
            print(f"      first 12: {idx.props[0][:12]}")
        print(f"    has normals: {norms is not None}, has UVs: {uvs is not None}")
        if norms:
            mapping = find_child(norms, "MappingInformationType")
            ref = find_child(norms, "ReferenceInformationType")
            normals = find_child(norms, "Normals")
            print(f"      normal mapping: {mapping.props[0] if mapping else '?'}, ref: {ref.props[0] if ref else '?'}, count={(len(normals.props[0])//3) if normals else 0}")
    for stack in iter_nodes(roots, "AnimationStack"):
        if not stack.props: continue
        print(f"\n  AnimationStack id={stack.props[0]} name={stack.props[1]!r}")
    # Models
    for m in iter_nodes(roots, "Model"):
        if not m.props: continue
        p70 = find_child(m, "Properties70")
        T=R_=S=preR=None
        if p70:
            for p in p70.children:
                if p.name=='P' and p.props:
                    k = p.props[0]
                    if k == "Lcl Translation" and len(p.props)>6: T=[p.props[4],p.props[5],p.props[6]]
                    elif k == "Lcl Rotation" and len(p.props)>6: R_=[p.props[4],p.props[5],p.props[6]]
                    elif k == "Lcl Scaling" and len(p.props)>6: S=[p.props[4],p.props[5],p.props[6]]
                    elif k == "PreRotation" and len(p.props)>6: preR=[p.props[4],p.props[5],p.props[6]]
        nm = m.props[1].split("\x00")[0] if len(m.props)>1 else "?"
        print(f"  Model id={m.props[0]} name={nm!r} type={m.props[2] if len(m.props)>2 else '?'} T={T} R={R_} S={S} preR={preR}")
