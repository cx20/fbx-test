#!/usr/bin/env python3
"""Compare LclR hierarchy world matrix at t=0 vs TransformLink for arm_joint_L_1."""
import struct, zlib, sys, io, numpy as np, math
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

def iter_nodes(nodes,name=None):
    for n in nodes:
        if name is None or n.name==name: yield n
        yield from iter_nodes(n.children,name)

FBX_TIME = 1/46186158000
roots = load(FBX_PATH)
ARM_L1_ID = 270376567

# Build parent map (Model-to-Model only)
conns = next((n for n in roots if n.name=="Connections"), None)
model_ids = set()
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        model_ids.add(n.props[0])

node_to_parent = {}
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        child_id, parent_id = c.props[1], c.props[2]
        if child_id in model_ids and (parent_id in model_ids or parent_id == 0):
            node_to_parent[child_id] = parent_id

# Build id->model map and id->name map
model_by_id = {}
name_by_id = {}
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        model_by_id[n.props[0]] = n
        nm = n.props[1].split("\x00")[0] if len(n.props)>1 and isinstance(n.props[1],str) else "?"
        name_by_id[n.props[0]] = nm

# Build animation curve values at t=0 for all nodes
# OP connections: ACN -> model
acn_to_model = {}
for c in conns.children:
    if c.name=="C" and c.props[0]=="OP":
        acn_to_model[c.props[1]] = (c.props[2], c.props[3])

# Find curves and get t=0 values
acn_by_id = {}
for n in iter_nodes(roots, "AnimationCurveNode"):
    if n.props: acn_by_id[n.props[0]] = n

curve_val_at_t0 = {}  # curve_id -> first key value
for n in iter_nodes(roots, "AnimationCurve"):
    if n.props:
        vals_n = next((cc for cc in n.children if cc.name=="KeyValueFloat"), None)
        if vals_n and vals_n.props:
            curve_val_at_t0[n.props[0]] = vals_n.props[0][0]

# Map curve to ACN
curve_to_acn_axis = {}  # curve_id -> (acn_id, axis)
for c in conns.children:
    if c.name=="C" and c.props[0]=="OP":
        fid, tid = c.props[1], c.props[2]
        prop = c.props[3] if len(c.props)>3 else None
        if tid in acn_by_id:
            axis = 0 if prop=="d|X" else (1 if prop=="d|Y" else (2 if prop=="d|Z" else -1))
            if axis>=0 and fid in curve_val_at_t0:
                curve_to_acn_axis[fid] = (tid, axis)

# Collect t=0 values per ACN
acn_vals_t0 = {}  # acn_id -> [x,y,z]
for curve_id, (acn_id, axis) in curve_to_acn_axis.items():
    if acn_id not in acn_vals_t0: acn_vals_t0[acn_id] = [None,None,None]
    acn_vals_t0[acn_id][axis] = curve_val_at_t0[curve_id]

# Map to model+prop
model_curves_t0 = {}  # model_id -> {prop -> [x,y,z]}
for acn_id, vals in acn_vals_t0.items():
    if acn_id not in acn_to_model: continue
    model_id, prop = acn_to_model[acn_id]
    if model_id not in model_curves_t0: model_curves_t0[model_id] = {}
    if prop not in model_curves_t0[model_id]:
        model_curves_t0[model_id][prop] = [None,None,None]
    for i,v in enumerate(vals):
        if v is not None:
            model_curves_t0[model_id][prop][i] = v

# Get ancestor chain for arm_joint_L_1
chain = []
nid = ARM_L1_ID
while nid and nid != 0:
    if nid in model_by_id:
        chain.append(nid)
    nid = node_to_parent.get(nid)
chain.reverse()

print("Ancestor chain (root -> arm_joint_L_1) at t=0:")
for mid in chain:
    curves = model_curves_t0.get(mid, {})
    r_curve = curves.get("Lcl Rotation", [None,None,None])
    t_curve = curves.get("Lcl Translation", [None,None,None])
    s_curve = curves.get("Lcl Scaling", [None,None,None])
    print(f"  {name_by_id.get(mid,mid)}: T={[round(v,3) if v else 0 for v in t_curve]}  R={[round(v,3) if v else 0 for v in r_curve]}  S={[round(v,2) if v else 1 for v in s_curve]}")

# Compute world matrix from chain at t=0 (FBX RH, column-vector convention)
def rx_m(deg):
    r=math.radians(deg); c=math.cos(r); s=math.sin(r)
    return np.array([[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]], dtype=float)
def ry_m(deg):
    r=math.radians(deg); c=math.cos(r); s=math.sin(r)
    return np.array([[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]], dtype=float)
def rz_m(deg):
    r=math.radians(deg); c=math.cos(r); s=math.sin(r)
    return np.array([[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]], dtype=float)
def scale_m(sx,sy,sz):
    return np.diag([sx,sy,sz,1.0])
def trans_m(tx,ty,tz):
    m=np.eye(4); m[:3,3]=[tx,ty,tz]; return m

world = np.eye(4)
for mid in chain:
    curves = model_curves_t0.get(mid, {})
    T = curves.get("Lcl Translation", [0,0,0]); T = [v or 0 for v in T]
    R = curves.get("Lcl Rotation", [0,0,0]);    R = [v or 0 for v in R]
    S = curves.get("Lcl Scaling", [1,1,1]);      S = [v or 1 for v in S]
    # FBX XYZ order: R = Rz @ Ry @ Rx (column-vector, rightmost applied first)
    local = trans_m(*T) @ rz_m(R[2]) @ ry_m(R[1]) @ rx_m(R[0]) @ scale_m(*S)
    world = world @ local  # parent @ child = parent * child (column-vector convention)

print()
print("World matrix from LclR hierarchy at t=0 (FBX RH):")
print("  (rows of world matrix):")
for row in range(4):
    print(f"  row{row}:", [round(world[row,col],3) for col in range(4)])

# TransformLink for arm_joint_L_1
CLUSTER_ID = 994562526
for n in iter_nodes(roots, "Deformer"):
    if n.props and n.props[0]==CLUSTER_ID:
        tl_n = next((cc for cc in n.children if cc.name=="TransformLink"), None)
        if tl_n and tl_n.props:
            tl = np.array(tl_n.props[0]).reshape(4,4,order="F")
            print()
            print("TransformLink (FBX RH):")
            print("  (rows of TL matrix):")
            for row in range(4):
                print(f"  row{row}:", [round(tl[row,col],3) for col in range(4)])
            diff = np.max(np.abs(world - tl))
            print(f"\nMax diff hierarchy vs TransformLink: {diff:.4f}")
        break
