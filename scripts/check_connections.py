#!/usr/bin/env python3
"""Show ALL connections (OO and OP) involving ACN 127406240 and arm_joint_L_1 (270376567)."""
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

roots = load(FBX_PATH)
print("Loaded FBX")

# Build id → object type map
id_type = {}
for n in iter_nodes(roots):
    if n.props:
        oid = n.props[0]
        if isinstance(oid, int):
            id_type[oid] = n.name + ("/" + n.props[2] if len(n.props) > 2 and isinstance(n.props[2], str) else "")

TARGET_ACN  = 127406240
TARGET_BONE = 270376567

conns = next((n for n in roots if n.name=="Connections"), None)

print(f"\n=== All connections involving ACN {TARGET_ACN} or bone {TARGET_BONE} ===")
if conns:
    for c in conns.children:
        if c.name != "C" or len(c.props) < 3: continue
        ctype = c.props[0]
        from_id = c.props[1]
        to_id = c.props[2]
        prop = c.props[3] if len(c.props) > 3 else None

        if TARGET_ACN in (from_id, to_id) or TARGET_BONE in (from_id, to_id):
            ft = id_type.get(from_id, "?")
            tt = id_type.get(to_id, "?")
            print(f"  [{ctype}]  {from_id}({ft})  →  {to_id}({tt})  prop={prop!r}")

print(f"\n=== Summary: what ACN {TARGET_ACN} connects FROM (c.from=ACN, any type) ===")
if conns:
    for c in conns.children:
        if c.name != "C" or len(c.props) < 3: continue
        if c.props[1] == TARGET_ACN:
            tt = id_type.get(c.props[2], "?")
            print(f"  [{c.props[0]}] ACN → {c.props[2]}({tt})  prop={c.props[3] if len(c.props)>3 else None!r}")
