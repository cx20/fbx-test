#!/usr/bin/env python3
"""Check connection direction for arm_joint_L_1 cluster and identify bone model IDs."""
import struct, zlib, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

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

roots = load(FBX_PATH)
conns = next(n for n in roots if n.name=="Connections")

ARM_L1_ID = 270376567
CLUSTER_ID = 994562526

id_type = {}
for n in iter_nodes(roots):
    if n.props and isinstance(n.props[0], int):
        t = n.name
        if len(n.props) > 2 and isinstance(n.props[2], str):
            t += "/" + n.props[2]
        elif len(n.props) > 1 and isinstance(n.props[1], str):
            t += "/" + n.props[1].split(chr(0))[0][:20]
        id_type[n.props[0]] = t

print(f"ARM_L1_ID {ARM_L1_ID}: {id_type.get(ARM_L1_ID,'?')}")
print(f"CLUSTER_ID {CLUSTER_ID}: {id_type.get(CLUSTER_ID,'?')}")
print()

print("All OO connections involving ARM_L1 or CLUSTER:")
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        f, t = c.props[1], c.props[2]
        if ARM_L1_ID in (f,t) or CLUSTER_ID in (f,t):
            print(f"  OO: {f} ({id_type.get(f,'?')[:35]})  ->  {t} ({id_type.get(t,'?')[:35]})")

print()
deformer_subtypes = set()
for n in iter_nodes(roots, "Deformer"):
    if n.props and len(n.props)>2:
        deformer_subtypes.add(n.props[2])
print("Deformer subtypes found:", deformer_subtypes)

print()
# Now figure out the correct cluster->bone direction and which nodes are bones
# In FBX: bone Model -> cluster (OO)  OR cluster -> bone Model (OO)?
# Let's check both directions
cluster_ids = set()
for n in iter_nodes(roots, "Deformer"):
    if n.props and isinstance(n.props[0], int) and len(n.props)>2 and isinstance(n.props[2], str):
        if "Cluster" in n.props[2] or "SubDeformer" in n.props[2]:
            cluster_ids.add(n.props[0])

model_ids = set()
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        model_ids.add(n.props[0])

# Try direction: cluster -> model (bone)
bone_from_cluster_to_model = set()
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        f, t = c.props[1], c.props[2]
        if f in cluster_ids and t in model_ids:
            bone_from_cluster_to_model.add(t)

# Try direction: model (bone) -> cluster
bone_from_model_to_cluster = set()
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        f, t = c.props[1], c.props[2]
        if f in model_ids and t in cluster_ids:
            bone_from_model_to_cluster.add(f)

print(f"Bones found via cluster->model direction: {len(bone_from_cluster_to_model)}")
print(f"Bones found via model->cluster direction: {len(bone_from_model_to_cluster)}")
print(f"ARM_L1_ID in cluster->model bones: {ARM_L1_ID in bone_from_cluster_to_model}")
print(f"ARM_L1_ID in model->cluster bones: {ARM_L1_ID in bone_from_model_to_cluster}")
