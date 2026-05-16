#!/usr/bin/env python3
"""
Compare hierarchy-computed BJS bind matrix vs TransformLink for arm_joint_L_1.

Replicates exactly what fbx-loader.js does:
  - makeBabylonLocalMatrixFromTransform: T[z]=-z, fbxEulerToQuat with Z-negate
  - Matrix accumulation: child.absolute = child.local * parent.absolute  (row-vector)
  - fbxTransformLinkToBabylon: read column-major FBX as row-major BJS, then Z-negate

Then compares against the TransformLink matrix from the cluster.
"""
import struct, zlib, sys, io, math
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

# ─── FBX binary parser (minimal) ──────────────────────────────────────────────
class R:
    def __init__(self, path):
        with open(path,"rb") as f: self.data=f.read()
        self.pos=27; self.version=struct.unpack_from("<I",self.data,23)[0]; self.is64=self.version>=7500
    def u8(self):  v=struct.unpack_from("B",self.data,self.pos)[0]; self.pos+=1; return v
    def u32(self): v=struct.unpack_from("<I",self.data,self.pos)[0]; self.pos+=4; return v
    def u64(self): v=struct.unpack_from("<Q",self.data,self.pos)[0]; self.pos+=8; return v
    def i16(self): v=struct.unpack_from("<h",self.data,self.pos)[0]; self.pos+=2; return v
    def i32(self): v=struct.unpack_from("<i",self.data,self.pos)[0]; self.pos+=4; return v
    def i64(self): v=struct.unpack_from("<q",self.data,self.pos)[0]; self.pos+=8; return v
    def f32(self): v=struct.unpack_from("<f",self.data,self.pos)[0]; self.pos+=4; return v
    def f64(self): v=struct.unpack_from("<d",self.data,self.pos)[0]; self.pos+=8; return v
    def off(self): return self.u64() if self.is64 else self.u32()
    def arr(self,fmt,sz):
        c=self.u32(); e=self.u32(); cl=self.u32()
        if e==1: raw=zlib.decompress(self.data[self.pos:self.pos+cl]); self.pos+=cl
        else: raw=self.data[self.pos:self.pos+c*sz]; self.pos+=c*sz
        return list(struct.unpack_from(f"<{c}{fmt}",raw))
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
            fmts={"f":"f","d":"d","i":"i","l":"q","b":"B","c":"B"}
            szs={"f":4,"d":8,"i":4,"l":8,"b":1,"c":1}
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
    for c in node.children:
        if c.name == name: return c
    return None

# ─── Props70 parser (matches fbx-loader.js parseProps70) ──────────────────────
def parse_props70(node):
    """Returns dict: key -> scalar or list, matching fbx-loader.js behavior."""
    result = {}
    if not node: return result
    for p in node.children:
        if p.name != "P" or len(p.props) < 5: continue
        key = p.props[0]
        if len(p.props) == 5:
            result[key] = p.props[4]
        else:
            result[key] = p.props[4:]  # list of values
    return result

def node_display_name(n):
    raw = n.props[1] if len(n.props) > 1 else "?"
    return raw.split("\x00")[0] if "\x00" in raw else raw

# ─── BJS math replicas ────────────────────────────────────────────────────────
def quat_from_axis_angle(axis, angle_rad):
    """axis: (x,y,z) normalized; returns (x,y,z,w)."""
    s = math.sin(angle_rad / 2)
    c = math.cos(angle_rad / 2)
    return (axis[0]*s, axis[1]*s, axis[2]*s, c)

def quat_multiply(a, b):
    """Hamilton product a*b (BJS A.multiply(B) applies B first, then A)."""
    ax,ay,az,aw = a
    bx,by,bz,bw = b
    return (
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw,
        aw*bw - ax*bx - ay*by - az*bz,
    )

