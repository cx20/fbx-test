#!/usr/bin/env python3
"""Trace ACN 127406240 → Layer → Stack connection, and show all ACNs for arm_joint_L_1."""
import struct, zlib, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

class R:
    def __init__(self, path):
        with open(path,"rb") as f: self.data=f.read()
        self.pos=27; self.version=struct.unpack_from("<I",self.data,23)[0]; self.is64=self.version>=7500
    def u8(self):
        v=struct.unpack_from("B",self.data,self.pos)[0]; self.pos+=1; return v
    def u32(self):
        v=struct.unpack_from("<I",self.data,self.pos)[0]; self.pos+=4; return v
    def u64(self):
        v=struct.unpack_from("<Q",self.data,self.pos)[0]; self.pos+=8; return v
    def i16(self):
        v=struct.unpack_from("<h",self.data,self.pos)[0]; self.pos+=2; return v
    def i32(self):
        v=struct.unpack_from("<i",self.data,self.pos)[0]; self.pos+=4; return v
    def i64(self):
        v=struct.unpack_from("<q",self.data,self.pos)[0]; self.pos+=8; return v
    def f32(self):
        v=struct.unpack_from("<f",self.data,self.pos)[0]; self.pos+=4; return v
    def f64(self):
        v=struct.unpack_from("<d",self.data,self.pos)[0]; self.pos+=8; return v
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

def iter_nodes(nodes,name=None):
    for n in nodes:
        if name is None or n.name==name: yield n
        yield from iter_nodes(n.children,name)

def nid(n): return n.props[0] if n.props else None
def nname(n):
    raw=n.props[1] if len(n.props)>1 else "?"
    return raw.split("\x00")[0] if "\x00" in raw else raw

roots = load(FBX_PATH)

# Collect all objects by ID
obj_by_id = {}
for n in iter_nodes(roots):
    if n.name in ("AnimationCurveNode","AnimationLayer","AnimationStack","Model"):
        oid = nid(n)
        if oid is not None: obj_by_id[oid] = n

# Build ALL OO connections
conns = next((n for n in roots if n.name=="Connections"), None)
all_oo = []  # (from_id, to_id)
if conns:
    for c in conns.children:
        if c.name=="C" and len(c.props)>=3 and c.props[0]=="OO":
            all_oo.append((c.props[1], c.props[2]))

from_to = {}  # from_id → [to_id, ...]
to_from = {}  # to_id → [from_id, ...]
for f,t in all_oo:
    from_to.setdefault(f,[]).append(t)
    to_from.setdefault(t,[]).append(f)

TARGET_BONE = 270376567   # arm_joint_L_1
TARGET_ACN  = 127406240

FBX_TIME = 1/46186158000

def stack_name(sid):
    n = obj_by_id.get(sid)
    if not n: return f"unknown({sid})"
    return n.props[1].split("\x00")[0] if len(n.props)>1 else "?"

def layer_name(lid):
    n = obj_by_id.get(lid)
    if not n: return f"unknown({lid})"
    return n.props[1].split("\x00")[0] if len(n.props)>1 else "?"

print("=== All ACNs connecting to arm_joint_L_1 (270376567) ===")
# ACN → bone: OO from ACN to bone (with prop=Lcl Rotation etc.)
if conns:
    for c in conns.children:
        if c.name=="C" and len(c.props)>=3 and c.props[0]=="OO":
            f,t = c.props[1], c.props[2]
            prop = c.props[3] if len(c.props)>3 else None
            if t == TARGET_BONE:
                n = obj_by_id.get(f)
                ntype = n.name if n else "?"
                print(f"  {ntype} {f} → bone 270376567  prop={prop!r}")

print()
print(f"=== Layer chain for ACN {TARGET_ACN} ===")
# ACN connects to layer via OO
acn_layers = from_to.get(TARGET_ACN, [])
print(f"  ACN {TARGET_ACN} connects TO: {acn_layers}")
for lid in acn_layers:
    lobj = obj_by_id.get(lid)
    ltype = lobj.name if lobj else "?"
    lname = layer_name(lid)
    # Layer connects to stack
    stacks = from_to.get(lid, [])
    print(f"    → {ltype} {lid} ({lname!r})")
    for sid in stacks:
        sobj = obj_by_id.get(sid)
        stype = sobj.name if sobj else "?"
        sname = stack_name(sid)
        print(f"       → {stype} {sid} ({sname!r})")

print()
print("=== All AnimationStacks and their Layers ===")
for n in iter_nodes(roots, "AnimationStack"):
    sid = nid(n)
    sname = nname(n)
    # Find layers for this stack (layer → stack via OO)
    layers = to_from.get(sid, [])
    print(f"  Stack {sid} {sname!r}")
    for lid in layers:
        lobj = obj_by_id.get(lid)
        ltype = lobj.name if lobj else "?"
        lname = layer_name(lid)
        # Find ACNs in this layer (ACN → layer)
        acns_in_layer = to_from.get(lid, [])
        print(f"    Layer {lid} {lname!r}: {len(acns_in_layer)} ACNs")
        # Show ACNs that target arm_joint_L_1
        for acn_id in acns_in_layer:
            targets = from_to.get(acn_id, [])
            if TARGET_BONE in targets:
                print(f"      ACN {acn_id} → arm_joint_L_1 ←── HERE")
