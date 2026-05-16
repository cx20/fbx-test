#!/usr/bin/env python3
"""Inspect materials and textures of an FBX (Head_69 troubleshooting)."""
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

print(f"=== {os.path.basename(path)} ===\n")

print("--- Materials ---")
for m in iter_nodes(roots, "Material"):
    if not m.props: continue
    mid = m.props[0]
    name = m.props[1] if len(m.props) > 1 else '?'
    print(f"  id={mid} name={name!r}")
    p70 = find_child(m, "Properties70")
    if p70:
        for p in p70.children:
            if p.name != "P" or not p.props: continue
            k = p.props[0]
            if k in ("DiffuseColor", "Diffuse", "AmbientColor", "EmissiveColor",
                     "SpecularColor", "DiffuseFactor"):
                if len(p.props) > 6:
                    print(f"    {k}: ({p.props[4]:.3f}, {p.props[5]:.3f}, {p.props[6]:.3f})")
                elif len(p.props) > 4:
                    print(f"    {k}: {p.props[4]}")

print("\n--- Textures ---")
for t in iter_nodes(roots, "Texture"):
    if not t.props: continue
    tid = t.props[0]
    name = t.props[1] if len(t.props) > 1 else '?'
    print(f"  id={tid} name={name!r}")
    for child in t.children:
        if child.name in ("FileName", "RelativeFilename", "Media") and child.props:
            print(f"    {child.name}: {child.props[0]!r}")

print("\n--- Videos ---")
for v in iter_nodes(roots, "Video"):
    if not v.props: continue
    vid = v.props[0]
    name = v.props[1] if len(v.props) > 1 else '?'
    print(f"  id={vid} name={name!r}")
    for child in v.children:
        if child.name in ("FileName", "RelativeFilename", "Filename") and child.props:
            print(f"    {child.name}: {child.props[0]!r}")
        elif child.name == "Content":
            sz = len(child.props[0]) if child.props else 0
            print(f"    Content: {sz} bytes")

# Connections per mesh model
print("\n--- Model -> Material mapping ---")
model_to_mat = {}
mat_to_tex = {}
tex_to_vid = {}
mats = {m.props[0]: m for m in iter_nodes(roots, "Material") if m.props}
texs = {t.props[0]: t for t in iter_nodes(roots, "Texture") if t.props}
vids = {v.props[0]: v for v in iter_nodes(roots, "Video") if v.props}
models = {m.props[0]: m for m in iter_nodes(roots, "Model") if m.props}

for n in roots:
    if n.name != "Connections": continue
    for c in n.children:
        if c.name != "C" or c.props[0] != "OO": continue
        fromId = c.props[1]; toId = c.props[2]
        if fromId in mats and toId in models:
            model_to_mat.setdefault(toId, []).append(fromId)
        elif fromId in texs and toId in mats:
            mat_to_tex.setdefault(toId, []).append(fromId)
        elif fromId in vids and toId in texs:
            tex_to_vid.setdefault(toId, []).append(fromId)
    break

for mid, mat_ids in model_to_mat.items():
    mname = models[mid].props[1] if len(models[mid].props) > 1 else '?'
    mtype = models[mid].props[2] if len(models[mid].props) > 2 else '?'
    if mtype != 'Mesh': continue
    print(f"  Model {mid} {mname!r}:")
    for mat_id in mat_ids:
        mat_name = mats[mat_id].props[1] if len(mats[mat_id].props) > 1 else '?'
        print(f"    Material {mat_id} {mat_name!r}")
        for tex_id in mat_to_tex.get(mat_id, []):
            tex_name = texs[tex_id].props[1] if len(texs[tex_id].props) > 1 else '?'
            print(f"      Texture {tex_id} {tex_name!r}")
            for vid_id in tex_to_vid.get(tex_id, []):
                vid_name = vids[vid_id].props[1] if len(vids[vid_id].props) > 1 else '?'
                fn = find_child(vids[vid_id], 'RelativeFilename')
                fn_val = fn.props[0] if fn and fn.props else None
                print(f"        Video {vid_id} {vid_name!r}: {fn_val!r}")