def fbx_euler_to_quat(deg, rot_order=0):
    """Replica of fbxEulerToQuat in fbx-loader.js."""
    rx = math.radians(deg[0])
    ry = math.radians(deg[1])
    rz = math.radians(deg[2])
    Rx = quat_from_axis_angle((1,0,0), -rx)   # negate for LH
    Ry = quat_from_axis_angle((0,1,0), -ry)   # negate for LH
    Rz = quat_from_axis_angle((0,0,1),  rz)   # keep for LH
    if   rot_order == 1: return quat_multiply(quat_multiply(Ry,Rz),Rx)  # XZY
    elif rot_order == 2: return quat_multiply(quat_multiply(Rx,Rz),Ry)  # YZX
    elif rot_order == 3: return quat_multiply(quat_multiply(Rz,Rx),Ry)  # YXZ
    elif rot_order == 4: return quat_multiply(quat_multiply(Ry,Rx),Rz)  # ZXY
    elif rot_order == 5: return quat_multiply(quat_multiply(Rx,Ry),Rz)  # ZYX
    else:                return quat_multiply(quat_multiply(Rz,Ry),Rx)  # XYZ (0)

def quat_to_matrix(q):
    """4x4 rotation matrix (row-major) from quaternion (x,y,z,w)."""
    x,y,z,w = q
    m = np.eye(4)
    m[0,0] = 1 - 2*(y*y+z*z); m[0,1] = 2*(x*y+w*z);   m[0,2] = 2*(x*z-w*y)
    m[1,0] = 2*(x*y-w*z);     m[1,1] = 1 - 2*(x*x+z*z); m[1,2] = 2*(y*z+w*x)
    m[2,0] = 2*(x*z+w*y);     m[2,1] = 2*(y*z-w*x);   m[2,2] = 1 - 2*(x*x+y*y)
    return m

def make_bjs_local_matrix(T, R, S, preR, rot_order=0):
    """Replica of makeBabylonLocalMatrixFromTransform."""
    pos = np.array([T[0], T[1], -T[2]])
    rotation = quat_multiply(fbx_euler_to_quat(preR, 0), fbx_euler_to_quat(R, rot_order))
    rot_mat = quat_to_matrix(rotation)
    # BJS Matrix.Compose(scaling, rotation, position):
    # row-major: result[row] = scaling[row] * rot[row], then set translation row
    m = np.eye(4)
    m[0,:3] = S[0] * rot_mat[0,:3]
    m[1,:3] = S[1] * rot_mat[1,:3]
    m[2,:3] = S[2] * rot_mat[2,:3]
    m[3,:3] = pos
    return m

def fbx_tl_to_babylon(tl):
    """Replica of fbxTransformLinkToBabylon: read FBX col-major as BJS row-major, then Z-negate."""
    m = np.array(tl, dtype=float).reshape(4,4)
    # Negate Z cross-terms: elements where exactly one of (row==2, col==2) is true
    # In the flat array (row-major): index i -> row=i//4, col=i%4
    # m[2]→flat[2], m[6]→flat[6], m[8]→flat[8], m[9]→flat[9], m[11]→flat[11], m[14]→flat[14]
    # In 2D (row,col): (0,2),(1,2),(2,0),(2,1),(2,3),(3,2)
    m[0,2] = -m[0,2]
    m[1,2] = -m[1,2]
    m[2,0] = -m[2,0]
    m[2,1] = -m[2,1]
    m[2,3] = -m[2,3]
    m[3,2] = -m[3,2]
    return m

def get_model_transform_dict(model_node):
    """Replica of getModelTransform, returns dict with T, R, S, preR, rotOrder."""
    p70_node = find_child(model_node, "Properties70")
    p70 = parse_props70(p70_node)
    def v3(key, default): return list(p70.get(key, default))
    T = v3("Lcl Translation", [0.0, 0.0, 0.0])
    R = v3("Lcl Rotation",    [0.0, 0.0, 0.0])
    S = v3("Lcl Scaling",     [1.0, 1.0, 1.0])
    preR = v3("PreRotation",  [0.0, 0.0, 0.0])
    ro = p70.get("RotationOrder", 0)
    rot_order = ro[0] if isinstance(ro, list) else ro
    return {"T": T, "R": R, "S": S, "preR": preR, "rotOrder": rot_order}

def fmt_mat(m, label):
    print(f"\n{label}:")
    for row in range(4):
        vals = "  ".join(f"{m[row,col]:10.5f}" for col in range(4))
        print(f"  [{vals}]")

