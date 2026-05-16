#!/usr/bin/env python3
"""Check if torso_joint_1/2/3 have animation channels in Armature|Anim_0.002 and cluster connections."""
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

# Build model name->id and id->name maps
model_name_to_ids = {}
name_by_id = {}
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        mid = n.props[0]
        nm = n.props[1].split("\x00")[0] if len(n.props)>1 and isinstance(n.props[1],str) else "?"
        model_name_to_ids.setdefault(nm, []).append(mid)
        name_by_id[mid] = nm

# Find torso joints and arm joints
JOINTS_OF_INTEREST = [
    "torso_joint_1", "torso_joint_2", "torso_joint_3",
    "arm_joint_L_1", "Armature"
]
print("=== Joint IDs ===")
for jname in JOINTS_OF_INTEREST:
    ids = model_name_to_ids.get(jname, [])
    print(f"  {jname}: {ids}")

# Get all cluster IDs (Deformer/Cluster)
cluster_ids = set()
for n in iter_nodes(roots, "Deformer"):
    if n.props and isinstance(n.props[0], int) and len(n.props)>2:
        if "Cluster" in str(n.props[2]):
            cluster_ids.add(n.props[0])

# Find which models have cluster connections (are "skinned bones")
model_ids = set(name_by_id.keys())
skinned_bone_ids = set()
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        f, t = c.props[1], c.props[2]
        if f in model_ids and t in cluster_ids:
            skinned_bone_ids.add(f)

print(f"\n=== Skinned bones (model->cluster) ===")
for mid in sorted(skinned_bone_ids, key=lambda x: name_by_id.get(x,"")):
    print(f"  {name_by_id.get(mid,mid)} ({mid})")

# Check if torso/arm joints are skinned
print(f"\n=== Are torso/arm joints skinned? ===")
for jname in JOINTS_OF_INTEREST:
    ids = model_name_to_ids.get(jname, [])
    for mid in ids:
        is_skinned = mid in skinned_bone_ids
        print(f"  {jname} ({mid}): skinned={is_skinned}")

# Find AnimationStack Armature|Anim_0.002
target_stack = None
for n in iter_nodes(roots, "AnimationStack"):
    name = n.props[1].split("\x00")[0] if len(n.props)>1 else ""
    if "Anim_0.002" in name:
        target_stack = n
        break

if not target_stack:
    print("\nAnimationStack not found!")
    sys.exit(1)

stack_id = target_stack.props[0]
print(f"\n=== Animation stack: id={stack_id} ===")

# Build animation structure
acn_by_id = {}
for n in iter_nodes(roots, "AnimationCurveNode"):
    if n.props: acn_by_id[n.props[0]] = n

layer_by_id = {}
for n in iter_nodes(roots, "AnimationLayer"):
    if n.props: layer_by_id[n.props[0]] = n

layers_for_stack = []
acns_for_layer = {}
acn_target = {}  # acn_id -> (model_id, prop_name)

for c in conns.children:
    if c.name != "C": continue
    ctype, f, t = c.props[0], c.props[1], c.props[2]
    prop = c.props[3] if len(c.props)>3 else None
    if ctype == "OO" and t == stack_id and f in layer_by_id:
        layers_for_stack.append(f)
    if ctype == "OO" and f in acn_by_id and t in layer_by_id:
        acns_for_layer.setdefault(t, []).append(f)
    if ctype == "OP" and f in acn_by_id:
        acn_target[f] = (t, prop)

print(f"  Layers: {layers_for_stack}")

# Collect ALL model IDs that have animation in this stack
animated_model_props = {}  # model_id -> set of props
for layer_id in layers_for_stack:
    for acn_id in acns_for_layer.get(layer_id, []):
        model_id, prop = acn_target.get(acn_id, (None, None))
        if model_id is not None:
            animated_model_props.setdefault(model_id, set()).add(prop)

print(f"\n=== All animated models in Anim_0.002 ===")
for mid in sorted(animated_model_props.keys(), key=lambda x: name_by_id.get(x,str(x))):
    props = animated_model_props[mid]
    nm = name_by_id.get(mid, str(mid))
    print(f"  {nm} ({mid}): {sorted(props)}")

print(f"\n=== Torso/arm joint animation coverage ===")
for jname in JOINTS_OF_INTEREST:
    ids = model_name_to_ids.get(jname, [])
    for mid in ids:
        props = animated_model_props.get(mid, set())
        is_skinned = mid in skinned_bone_ids
        print(f"  {jname} ({mid}): animated_props={sorted(props)}, skinned={is_skinned}")
