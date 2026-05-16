#!/usr/bin/env python3
"""Analyze gltf/SimpleSkin.fbx structure."""
import struct, zlib, sys, io, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "SimpleSkin.fbx")

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

def get_props70(model_node):
    p70 = find_child(model_node, "Properties70")
    props = {"T": [0,0,0], "R": [0,0,0], "S": [1,1,1], "preR": [0,0,0], "rotOrder": 0}
    if not p70: return props
    for p in p70.children:
        if p.name != "P" or not p.props: continue
        key = p.props[0]
        if key == "Lcl Translation" and len(p.props) > 6:
            props["T"] = [float(p.props[4]), float(p.props[5]), float(p.props[6])]
        elif key == "Lcl Rotation" and len(p.props) > 6:
            props["R"] = [float(p.props[4]), float(p.props[5]), float(p.props[6])]
        elif key == "Lcl Scaling" and len(p.props) > 6:
            props["S"] = [float(p.props[4]), float(p.props[5]), float(p.props[6])]
        elif key == "PreRotation" and len(p.props) > 6:
            props["preR"] = [float(p.props[4]), float(p.props[5]), float(p.props[6])]
        elif key == "RotationOrder" and len(p.props) > 4:
            props["rotOrder"] = int(p.props[4]) if isinstance(p.props[4], (int,float)) else 0
    return props

roots = load(FBX_PATH)

print("=== Top-level nodes ===")
for n in roots:
    print(f"  {n.name}")

# GlobalSettings
gs = next((n for n in roots if n.name == "GlobalSettings"), None)
if gs:
    print("\n=== GlobalSettings ===")
    p70 = find_child(gs, "Properties70")
    if p70:
        for p in p70.children:
            if p.name == "P" and p.props:
                key = p.props[0]
                if key in ("UpAxis", "UpAxisSign", "FrontAxis", "FrontAxisSign", "CoordAxis", "CoordAxisSign",
                           "OriginalUpAxis", "OriginalUpAxisSign", "UnitScaleFactor"):
                    val = p.props[4] if len(p.props) > 4 else "?"
                    print(f"  {key}: {val}")

# All Models
print("\n=== All Models ===")
for n in iter_nodes(roots, "Model"):
    if not n.props: continue
    mid = n.props[0]
    name = n.props[1].split("\x00")[0] if len(n.props) > 1 else "?"
    mtype = n.props[2] if len(n.props) > 2 else "?"
    props = get_props70(n)
    print(f"  [{mid}] {name!r} type={mtype}")
    print(f"      T={props['T']}  R={props['R']}  S={props['S']}  preR={props['preR']}  rotOrder={props['rotOrder']}")

# All Geometries
print("\n=== All Geometries ===")
for n in iter_nodes(roots, "Geometry"):
    if not n.props: continue
    gid = n.props[0]
    name = n.props[1].split("\x00")[0] if len(n.props) > 1 else "?"
    gtype = n.props[2] if len(n.props) > 2 else "?"
    verts_n = find_child(n, "Vertices")
    vert_count = len(verts_n.props[0]) // 3 if verts_n and verts_n.props else 0
    print(f"  [{gid}] {name!r} type={gtype} vertices={vert_count}")
    if verts_n and verts_n.props:
        verts = verts_n.props[0]
        # Print first few vertices
        for i in range(min(8, vert_count)):
            print(f"    v[{i}] = ({verts[i*3]:.3f}, {verts[i*3+1]:.3f}, {verts[i*3+2]:.3f})")

# All Deformers
print("\n=== All Deformers (Skins/Clusters) ===")
for n in iter_nodes(roots, "Deformer"):
    if not n.props: continue
    did = n.props[0]
    name = n.props[1].split("\x00")[0] if len(n.props) > 1 else "?"
    dtype = n.props[2] if len(n.props) > 2 else "?"
    print(f"  [{did}] {name!r} type={dtype}")
    if "Cluster" in str(dtype) or "SubDeformer" in str(dtype):
        tl_n = find_child(n, "TransformLink")
        if tl_n and tl_n.props:
            tl = tl_n.props[0]
            # row-major from column-major
            m = [[tl[r+c*4] for c in range(4)] for r in range(4)]
            print(f"    TransformLink (row 0): {[f'{v:.4f}' for v in m[0]]}")
            print(f"    TransformLink (row 1): {[f'{v:.4f}' for v in m[1]]}")
            print(f"    TransformLink (row 2): {[f'{v:.4f}' for v in m[2]]}")
            print(f"    TransformLink (row 3): {[f'{v:.4f}' for v in m[3]]}")
        t_n = find_child(n, "Transform")
        if t_n and t_n.props:
            t = t_n.props[0]
            m = [[t[r+c*4] for c in range(4)] for r in range(4)]
            print(f"    Transform (row 0): {[f'{v:.4f}' for v in m[0]]}")
            print(f"    Transform (row 1): {[f'{v:.4f}' for v in m[1]]}")
            print(f"    Transform (row 2): {[f'{v:.4f}' for v in m[2]]}")
            print(f"    Transform (row 3): {[f'{v:.4f}' for v in m[3]]}")
        indices_n = find_child(n, "Indexes")
        weights_n = find_child(n, "Weights")
        if indices_n and weights_n and indices_n.props and weights_n.props:
            print(f"    Vertex count: {len(indices_n.props[0])}")
            print(f"    Indices: {indices_n.props[0]}")
            print(f"    Weights: {[round(w,4) for w in weights_n.props[0]]}")

# Animation stacks
print("\n=== Animation Stacks ===")
for n in iter_nodes(roots, "AnimationStack"):
    if not n.props: continue
    sid = n.props[0]
    name = n.props[1].split("\x00")[0] if len(n.props) > 1 else "?"
    print(f"  [{sid}] {name!r}")

# Connections
conns = next(n for n in roots if n.name == "Connections")
print(f"\n=== Connections ({len(conns.children)} total) ===")
for c in conns.children[:50]:
    if c.name != "C": continue
    ctype = c.props[0]
    f, t = c.props[1], c.props[2]
    prop = c.props[3] if len(c.props) > 3 else None
    print(f"  [{ctype}] {f} -> {t}" + (f" prop={prop!r}" if prop else ""))