# ─── Main ─────────────────────────────────────────────────────────────────────
roots = load(FBX_PATH)
print("FBX loaded")

# Index all Model nodes
all_model_by_id = {}
for n in iter_nodes(roots, "Model"):
    oid = n.props[0] if n.props else None
    if oid is not None: all_model_by_id[oid] = n

# Build OO connections (first OO per node → parent, matching fbx-loader.js)
conns = next((n for n in roots if n.name=="Connections"), None)
node_to_parent = {}
all_oo = []
if conns:
    for c in conns.children:
        if c.name=="C" and len(c.props)>=3 and c.props[0]=="OO":
            from_id, to_id = c.props[1], c.props[2]
            all_oo.append((from_id, to_id))
            # Match fbx-loader.js: only first OO from each model node
            if from_id not in node_to_parent and from_id in all_model_by_id:
                node_to_parent[from_id] = to_id

# Find cluster for arm_joint_L_1 (270376567)
TARGET_BONE_ID = 270376567

cluster_by_id = {}
for n in iter_nodes(roots, "Deformer"):
    oid = n.props[0] if n.props else None
    if oid is not None: cluster_by_id[oid] = n  # keep all deformers

# Match fbx-loader.js line 751:
# if (allModelById.has(c.from) && clusterById.has(c.to)) clusterToBoneModel.set(c.to, c.from)
# → OO: from=bone_model_id, to=cluster_id
cluster_to_bone_model = {}  # cluster_id → bone_model_id
if conns:
    for c in conns.children:
        if c.name=="C" and len(c.props)>=3 and c.props[0]=="OO":
            from_id, to_id = c.props[1], c.props[2]
            if from_id in all_model_by_id and to_id in cluster_by_id:
                cluster_to_bone_model[to_id] = from_id

# Invert to get bone_model_id → cluster_id
cluster_by_bone_model_id = {v: k for k, v in cluster_to_bone_model.items()}

# arm_joint_L_1 parent chain
print(f"\n=== arm_joint_L_1 parent chain (ID={TARGET_BONE_ID}) ===")
chain = []
cur = TARGET_BONE_ID
while True:
    m = all_model_by_id.get(cur)
    name = node_display_name(m) if m else f"(non-model {cur})"
    mtype = m.props[2] if m and len(m.props)>2 else "?"
    chain.append(cur)
    print(f"  {cur}: {name!r} ({mtype})")
    parent = node_to_parent.get(cur)
    if not parent or parent == 0: break
    cur = parent

# Compute hierarchy BJS absolute bind matrix for arm_joint_L_1
print(f"\n=== Computing hierarchy BJS absolute bind matrix ===")
# Process chain from root to target
chain_root_first = list(reversed(chain))
abs_mat = np.eye(4)
for bone_id in chain_root_first:
    m = all_model_by_id.get(bone_id)
    if not m:
        print(f"  {bone_id}: no Model node, skipping")
        continue
    tf = get_model_transform_dict(m)
    local_mat = make_bjs_local_matrix(tf["T"], tf["R"], tf["S"], tf["preR"], tf["rotOrder"])
    # BJS row-vector convention: absolute = local * parentAbsolute
    abs_mat = local_mat @ abs_mat
    name = node_display_name(m)
    print(f"  Applied {name!r}: T={tf['T']}, R={tf['R']}, S={tf['S']}")

fmt_mat(abs_mat, "Hierarchy-computed absolute bind matrix (BJS space)")
print(f"  Translation row: X={abs_mat[3,0]:.5f}  Y={abs_mat[3,1]:.5f}  Z={abs_mat[3,2]:.5f}")

# Compute inverse
abs_inv = np.linalg.inv(abs_mat)
fmt_mat(abs_inv, "Hierarchy-computed INVERSE bind matrix (used by GPU skinning)")

# Read TransformLink for arm_joint_L_1
print(f"\n=== TransformLink from cluster ===")
cluster_id = cluster_by_bone_model_id.get(TARGET_BONE_ID)

