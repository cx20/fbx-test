#!/usr/bin/env python3
"""Compare Properties70 world matrix (full chain including Z_UP) vs TransformLink for arm_joint_L_1."""
import struct, zlib, sys, io, math
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

def find_child(node, name):
    return next((c for c in node.children if c.name==name), None)

def get_props70(model_node):
    """Return dict of Properties70 values for a Model node.
    P node format: [name, type, label, flags, val0, val1, val2] (7 elements for 3D types).
    """
    p70 = find_child(model_node, "Properties70")
    props = {"T": [0,0,0], "R": [0,0,0], "S": [1,1,1], "preR": [0,0,0], "rotOrder": 0}
    if not p70: return props
    for p in p70.children:
        if p.name != "P" or not p.props: continue
        key = p.props[0]
        # 3D values: [name, type, label, flags, x, y, z] → indices 4,5,6
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

# Matrix math (4x4, row-major)
def mat_mul(A, B):
    return [[sum(A[r][k]*B[k][c] for k in range(4)) for c in range(4)] for r in range(4)]

def mat_eye():
    return [[1 if r==c else 0 for c in range(4)] for r in range(4)]

def mat_trans(tx,ty,tz):
    m = mat_eye(); m[0][3]=tx; m[1][3]=ty; m[2][3]=tz; return m

def mat_scale(sx,sy,sz):
    m = mat_eye(); m[0][0]=sx; m[1][1]=sy; m[2][2]=sz; return m

def mat_rx(deg):
    r=math.radians(deg); c=math.cos(r); s=math.sin(r)
    return [[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]]

def mat_ry(deg):
    r=math.radians(deg); c=math.cos(r); s=math.sin(r)
    return [[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]]

def mat_rz(deg):
    r=math.radians(deg); c=math.cos(r); s=math.sin(r)
    return [[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]]

def fbx_local_matrix(props70):
    T, R, S = props70["T"], props70["R"], props70["S"]
    preR = props70["preR"]
    # FBX XYZ order for both preR and R
    rot = mat_mul(mat_rz(R[2]), mat_mul(mat_ry(R[1]), mat_rx(R[0])))
    pre = mat_mul(mat_rz(preR[2]), mat_mul(mat_ry(preR[1]), mat_rx(preR[0])))
    # local = T × preR × R × S
    return mat_mul(mat_trans(*T), mat_mul(pre, mat_mul(rot, mat_scale(*S))))

def mat_str(m):
    return [f"[{', '.join(f'{v:.4f}' for v in row)}]" for row in m]

roots = load(FBX_PATH)
conns = next(n for n in roots if n.name=="Connections")

ARM_L1_ID = 270376567
CLUSTER_ID = 994562526

# Build model maps
model_by_id = {}
name_by_id = {}
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        model_by_id[n.props[0]] = n
        nm = n.props[1].split("\x00")[0] if len(n.props)>1 else "?"
        name_by_id[n.props[0]] = nm

# Build parent map (Model-to-Model only)
model_ids = set(model_by_id.keys())
node_to_parent = {}
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        child_id, parent_id = c.props[1], c.props[2]
        if child_id in model_ids and (parent_id in model_ids or parent_id==0):
            node_to_parent[child_id] = parent_id

# Get ancestor chain for arm_joint_L_1
chain = []
nid = ARM_L1_ID
while nid and nid != 0:
    if nid in model_by_id:
        chain.append(nid)
    nid = node_to_parent.get(nid)
chain.reverse()

print("=== Ancestor chain Properties70 ===")
for mid in chain:
    node = model_by_id[mid]
    p = get_props70(node)
    nm = name_by_id[mid]
    print(f"  {nm} ({mid}):")
    print(f"    T={[round(v,4) for v in p['T']]}  R={[round(v,4) for v in p['R']]}  S={[round(v,4) for v in p['S']]}  preR={[round(v,4) for v in p['preR']]}  rotOrder={p['rotOrder']}")

# Compute world matrix from full Properties70 chain (including Z_UP)
world = mat_eye()
for mid in chain:
    node = model_by_id[mid]
    p = get_props70(node)
    local = fbx_local_matrix(p)
    world = mat_mul(world, local)

print("\n=== World matrix from Properties70 chain (FBX RH, including Z_UP) ===")
for row in world:
    print(f"  [{', '.join(f'{v:.4f}' for v in row)}]")

# Also compute WITHOUT Z_UP (just the bone chain: torso_j1 → arm_j_l_1)
bone_ids = [mid for mid in chain if mid != chain[0] and name_by_id.get(mid,"") != "Z_UP" and name_by_id.get(mid,"") != "Armature"]
# Actually skip Z_UP and Armature specifically
skip_names = {"Z_UP", "Armature"}
bone_chain = [mid for mid in chain if name_by_id.get(mid,"") not in skip_names]

world_no_zup = mat_eye()
for mid in bone_chain:
    node = model_by_id[mid]
    p = get_props70(node)
    local = fbx_local_matrix(p)
    world_no_zup = mat_mul(world_no_zup, local)

print(f"\n=== World matrix WITHOUT Z_UP/Armature (bone chain only) ===")
print(f"  Bone chain: {[name_by_id.get(mid,mid) for mid in bone_chain]}")
for row in world_no_zup:
    print(f"  [{', '.join(f'{v:.4f}' for v in row)}]")

# TransformLink for arm_joint_L_1
print(f"\n=== TransformLink for arm_joint_L_1 (cluster {CLUSTER_ID}) ===")
for n in iter_nodes(roots, "Deformer"):
    if n.props and n.props[0]==CLUSTER_ID:
        tl_n = find_child(n, "TransformLink")
        if tl_n and tl_n.props:
            tl = tl_n.props[0]
            # Column-major -> row-major (transpose)
            m = [[tl[r+c*4] for c in range(4)] for r in range(4)]
            for row in m:
                print(f"  [{', '.join(f'{v:.4f}' for v in row)}]")

            # Compute max diff vs full Properties70 chain
            diff1 = max(abs(world[r][c] - m[r][c]) for r in range(4) for c in range(4))
            diff2 = max(abs(world_no_zup[r][c] - m[r][c]) for r in range(4) for c in range(4))
            print(f"\nMax diff (Properties70 full chain vs TransformLink): {diff1:.6f}")
            print(f"Max diff (Properties70 bone-only chain vs TransformLink): {diff2:.6f}")
        break
