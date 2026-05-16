#!/usr/bin/env python3
"""Analyze RiggedSimple.fbx: bone hierarchy, TransformLink vs LclR world matrices."""
import struct, zlib, sys, io, math
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedSimple.fbx")

# ── FBX binary parser ──────────────────────────────────────────────────────────
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
    e=r.off(); np_=r.off(); _=r.off(); nl=r.u8()
    name=r.data[r.pos:r.pos+nl].decode("utf-8","replace"); r.pos+=nl
    ns=25 if r.is64 else 13
    if e==0 and np_==0 and nl==0: return None
    props=[r.prop() for _ in range(np_)]
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

def find_node(children, name):
    for c in children:
        if c.name == name: return c
    return None

def prop0(node):
    return node.props[0] if node and node.props else None

def get_p70(node):
    result = {}
    p70node = find_node(node.children, 'Properties70')
    if not p70node: return result
    for p in p70node.children:
        if p.name == 'P' and len(p.props) >= 5:
            key = p.props[0]
            vals = p.props[4:]
            result[key] = vals
    return result

# ── Math helpers ───────────────────────────────────────────────────────────────
def Rx(deg):
    a = math.radians(deg); c = math.cos(a); s = math.sin(a)
    return np.array([[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]], dtype=np.float64)

def Ry(deg):
    a = math.radians(deg); c = math.cos(a); s = math.sin(a)
    return np.array([[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]], dtype=np.float64)

def Rz(deg):
    a = math.radians(deg); c = math.cos(a); s = math.sin(a)
    return np.array([[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]], dtype=np.float64)

def euler_to_matrix_fbx(rx_deg, ry_deg, rz_deg, order=0):
    """FBX Euler to rotation matrix in FBX column-vector convention.
    FBX order ABC means: apply A first, B second, C last.
    In column-vector: R = Rc @ Rb @ Ra  (rightmost applied first to point).
    """
    Rx_ = Rx(rx_deg); Ry_ = Ry(ry_deg); Rz_ = Rz(rz_deg)
    orders = {
        0: Rz_ @ Ry_ @ Rx_,   # XYZ
        1: Ry_ @ Rz_ @ Rx_,   # XZY
        2: Rx_ @ Rz_ @ Ry_,   # YZX
        3: Rz_ @ Rx_ @ Ry_,   # YXZ
        4: Ry_ @ Rx_ @ Rz_,   # ZXY
        5: Rx_ @ Ry_ @ Rz_,   # ZYX
    }
    return orders.get(order, Rz_ @ Ry_ @ Rx_)

def make_trs_col(T, R_mat, S):
    """TRS matrix in FBX column-vector convention (translation in last column)."""
    m = np.eye(4)
    m[:3,:3] = R_mat[:3,:3] * np.array(S)   # scale columns of R
    m[:3,3]  = T
    return m

def compute_fbx_world(model_id, model_by_id, node_to_parent, get_transform_fn):
    """Compute FBX world matrix (column-vector) by walking ancestor chain."""
    chain = []
    x = model_id
    while x:
        chain.append(x)
        p = node_to_parent.get(x)
        if not p or p == 0: break
        x = p
    world = np.eye(4)
    for mid in reversed(chain):
        T, R, S, preR, rotOrder = get_transform_fn(mid)
        R_mat = euler_to_matrix_fbx(preR[0],preR[1],preR[2],0) @ euler_to_matrix_fbx(R[0],R[1],R[2],rotOrder)
        local = make_trs_col(T, R_mat, S)
        world = world @ local  # FBX: child appended on the right
    return world

# ── Load ───────────────────────────────────────────────────────────────────────
roots = load(FBX_PATH)
fbx_version = R(FBX_PATH).version
print(f"Loaded: {FBX_PATH}  version={fbx_version}")

# ── Gather objects ─────────────────────────────────────────────────────────────
model_by_id = {}
cluster_by_id = {}
for n in iter_nodes(roots):
    if n.name == 'Model' and n.props:
        model_by_id[n.props[0]] = n
    elif n.name == 'Deformer' and n.props and len(n.props) >= 3 and n.props[2] == 'Cluster':
        cluster_by_id[n.props[0]] = n

