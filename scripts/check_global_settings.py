#!/usr/bin/env python3
"""Extract FBX GlobalSettings to understand coordinate system and Three.js behavior."""
import struct, zlib, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

class FBXReader:
    def __init__(self, path):
        with open(path, "rb") as f: self.data = f.read()
        self.pos = 27
        self.version = struct.unpack_from("<I", self.data, 23)[0]
        self.is64 = self.version >= 7500
    def read_u8(self):
        v = struct.unpack_from("B", self.data, self.pos)[0]; self.pos += 1; return v
    def read_u32(self):
        v = struct.unpack_from("<I", self.data, self.pos)[0]; self.pos += 4; return v
    def read_u64(self):
        v = struct.unpack_from("<Q", self.data, self.pos)[0]; self.pos += 8; return v
    def read_i16(self):
        v = struct.unpack_from("<h", self.data, self.pos)[0]; self.pos += 2; return v
    def read_i32(self):
        v = struct.unpack_from("<i", self.data, self.pos)[0]; self.pos += 4; return v
    def read_i64(self):
        v = struct.unpack_from("<q", self.data, self.pos)[0]; self.pos += 8; return v
    def read_f32(self):
        v = struct.unpack_from("<f", self.data, self.pos)[0]; self.pos += 4; return v
    def read_f64(self):
        v = struct.unpack_from("<d", self.data, self.pos)[0]; self.pos += 8; return v
    def read_offset(self): return self.read_u64() if self.is64 else self.read_u32()
    def read_array(self, fmt, itemsize):
        count = self.read_u32(); encoding = self.read_u32(); comp_len = self.read_u32()
        if encoding == 1:
            raw = zlib.decompress(self.data[self.pos:self.pos+comp_len]); self.pos += comp_len
        else:
            raw = self.data[self.pos:self.pos+count*itemsize]; self.pos += count*itemsize
        return list(struct.unpack_from(f"<{count}{fmt}", raw))
    def read_string(self):
        n = self.read_u32(); v = self.data[self.pos:self.pos+n].decode("utf-8","replace"); self.pos += n; return v
    def read_property(self):
        t = chr(self.read_u8())
        if t=="C": return t, bool(self.read_u8())
        elif t=="Y": return t, self.read_i16()
        elif t=="I": return t, self.read_i32()
        elif t=="L": return t, self.read_i64()
        elif t=="F": return t, self.read_f32()
        elif t=="D": return t, self.read_f64()
        elif t=="f": return t, self.read_array("f",4)
        elif t=="d": return t, self.read_array("d",8)
        elif t=="i": return t, self.read_array("i",4)
        elif t=="l": return t, self.read_array("q",8)
        elif t in ("b","c"): return t, self.read_array("B",1)
        elif t=="S": return t, self.read_string()
        elif t=="R": n=self.read_u32(); v=self.data[self.pos:self.pos+n]; self.pos+=n; return t, bytes(v)
        else: raise ValueError(f"Unknown type {t!r}")

class FBXNode:
    __slots__ = ("name","props","children")
    def __init__(self,n,p,c): self.name=n; self.props=p; self.children=c

def parse_node(r):
    end=r.read_offset(); np=r.read_offset(); _=r.read_offset()
    nl=r.read_u8(); name=r.data[r.pos:r.pos+nl].decode("utf-8","replace"); r.pos+=nl
    ns=25 if r.is64 else 13
    if end==0 and np==0 and nl==0: return None
    props=[r.read_property() for _ in range(np)]
    children=[]
    if r.pos<end:
        while r.pos<end-ns:
            child=parse_node(r)
            if child is None: break
            children.append(child)
        r.pos=end
    return FBXNode(name,props,children)

def parse_fbx(path):
    r=FBXReader(path); roots=[]; ns=25 if r.is64 else 13
    while r.pos<len(r.data)-ns:
        node=parse_node(r)
        if node is None: break
        roots.append(node)
    return roots

def iter_nodes(nodes, name=None):
    for n in nodes:
        if name is None or n.name==name: yield n
        yield from iter_nodes(n.children, name)

def get_p70_raw(node):
    result = {}
    for child in node.children:
        if child.name == "Properties70":
            for p in child.children:
                if p.name == "P" and p.props:
                    pname = p.props[0][1]
                    vals = [v for _, v in p.props[1:]]
                    result[pname] = vals
    return result

def main():
    roots = parse_fbx(FBX_PATH)

    # Find GlobalSettings
    gs = next((n for n in roots if n.name == "GlobalSettings"), None)
    if gs:
        print("=== GlobalSettings ===")
        p70 = get_p70_raw(gs)
        axis_names = {0:"X", 1:"Y", 2:"Z"}
        for key in sorted(p70.keys()):
            print(f"  {key}: {p70[key]}")

        print()
        print("Key coordinate system settings:")
        up = p70.get("UpAxis", [None])[1] if "UpAxis" in p70 else None
        up_sign = p70.get("UpAxisSign", [None])[1] if "UpAxisSign" in p70 else None
        front = p70.get("FrontAxis", [None])[1] if "FrontAxis" in p70 else None
        front_sign = p70.get("FrontAxisSign", [None])[1] if "FrontAxisSign" in p70 else None
        coord = p70.get("CoordAxis", [None])[1] if "CoordAxis" in p70 else None
        coord_sign = p70.get("CoordAxisSign", [None])[1] if "CoordAxisSign" in p70 else None

        print(f"  UpAxis={up} ({axis_names.get(up,'?')})  UpAxisSign={up_sign}")
        print(f"  FrontAxis={front} ({axis_names.get(front,'?')})  FrontAxisSign={front_sign}")
        print(f"  CoordAxis={coord} ({axis_names.get(coord,'?')})  CoordAxisSign={coord_sign}")
        print()

        if up == 1:
            print("  → Three.js: Y-up → NO global scene rotation applied")
        elif up == 2:
            print("  → Three.js: Z-up → applies -90° X rotation to scene root")
    else:
        print("No GlobalSettings found!")

    # Also check AnimationStack names to confirm clip names
    print("\n=== AnimationStacks ===")
    for n in iter_nodes(roots, "AnimationStack"):
        sid = n.props[0][1] if n.props else "?"
        sname = n.props[1][1].split('\0')[0] if len(n.props)>1 else "?"
        # Get LocalStart/LocalStop
        p70 = get_p70_raw(n)
        ls = p70.get("LocalStart", [None, None])[1] if "LocalStart" in p70 else None
        le = p70.get("LocalStop", [None, None])[1] if "LocalStop" in p70 else None
        FBX_TIME = 1/46186158000
        ls_sec = ls * FBX_TIME if ls is not None else None
        le_sec = le * FBX_TIME if le is not None else None
        print(f"  ID={sid}  Name={sname!r}  LocalStart={ls_sec:.4f}s  LocalStop={le_sec:.4f}s")

if __name__ == "__main__":
    main()
