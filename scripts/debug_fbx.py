#!/usr/bin/env python3
"""Debug: inspect structure of a bone Model node and an AnimationCurveNode."""
import struct, zlib, sys, io
from collections import defaultdict
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

class FBXReader:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.pos = 0
        magic = self.data[:21]
        assert magic == b"Kaydara FBX Binary  \x00"
        self.version = struct.unpack_from("<I", self.data, 23)[0]
        self.is64 = self.version >= 7500
        self.pos = 27

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
    def read_offset(self):
        return self.read_u64() if self.is64 else self.read_u32()
    def read_array(self, fmt, itemsize):
        count = self.read_u32(); encoding = self.read_u32(); comp_len = self.read_u32()
        if encoding == 1:
            raw = zlib.decompress(self.data[self.pos:self.pos+comp_len]); self.pos += comp_len
        else:
            raw = self.data[self.pos:self.pos+count*itemsize]; self.pos += count*itemsize
        return list(struct.unpack_from(f"<{count}{fmt}", raw))
    def read_property(self):
        t = chr(self.read_u8())
        if   t == "C": return t, bool(self.read_u8())
        elif t == "Y": return t, self.read_i16()
        elif t == "I": return t, self.read_i32()
        elif t == "L": return t, self.read_i64()
        elif t == "F": return t, self.read_f32()
        elif t == "D": return t, self.read_f64()
        elif t == "f": return t, self.read_array("f", 4)
        elif t == "d": return t, self.read_array("d", 8)
        elif t == "i": return t, self.read_array("i", 4)
        elif t == "l": return t, self.read_array("q", 8)
        elif t == "b": return t, self.read_array("B", 1)
        elif t == "c": return t, self.read_array("B", 1)
        elif t == "S":
            n = self.read_u32(); v = self.data[self.pos:self.pos+n].decode("utf-8","replace"); self.pos += n; return t, v
        elif t == "R":
            n = self.read_u32(); v = self.data[self.pos:self.pos+n]; self.pos += n; return t, v
        else:
            raise ValueError(f"Unknown type {t!r} at {self.pos-1}")

NULL_RECORD_SIZE_32 = 13
NULL_RECORD_SIZE_64 = 25

class FBXNode:
    __slots__ = ("name","props","children","end_offset")
    def __init__(self, name, props, children, end_offset):
        self.name=name; self.props=props; self.children=children; self.end_offset=end_offset

def parse_node(reader):
    end_offset = reader.read_offset()
    num_props  = reader.read_offset()
    prop_list_len = reader.read_offset()
    name_len   = reader.read_u8()
    name = reader.data[reader.pos:reader.pos+name_len].decode("utf-8","replace")
    reader.pos += name_len
    null_size = NULL_RECORD_SIZE_64 if reader.is64 else NULL_RECORD_SIZE_32
    if end_offset == 0 and num_props == 0 and prop_list_len == 0 and name_len == 0:
        return None
    props = []
    for _ in range(num_props):
        props.append(reader.read_property())
    children = []
    if reader.pos < end_offset:
        sentinel = null_size
        while reader.pos < end_offset - sentinel:
            child = parse_node(reader)
            if child is None: break
            children.append(child)
        reader.pos = end_offset
    return FBXNode(name, props, children, end_offset)

def parse_fbx(path):
    reader = FBXReader(path)
    roots = []
    data_len = len(reader.data)
    null_size = NULL_RECORD_SIZE_64 if reader.is64 else NULL_RECORD_SIZE_32
    while reader.pos < data_len - null_size:
        node = parse_node(reader)
        if node is None: break
        roots.append(node)
    return roots

def iter_nodes(nodes, name=None):
    for n in nodes:
        if name is None or n.name == name: yield n
        yield from iter_nodes(n.children, name)

roots = parse_fbx(FBX_PATH)

# Find first bone node and dump its structure
print("=== First bone Model node structure ===")
for m in iter_nodes(roots, "Model"):
    if len(m.props) >= 3 and m.props[2][1] == "LimbNode":
        nm = m.props[1][1].split("\x00")[0] if "\x00" in m.props[1][1] else m.props[1][1]
        print(f"Bone: {nm!r}")
        print(f"  props: {[(t,v) for t,v in m.props[:4]]}")
        print(f"  children ({len(m.children)}):")
        for c in m.children:
            print(f"    child name={c.name!r}  props[0]={c.props[0] if c.props else 'NONE'}")
            if c.name == "Properties70":
                print(f"      P children ({len(c.children)}):")
                for p in c.children[:10]:
                    print(f"        P name={p.name!r}  props={p.props}")
        break

# Find first AnimationCurveNode and dump its structure
print()
print("=== First AnimationCurveNode structure ===")
for acn in iter_nodes(roots, "AnimationCurveNode"):
    print(f"ACN props: {acn.props}")
    print(f"  children ({len(acn.children)}):")
    for c in acn.children:
        print(f"    child name={c.name!r}  props[0]={c.props[0] if c.props else 'NONE'}")
        if c.name == "Properties70":
            for p in c.children[:5]:
                print(f"      P: {p.props}")
    break

# Dump first 3 Connections entries
print()
print("=== First Connection entries ===")
for cn in iter_nodes(roots, "Connections"):
    for c in cn.children[:10]:
        print(f"  C: name={c.name!r}  props={c.props}")

# Show raw name bytes for first ACN
print()
print("=== Raw ACN name bytes (first 5) ===")
for i, acn in enumerate(iter_nodes(roots, "AnimationCurveNode")):
    if i >= 5: break
    raw = acn.props[1][1] if len(acn.props) > 1 else "?"
    print(f"  ACN[{i}] raw name bytes: {raw.encode('utf-8')!r}  repr: {raw!r}")