# ── Connections ────────────────────────────────────────────────────────────────
conns_node = next((n for n in roots if n.name == 'Connections'), None)
oo_from_to = {}  # from_id -> [to_id]
if conns_node:
    for c in conns_node.children:
        if c.name != 'C' or len(c.props) < 3: continue
        if c.props[0] == 'OO':
            oo_from_to.setdefault(c.props[1], []).append(c.props[2])

# ── Parent map (child → parent, MODEL→MODEL only) ────────────────────────────
node_to_parent = {}
for from_id, to_ids in oo_from_to.items():
    for to_id in to_ids:
        if from_id in model_by_id and to_id in model_by_id:
            node_to_parent[from_id] = to_id

# ── Bone-to-cluster mapping (bone → cluster: OO from=bone to=cluster) ─────────
bone_to_cluster = {}
for from_id, to_ids in oo_from_to.items():
    for to_id in to_ids:
        if from_id in model_by_id and to_id in cluster_by_id:
            bone_to_cluster[from_id] = to_id

bone_model_ids = set(bone_to_cluster.keys())

# ── Transform reader ───────────────────────────────────────────────────────────
def get_transform(model_id):
    n = model_by_id.get(model_id)
    if not n: return [0,0,0],[0,0,0],[1,1,1],[0,0,0],0
    p70 = get_p70(n)
    def v3(key, default):
        v = p70.get(key)
        if v and len(v) >= 3: return [float(v[0]), float(v[1]), float(v[2])]
        return list(default)
    def vi(key, default):
        v = p70.get(key)
        return int(v[0]) if v else default
    return (v3('Lcl Translation',[0,0,0]), v3('Lcl Rotation',[0,0,0]),
            v3('Lcl Scaling',[1,1,1]),    v3('PreRotation',[0,0,0]),
            vi('RotationOrder',0))

def model_name(mid):
    n = model_by_id.get(mid)
    if not n or not n.props: return f"id_{mid}"
    raw = n.props[1] if len(n.props) > 1 else ''
    return raw.split('\0')[0].replace('Model','').strip() or f"id_{mid}"

# ── Topological sort (parent before child) ────────────────────────────────────
def topo_sort(ids, parent_map):
    visited = set(); order = []
    def visit(i):
        if i in visited: return
        visited.add(i)
        p = parent_map.get(i)
        if p and p in ids: visit(p)
        order.append(i)
    for i in ids: visit(i)
    return order

ordered = topo_sort(bone_model_ids, node_to_parent)

# ═══════════════════════════════════════════════════════════════════════════════
# Output
# ═══════════════════════════════════════════════════════════════════════════════

# ── Ancestor chain for root bones ─────────────────────────────────────────────
root_bones = [bid for bid in ordered if node_to_parent.get(bid) not in bone_model_ids]
print("\n=== Ancestor chain for root bones (root → bone) ===")
for bid in root_bones:
    chain = []
    x = bid
    while x:
        chain.append(x)
        p = node_to_parent.get(x)
        if not p or p == 0: break
        x = p
    chain = list(reversed(chain))
    for mid in chain:
        T, R, S, preR, rotOrder = get_transform(mid)
        is_bone = mid in bone_model_ids
        tag = "[BONE]" if is_bone else "[non-bone]"
        print(f"  {model_name(mid)} (id={mid})  {tag}")
        print(f"    LclT={[round(v,4) for v in T]}  LclR={[round(v,4) for v in R]}  LclS={[round(v,4) for v in S]}")
        if any(abs(v) > 1e-6 for v in preR):
            print(f"    PreR={[round(v,4) for v in preR]}  rotOrder={rotOrder}")
        # Check for other rotation properties
        n = model_by_id.get(mid)
        if n:
            p70 = get_p70(n)
            for key in ['RotationOffset','RotationPivot','PostRotation','ScalingPivot','ScalingOffset']:
                if key in p70:
                    print(f"    {key}={[round(float(v),4) for v in p70[key][:3]]}")
    print()