print(f"  cluster_id = {cluster_id}")
if cluster_id is not None:
    cluster_node = cluster_by_id[cluster_id]
    tl_node = find_child(cluster_node, "TransformLink")
    tl_data = tl_node.props[0] if tl_node and tl_node.props else None
    if tl_data and len(tl_data) == 16:
        print(f"  TransformLink raw (FBX col-major, 16 floats):")
        m4 = np.array(tl_data).reshape(4,4)
        for row in range(4):
            vals = "  ".join(f"{m4[row,col]:10.5f}" for col in range(4))
            print(f"    [{vals}]")
        tl_bjs = fbx_tl_to_babylon(tl_data)
        fmt_mat(tl_bjs, "TransformLink converted to BJS space")
        print(f"  Translation row: X={tl_bjs[3,0]:.5f}  Y={tl_bjs[3,1]:.5f}  Z={tl_bjs[3,2]:.5f}")
        tl_inv = np.linalg.inv(tl_bjs)
        fmt_mat(tl_inv, "TransformLink INVERSE (what should be used for GPU skinning)")

        # Difference
        diff = abs_inv - tl_inv
        max_diff = np.max(np.abs(diff))
        print(f"\n=== Difference: hierarchy_inverse vs TransformLink_inverse ===")
        print(f"  Max absolute difference: {max_diff:.6f}")
        if max_diff < 0.001:
            print("  ✓ Matrices match! Bind pose discrepancy is NOT the cause.")
        else:
            print("  ✗ MISMATCH! This is the cause of wrong skinning.")
            fmt_mat(diff, "Difference matrix")

        # Also show: what ratio accounts for the difference (scale factor from Z_UP?)
        print(f"\n=== Scale analysis ===")
        scale_x = np.linalg.norm(abs_mat[0,:3])
        scale_y = np.linalg.norm(abs_mat[1,:3])
        scale_z = np.linalg.norm(abs_mat[2,:3])
        print(f"  Hierarchy bind matrix row scales: X={scale_x:.4f}  Y={scale_y:.4f}  Z={scale_z:.4f}")
        scale_x2 = np.linalg.norm(tl_bjs[0,:3])
        scale_y2 = np.linalg.norm(tl_bjs[1,:3])
        scale_z2 = np.linalg.norm(tl_bjs[2,:3])
        print(f"  TransformLink BJS row scales:    X={scale_x2:.4f}  Y={scale_y2:.4f}  Z={scale_z2:.4f}")
    else:
        print("  No TransformLink data found!")
        tl_data = None
else:
    print("  No cluster found for arm_joint_L_1!")
    tl_data = None

# ── FBX world matrix computation (column-vector space) ────────────────────────
def fbx_rot_matrix_col(deg, rot_order=0):
    """4x4 FBX rotation matrix in column-vector convention for given order."""
    rx, ry, rz = math.radians(deg[0]), math.radians(deg[1]), math.radians(deg[2])
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    Rx = np.array([[1,0,0,0],[0,cx,-sx,0],[0,sx,cx,0],[0,0,0,1]], dtype=float)
    Ry = np.array([[cy,0,sy,0],[0,1,0,0],[-sy,0,cy,0],[0,0,0,1]], dtype=float)
    Rz = np.array([[cz,-sz,0,0],[sz,cz,0,0],[0,0,1,0],[0,0,0,1]], dtype=float)
    # For XYZ rotation order, column-vector: v' = Rz*(Ry*(Rx*v)) = Rz@Ry@Rx @ v
    if   rot_order == 1: return Rx @ Rz @ Ry   # XZY
    elif rot_order == 2: return Ry @ Rz @ Rx   # YZX
    elif rot_order == 3: return Ry @ Rx @ Rz   # YXZ
    elif rot_order == 4: return Rz @ Rx @ Ry   # ZXY
    elif rot_order == 5: return Rz @ Ry @ Rx   # ZYX
    else:                return Rz @ Ry @ Rx   # XYZ (0)

def fbx_local_matrix_col(T, R, S, preR=None, rot_order=0):
    """FBX local matrix in column-vector convention: T * PreR * R * S."""
    Tm = np.eye(4); Tm[0,3]=T[0]; Tm[1,3]=T[1]; Tm[2,3]=T[2]
    Sm = np.diag([S[0],S[1],S[2],1.0])
    Rm = fbx_rot_matrix_col(R, rot_order)
    if preR and any(v != 0.0 for v in preR):
        Rm = fbx_rot_matrix_col(preR, 0) @ Rm
    return Tm @ Rm @ Sm

