#!/usr/bin/env python3
"""Inspect AnimationStack/Layer/CurveNode connections."""
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

path = sys.argv[1]
roots = load(path)

stacks = {}
layers = {}
acns = {}
for n in iter_nodes(roots, "AnimationStack"):
    if n.props: stacks[n.props[0]] = n.props[1] if len(n.props)>1 else '?'
for n in iter_nodes(roots, "AnimationLayer"):
    if n.props: layers[n.props[0]] = n.props[1] if len(n.props)>1 else '?'
for n in iter_nodes(roots, "AnimationCurveNode"):
    if n.props: acns[n.props[0]] = n.props[1] if len(n.props)>1 else '?'

print(f"=== {os.path.basename(path)} ===")
print(f"  Stacks ({len(stacks)}):")
for sid, name in stacks.items():
    print(f"    {sid}: {name!r}")
print(f"  Layers ({len(layers)}):")
for lid, name in layers.items():
    print(f"    {lid}: {name!r}")
print(f"  ACNs ({len(acns)})")

# Connections
for n in roots:
    if n.name == "Connections":
        # Layer -> Stack
        print("\n  Layer -> Stack:")
        for c in n.children:
            if c.name != "C" or c.props[0] != "OO": continue
            fromId = c.props[1]; toId = c.props[2]
            if fromId in layers and toId in stacks:
                print(f"    {fromId} ({layers[fromId]!r}) -> {toId} ({stacks[toId]!r})")
        # ACN -> Layer
        print("\n  ACN -> Layer (count per layer):")
        layer_acn_count = {}
        for c in n.children:
            if c.name != "C" or c.props[0] != "OO": continue
            fromId = c.props[1]; toId = c.props[2]
            if fromId in acns and toId in layers:
                layer_acn_count[toId] = layer_acn_count.get(toId, 0) + 1
        for lid, count in layer_acn_count.items():
            print(f"    Layer {lid} ({layers[lid]!r}): {count} ACNs")
        break
