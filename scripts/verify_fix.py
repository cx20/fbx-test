#!/usr/bin/env python3
"""Verify that invTL × prefix_bjs = chain_bind^-1 (correct inv_bind for BJS bone chain)."""
import struct, zlib, sys, io, math, numpy as np
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
    p70 = find_child(model_node, "Properties70")
    props = {"T": [0,0,0], "R": [0,0,0], "S": [1,1,1], "preR": [0,0,0]}
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
    return props

def rx(deg): r=math.radians(deg); c=math.cos(r); s=math.sin(r); return np.array([[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]])
def ry(deg): r=math.radians(deg); c=math.cos(r); s=math.sin(r); return np.array([[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]])
def rz(deg): r=math.radians(deg); c=math.cos(r); s=math.sin(r); return np.array([[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]])
def sc(s): return np.diag([s[0],s[1],s[2],1.0])
def tr(t): m=np.eye(4); m[:3,3]=t; return m

def fbx_local(props70):
    T, R, S, preR = props70["T"], props70["R"], props70["S"], props70["preR"]
    rot = rz(R[2]) @ ry(R[1]) @ rx(R[0])
    pre = rz(preR[2]) @ ry(preR[1]) @ rx(preR[0])
    return tr(T) @ pre @ rot @ sc(S)

def bjs_local(props70):
    """Convert FBX local matrix to BJS (negate z in pos, negate Rx/Ry angles)."""
    T, R, S, preR = props70["T"], props70["R"], props70["S"], props70["preR"]
    T_bjs = [T[0], T[1], -T[2]]
    # BJS: Rx(-rx), Ry(-ry), Rz(rz), XYZ order = Rz×Ry×Rx
    rot_bjs = rz(R[2]) @ ry(-R[1]) @ rx(-R[0])
    pre_bjs = rz(preR[2]) @ ry(-preR[1]) @ rx(-preR[0])
    return tr(T_bjs) @ pre_bjs @ rot_bjs @ sc(S)

def fbx_to_bjs(M):
    """Convert FBX matrix (column-major RH) to BJS: negate z-row and z-col."""
    # M is given as a row-major numpy matrix (FBX column-major transposed)
    R = M.copy()
    # Negate z-row (row 2) and z-col (col 2)
    R[2, :] = -R[2, :]
    R[:, 2] = -R[:, 2]
    return R

roots = load(FBX_PATH)
conns = next(n for n in roots if n.name=="Connections")

ARM_L1_ID = 270376567
CLUSTER_ID = 994562526
Z_UP_ID = 861850117
ARMATURE_ID = 145081345

# Get model by id
model_by_id = {}
name_by_id = {}
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        model_by_id[n.props[0]] = n
        nm = n.props[1].split("\x00")[0] if len(n.props)>1 else "?"
        name_by_id[n.props[0]] = nm

model_ids = set(model_by_id.keys())
node_to_parent = {}
for c in conns.children:
    if c.name=="C" and c.props[0]=="OO":
        child_id, parent_id = c.props[1], c.props[2]
        if child_id in model_ids and (parent_id in model_ids or parent_id==0):
            node_to_parent[child_id] = parent_id

# Get chain (torso_j1 → arm_j_l_1)
chain_ids = []
nid = ARM_L1_ID
while nid and nid != 0:
    if nid in model_by_id and name_by_id.get(nid) not in {"Z_UP", "Armature"}:
        chain_ids.append(nid)
    nid = node_to_parent.get(nid)
chain_ids.reverse()  # root first

print("=== Chain (bone-only, excl. Z_UP/Armature) ===")
print([name_by_id.get(id, id) for id in chain_ids])

# Compute Z_UP_bjs from BJS local matrix of Z_UP
z_up_node = model_by_id[Z_UP_ID]
z_up_props = get_props70(z_up_node)
z_up_bjs = bjs_local(z_up_props)
print(f"\nZ_UP BJS matrix (= prefix matrix):")
np.set_printoptions(precision=4, suppress=True)
print(z_up_bjs)

# Compute prefix_bjs = Z_UP_bjs × Armature_bjs (Armature is identity)
armature_props = get_props70(model_by_id[ARMATURE_ID])
armature_bjs = bjs_local(armature_props)
prefix_bjs = z_up_bjs @ armature_bjs
print(f"\nPrefix_bjs (Z_UP × Armature) = Z_UP_bjs:")
print(prefix_bjs)

