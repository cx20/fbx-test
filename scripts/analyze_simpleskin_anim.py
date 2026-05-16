#!/usr/bin/env python3
"""Analyze SimpleSkin animation curves."""
import struct, zlib, sys, io, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "SimpleSkin.fbx")
FBX_TIME = 1/46186158000

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

roots = load(FBX_PATH)
conns = next(n for n in roots if n.name=="Connections")

# Models
model_by_id = {}
name_by_id = {}
for n in iter_nodes(roots, "Model"):
    if n.props and isinstance(n.props[0], int):
        model_by_id[n.props[0]] = n
        nm = n.props[1].split("\x00")[0] if len(n.props)>1 else "?"
        name_by_id[n.props[0]] = nm

# Find animation stack
stack = next(iter_nodes(roots, "AnimationStack"))
stack_id = stack.props[0]
name = stack.props[1].split("\x00")[0] if len(stack.props)>1 else "?"
print(f"Animation Stack: {name!r} (id={stack_id})")

# Maps
acn_by_id = {}
for n in iter_nodes(roots, "AnimationCurveNode"):
    if n.props: acn_by_id[n.props[0]] = n

layer_by_id = {}
for n in iter_nodes(roots, "AnimationLayer"):
    if n.props: layer_by_id[n.props[0]] = n

anim_curve_by_id = {}
for n in iter_nodes(roots, "AnimationCurve"):
    if n.props: anim_curve_by_id[n.props[0]] = n

layers_for_stack = []
acns_for_layer = {}
acn_target = {}
curves_for_acn = {}

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
    if ctype == "OP" and f in anim_curve_by_id and t in acn_by_id:
        axis = 0 if prop=="d|X" else (1 if prop=="d|Y" else (2 if prop=="d|Z" else -1))
        if axis >= 0:
            curves_for_acn.setdefault(t, {})[axis] = f

# Group animated channels by model
print(f"\nLayers: {layers_for_stack}\n")
for layer_id in layers_for_stack:
    print(f"=== Layer {layer_id} ===")
    by_model = {}
    for acn_id in acns_for_layer.get(layer_id, []):
        model_id, prop_name = acn_target.get(acn_id, (None, None))
        if model_id is None: continue
        by_model.setdefault(model_id, []).append((acn_id, prop_name))

    for model_id, channels in by_model.items():
        nm = name_by_id.get(model_id, str(model_id))
        print(f"\n  Model: {nm} ({model_id})")
        for acn_id, prop_name in channels:
            axes_curves = curves_for_acn.get(acn_id, {})
            print(f"    Property: {prop_name!r}")
            for axis, curve_id in sorted(axes_curves.items()):
                axis_name = ["X","Y","Z"][axis]
                curve = anim_curve_by_id[curve_id]
                times_raw = find_child(curve, "KeyTime")
                values_node = find_child(curve, "KeyValueFloat")
                flags_node = find_child(curve, "KeyAttrFlags")

                times = [t*FBX_TIME for t in times_raw.props[0]] if times_raw else []
                values = values_node.props[0] if values_node else []
                flags = flags_node.props[0] if flags_node else []

                interp_names = {8:"cubic", 256:"linear", 512:"constant"}
                interp_set = set()
                for f in flags:
                    for mask, nm2 in interp_names.items():
                        if f & mask: interp_set.add(nm2)

                if len(values) > 0:
                    vmin, vmax = min(values), max(values)
                    print(f"      {axis_name}: {len(times)} keys, range=[{vmin:.4f}, {vmax:.4f}], interp={interp_set or {'?'}}")
                    if len(values) <= 8:
                        for i, (t, v) in enumerate(zip(times, values)):
                            print(f"        [{i}] t={t:.4f}s val={v:.4f}")
                    else:
                        print(f"        first 3: " + ", ".join(f"({times[i]:.3f}s,{values[i]:.3f})" for i in range(3)))
                        print(f"        last 3:  " + ", ".join(f"({times[-i-1]:.3f}s,{values[-i-1]:.3f})" for i in range(2,-1,-1)))