# ── Bone hierarchy ─────────────────────────────────────────────────────────────
print("\n=== Bone Hierarchy ===")
for bid in ordered:
    depth = 0; x = bid
    while node_to_parent.get(x) in bone_model_ids:
        x = node_to_parent[x]; depth += 1
    T, R, S, preR, rotOrder = get_transform(bid)
    indent = "  " * depth
    cluster_id = bone_to_cluster.get(bid)
    tl_str = ""
    if cluster_id:
        clust = cluster_by_id.get(cluster_id)
        tl_node = find_node(clust.children, 'TransformLink')
        tl_data = prop0(tl_node)
        if tl_data and len(tl_data) == 16:
            tl_col = np.array(tl_data, dtype=np.float64).reshape(4,4,order='F')
            tl_str = f"  TL_T={[round(v,4) for v in tl_col[:3,3]]}"
    print(f"{indent}{model_name(bid)}: LclT={[round(v,4) for v in T]}  LclR={[round(v,4) for v in R]}  LclS={[round(v,4) for v in S]}{tl_str}")
print()

# ── Compare TL vs LclR hierarchy ───────────────────────────────────────────────
print("=== TransformLink vs LclR Hierarchy World (FBX column-vector) ===")
for bid in ordered:
    name = model_name(bid)
    cluster_id = bone_to_cluster.get(bid)
    if not cluster_id: continue
    clust = cluster_by_id.get(cluster_id)
    tl_node = find_node(clust.children, 'TransformLink')
    tl_data = prop0(tl_node)
    if not tl_data or len(tl_data) != 16: continue

    tl_col = np.array(tl_data, dtype=np.float64).reshape(4,4,order='F')
    hierarchy_world = compute_fbx_world(bid, model_by_id, node_to_parent, get_transform)

    diff = np.abs(tl_col - hierarchy_world)
    max_diff = diff.max()
    print(f"\nBone: {name}  (max matrix diff = {max_diff:.5f})")
    print(f"  TL translation:        {[round(v,4) for v in tl_col[:3,3]]}")
    print(f"  Hierarchy translation: {[round(v,4) for v in hierarchy_world[:3,3]]}")
    if max_diff > 0.01:
        print(f"  ROTATION MISMATCH:")
        print(f"    TL rot (cols 0-2):\n{np.round(tl_col[:3,:3]/100,3)}")
        print(f"    Hier rot (cols 0-2):\n{np.round(hierarchy_world[:3,:3]/100,3)}")
    else:
        print(f"  MATCH ✓")

# ── AnimationStacks ───────────────────────────────────────────────────────────
FBX_TIME = 1/46186158000
print("\n\n=== AnimationStacks ===")
for n in iter_nodes(roots, 'AnimationStack'):
    sid = n.props[0] if n.props else '?'
    sname = n.props[1].split('\0')[0] if len(n.props)>1 else '?'
    p70 = get_p70(n)
    ls = p70.get('LocalStart'); ls = float(ls[0]) * FBX_TIME if ls else None
    le = p70.get('LocalStop');  le = float(le[0]) * FBX_TIME if le else None
    dur = f"  {ls:.4f}s – {le:.4f}s" if ls is not None else ""
    print(f"  {sname!r}{dur}")

# ── GlobalSettings ────────────────────────────────────────────────────────────
print("\n=== GlobalSettings ===")
gs = next((n for n in roots if n.name == 'GlobalSettings'), None)
if gs:
    p70 = get_p70(gs)
    axis_names = {0:'X', 1:'Y', 2:'Z'}
    for key in ['UpAxis','UpAxisSign','FrontAxis','FrontAxisSign','CoordAxis','CoordAxisSign']:
        if key in p70:
            v = p70[key][0] if p70[key] else '?'
            extra = f" ({axis_names.get(int(v),'?')})" if 'Axis' in key and 'Sign' not in key else ""
            print(f"  {key}: {v}{extra}")