# Compute chain_bind_bjs (Properties70 bind pose, bone-only, in BJS coords)
chain_bind_bjs = np.eye(4)
for mid in chain_ids:
    props = get_props70(model_by_id[mid])
    local_bjs = bjs_local(props)
    chain_bind_bjs = chain_bind_bjs @ local_bjs

print(f"\nChain_bind_bjs (Properties70, bone-only chain):")
print(chain_bind_bjs)

# Get TransformLink for arm_joint_L_1
tl_matrix = None
for n in iter_nodes(roots, "Deformer"):
    if n.props and n.props[0]==CLUSTER_ID:
        tl_n = find_child(n, "TransformLink")
        if tl_n and tl_n.props:
            tl_data = tl_n.props[0]
            # FBX column-major -> row-major (transpose)
            tl_fbx = np.array(tl_data).reshape(4,4,order="F")  # column-major = Fortran order
            tl_bjs = fbx_to_bjs(tl_fbx)
            tl_matrix = tl_bjs
        break

print(f"\nTransformLink (FBX) converted to BJS:")
print(tl_matrix)

# Compute invTL = bjs(TL)^-1
invTL = np.linalg.inv(tl_matrix)
print(f"\ninvTL = bjs(TL)^-1:")
print(invTL)

# Apply fix: correctedInvBind = invTL × prefix_bjs
corrected_inv_bind = invTL @ prefix_bjs
print(f"\ncorrectedInvBind = invTL × prefix_bjs:")
print(corrected_inv_bind)

# Expected: chain_bind_bjs^-1
chain_bind_inv = np.linalg.inv(chain_bind_bjs)
print(f"\nchain_bind_bjs^-1 (expected correctedInvBind if bind pose = Properties70):")
print(chain_bind_inv)

# Difference between correctedInvBind and chain_bind_bjs^-1
diff = np.max(np.abs(corrected_inv_bind - chain_bind_inv))
print(f"\nMax diff (correctedInvBind vs chain_bind_bjs^-1): {diff:.6f}")
print("(Should be small if TransformLink bind pose ≈ Properties70 bind pose)")
print("(Large diff = TransformLink and Properties70 encode different bind poses)")

# Also test: is correctedInvBind a valid rotation matrix (no scale artifacts)?
R_part = corrected_inv_bind[:3, :3]
print(f"\nColumn norms of correctedInvBind rotation part: {[float(np.linalg.norm(R_part[:,i])) for i in range(3)]}")
print("(All should be ≈1.0 for a proper inv_bind without scale artifacts)")

# Compare current (wrong) approach vs fixed approach
print(f"\n=== COMPARISON ===")
print("Current (Properties70 bind, NO-OP fix):")
print(f"  chain_bind_bjs^-1 column norms: {[float(np.linalg.norm(chain_bind_inv[:3,i])) for i in range(3)]}")
print("Fixed (TransformLink, Z_UP corrected):")
print(f"  correctedInvBind column norms: {[float(np.linalg.norm(corrected_inv_bind[:3,i])) for i in range(3)]}")

# The key difference: rotation part
import scipy.spatial.transform as st
def mat_to_euler(M3):
    try:
        r = st.Rotation.from_matrix(M3)
        return r.as_euler('xyz', degrees=True)
    except:
        return None

# Current inv_bind rotation
R_current = chain_bind_inv[:3, :3]
e_current = mat_to_euler(R_current.T)  # transpose because inv_bind contains transposed rotation

# Fixed inv_bind rotation
R_fixed = corrected_inv_bind[:3, :3]
e_fixed = mat_to_euler(R_fixed.T)

if e_current is not None and e_fixed is not None:
    print(f"\nBind pose rotation (current, Properties70): XYZ = {[round(v,2) for v in e_current]}")
    print(f"Bind pose rotation (fixed, TransformLink): XYZ = {[round(v,2) for v in e_fixed]}")
    diff_euler = np.abs(e_fixed - e_current)
    print(f"Difference in bind pose rotation: {[round(v,2) for v in diff_euler]} deg")