if tl_data:
    print("\n=== FBX world matrix from hierarchy (FBX column-vector space) ===")
    # In FBX col-vec: world = M_root @ M_parent @ ... @ M_leaf (leftmost = outermost)
    # Accumulate left-to-right: world = world @ M_next  (so Z_UP is leftmost)
    fbx_world = np.eye(4)
    for bone_id in chain_root_first:  # [Z_UP, Armature, T1, T2, T3, arm]
        m = all_model_by_id.get(bone_id)
        if not m: continue
        tf = get_model_transform_dict(m)
        local_fbx = fbx_local_matrix_col(tf["T"], tf["R"], tf["S"], tf["preR"], tf["rotOrder"])
        fbx_world = fbx_world @ local_fbx
    fmt_mat(fbx_world, "FBX world (col-vec hierarchy)")
    print(f"  Translation col: X={fbx_world[0,3]:.5f}  Y={fbx_world[1,3]:.5f}  Z={fbx_world[2,3]:.5f}")

    # TransformLink in FBX column-vector form
    # The 16 floats are stored column-major → reshape(4,4) gives rows=FBX_columns,
    # so we need to transpose to get the FBX column-vector matrix
    tl_col = np.array(tl_data).reshape(4,4).T
    fmt_mat(tl_col, "TransformLink as FBX col-vec matrix")
    print(f"  Translation col: X={tl_col[0,3]:.5f}  Y={tl_col[1,3]:.5f}  Z={tl_col[2,3]:.5f}")

    diff_fbx = fbx_world - tl_col
    max_diff_fbx = np.max(np.abs(diff_fbx))
    print(f"\n  Max diff (FBX hierarchy vs TransformLink): {max_diff_fbx:.6f}")
    if max_diff_fbx < 1.0:
        print("  ✓ FBX matrices agree — discrepancy is in BJS conversion code")
    else:
        print("  ✗ FBX matrices DISAGREE — TransformLink ≠ hierarchy (bind pose is different)")

    # WITHOUT Z_UP
    print("\n=== FBX world WITHOUT Z_UP ===")
    Z_UP_ID = 861850117
    fbx_no_zup = np.eye(4)
    for bone_id in chain_root_first:
        if bone_id == Z_UP_ID: continue
        m = all_model_by_id.get(bone_id)
        if not m: continue
        tf = get_model_transform_dict(m)
        local_fbx = fbx_local_matrix_col(tf["T"], tf["R"], tf["S"], tf["preR"], tf["rotOrder"])
        fbx_no_zup = fbx_no_zup @ local_fbx
    fmt_mat(fbx_no_zup, "FBX world WITHOUT Z_UP")
    print(f"  Max diff vs TransformLink: {np.max(np.abs(fbx_no_zup - tl_col)):.6f}")

# Also check: does the FBX hierarchy include Z_UP (LclS=[100,100,100])?
print(f"\n=== Checking Z_UP in hierarchy ===")
for bone_id in chain:
    m = all_model_by_id.get(bone_id)
    if not m: continue
    tf = get_model_transform_dict(m)
    name = node_display_name(m)
    if tf["S"] != [1.0,1.0,1.0]:
        print(f"  {name!r} ID={bone_id}: LclS={tf['S']}  ← NON-UNIT SCALE")
    if tf["R"] != [0.0,0.0,0.0]:
        print(f"  {name!r} ID={bone_id}: LclR={tf['R']}")

# Check parents ABOVE the chain too (armature/Z_UP)
print("\nChecking ancestors above the chain root:")
top_id = chain[-1]
parent = node_to_parent.get(top_id)
depth = 0
while parent and parent != 0 and depth < 5:
    m = all_model_by_id.get(parent)
    if m:
        name = node_display_name(m)
        mtype = m.props[2] if len(m.props) > 2 else "?"
        tf = get_model_transform_dict(m)
        print(f"  {parent}: {name!r} ({mtype})  S={tf['S']}  R={tf['R']}")
    parent = node_to_parent.get(parent)
    depth += 1
