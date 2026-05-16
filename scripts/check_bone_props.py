#!/usr/bin/env python3
"""
Extract PreRotation, RotationOrder, and LclRotation of key bones from RiggedFigure.fbx.
"""
import struct, zlib, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

class FBXReader:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
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
    def read_offset(self):
        return self.read_u64() if self.is64 else self.read_u32()
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
        elif t in ("b","c"): return t, self.read_array("B", 1)
        elif t == "S": return t, self.read_string()
        elif t == "R": n = self.read_u32(); v = self.data[self.pos:self.pos+n]; self.pos += n; return t, bytes(v)
        else: raise ValueError(f"Unknown type {t!r} at {self.pos-1}")

class FBXNode:
    __slots__ = ("name","props","children")
    def __init__(self, name, props, children):
        self.name = name; self.props = props; self.children = children

def parse_node(r):
    end_offset = r.read_offset(); num_props = r.read_offset(); _ = r.read_offset()
    name_len = r.read_u8()
    name = r.data[r.pos:r.pos+name_len].decode("utf-8","replace"); r.pos += name_len
    null_size = 25 if r.is64 else 13
    if end_offset == 0 and num_props == 0 and name_len == 0: return None
    props = [r.read_property() for _ in range(num_props)]
    children = []
    if r.pos < end_offset:
        while r.pos < end_offset - null_size:
            child = parse_node(r)
            if child is None: break
            children.append(child)
        r.pos = end_offset
    return FBXNode(name, props, children)

def parse_fbx(path):
    r = FBXReader(path)
    roots = []
    null_size = 25 if r.is64 else 13
    while r.pos < len(r.data) - null_size:
        node = parse_node(r)
        if node is None: break
        roots.append(node)
    return roots

def iter_nodes(nodes, name=None):
    for n in nodes:
        if name is None or n.name == name: yield n
        yield from iter_nodes(n.children, name)

def node_name(n):
    raw = n.props[1][1] if len(n.props) >= 2 else "?"
    return raw.split("\x00")[0] if "\x00" in raw else raw

def node_id(n):
    return n.props[0][1] if n.props else None

def get_p70(model_node):
    """Return dict propName -> list of raw values (starting at props[4]) from Properties70.
    FBX P node structure: P: "Name","Type","Label","Flags", val1, val2, ...
    So actual values are at props[4:].
    """
    result = {}
    for child in model_node.children:
        if child.name == "Properties70":
            for p in child.children:
                if p.name == "P" and len(p.props) >= 1:
                    pname = p.props[0][1]
                    # Values start at index 4
                    vals = [v for _, v in p.props[4:]]
                    result[pname] = vals
    return result

ROT_ORDER_NAMES = {0:"XYZ", 1:"XZY", 2:"YZX", 3:"YXZ", 4:"ZXY", 5:"ZYX", 6:"SphericXYZ"}

def fmt_vec(v):
    if v is None: return "None"
    if isinstance(v, list) and len(v) >= 3:
        return f"[{v[0]:.4f}, {v[1]:.4f}, {v[2]:.4f}]"
    return str(v)

def main():
    roots = parse_fbx(FBX_PATH)
    print("FBX loaded\n")

    all_models = list(iter_nodes(roots, "Model"))
    model_by_id = {node_id(m): m for m in all_models}

    # Build OO connections: only between Model nodes
    conns_node = next((n for n in roots if n.name == "Connections"), None)
    # child → set of parents via OO
    child_to_parents_oo = {}
    all_oo = []
    if conns_node:
        for c in conns_node.children:
            if c.name == "C" and len(c.props) >= 3:
                ctype = c.props[0][1]
                from_id = c.props[1][1]
                to_id = c.props[2][1]
                if ctype == "OO":
                    all_oo.append((from_id, to_id))
                    if from_id not in child_to_parents_oo:
                        child_to_parents_oo[from_id] = []
                    child_to_parents_oo[from_id].append(to_id)

    # Model-to-model parent (hierarchical): parent must also be a Model node
    model_ids = set(model_by_id.keys())
    model_parent = {}
    for from_id, parents in child_to_parents_oo.items():
        if from_id in model_ids:
            for to_id in parents:
                if to_id in model_ids or to_id == 0:
                    model_parent[from_id] = to_id
                    break

    # ── 1. Print target bone properties ───────────────────────────────────────
    TARGET_NAMES = ["arm_joint_L_1", "arm_joint_R_1", "Armature", "Z_UP"]
    print("=" * 70)
    print("BONE PROPERTIES")
    print("=" * 70)
    for m in all_models:
        name = node_name(m)
        mid = node_id(m)
        mtype = m.props[2][1] if len(m.props) >= 3 else "?"
        if not any(t in name for t in TARGET_NAMES): continue
        p70 = get_p70(m)
        lcl_t = p70.get("Lcl Translation", None)
        lcl_r = p70.get("Lcl Rotation", None)
        lcl_s = p70.get("Lcl Scaling", None)
        pre_r = p70.get("PreRotation", None)
        post_r = p70.get("PostRotation", None)
        rot_order_list = p70.get("RotationOrder", [0])
        rot_order = rot_order_list[0] if rot_order_list else 0
        inherit_type = p70.get("InheritType", [0])
        print(f"\n  {name!r}  ID={mid}  Type={mtype}")
        print(f"    LclT      = {fmt_vec(lcl_t)}")
        print(f"    LclR      = {fmt_vec(lcl_r)}")
        print(f"    LclS      = {fmt_vec(lcl_s)}")
        print(f"    PreR      = {fmt_vec(pre_r)}")
        print(f"    PostR     = {fmt_vec(post_r)}")
        print(f"    RotOrder  = {rot_order} ({ROT_ORDER_NAMES.get(rot_order,'?')})")
        print(f"    InheritType = {inherit_type}")

    # ── 2. Print all limb bones with rotOrder & preR ──────────────────────────
    print("\n" + "=" * 70)
    print("ALL LimbNode/Root/Limb bones")
    print("=" * 70)
    for m in all_models:
        mtype = m.props[2][1] if len(m.props) >= 3 else "?"
        if mtype not in ("LimbNode", "Root", "Limb"): continue
        name = node_name(m)
        mid = node_id(m)
        p70 = get_p70(m)
        pre_r = p70.get("PreRotation", None)
        rot_order_list = p70.get("RotationOrder", [0])
        rot_order = rot_order_list[0] if rot_order_list else 0
        lcl_r = p70.get("Lcl Rotation", None)
        lcl_t = p70.get("Lcl Translation", None)
        print(f"  {name!r:40s} ID={mid}  rotOrder={rot_order}({ROT_ORDER_NAMES.get(rot_order,'?')})  preR={fmt_vec(pre_r)}  lclR={fmt_vec(lcl_r)}  lclT={fmt_vec(lcl_t)}")

    # ── 3. Trace hierarchy for arm_joint_L_1 ─────────────────────────────────
    print("\n" + "=" * 70)
    print("HIERARCHY: arm_joint_L_1 (270376567) parent chain")
    print("=" * 70)
    print("  (OO connections from arm_joint_L_1 270376567):")
    parents = child_to_parents_oo.get(270376567, [])
    for pid in parents:
        pm = model_by_id.get(pid)
        pname = node_name(pm) if pm else "non-Model"
        ptype = pm.props[2][1] if pm and len(pm.props) >= 3 else "?"
        print(f"    → {pid}  {pname!r}  ({ptype})")

    print()
    cur_id = 270376567
    for depth in range(15):
        m = model_by_id.get(cur_id)
        if m:
            name = node_name(m)
            mtype = m.props[2][1] if len(m.props) >= 3 else "?"
            p70 = get_p70(m)
            lcl_t = p70.get("Lcl Translation", None)
            lcl_r = p70.get("Lcl Rotation", None)
            lcl_s = p70.get("Lcl Scaling", None)
            pre_r = p70.get("PreRotation", None)
            rot_order_list = p70.get("RotationOrder", [0])
            rot_order = rot_order_list[0] if rot_order_list else 0
            print(f"  {'  '*depth}{name!r} ({mtype}) ID={cur_id}")
            print(f"  {'  '*depth}  T={fmt_vec(lcl_t)}  R={fmt_vec(lcl_r)}  S={fmt_vec(lcl_s)}")
            print(f"  {'  '*depth}  preR={fmt_vec(pre_r)}  rotOrder={rot_order}({ROT_ORDER_NAMES.get(rot_order,'?')})")
        else:
            print(f"  {'  '*depth}Scene Root (id=0)")
            break
        parent_id = model_parent.get(cur_id)
        if parent_id is None or parent_id == 0:
            print(f"  {'  '*depth}  └─ Scene Root (id=0)")
            break
        cur_id = parent_id

    # ── 4. Show ALL OO connections from arm_joint_L_1 and its cluster info ────
    print("\n" + "=" * 70)
    print("ALL OO connections involving arm_joint_L_1 (270376567)")
    print("=" * 70)
    for from_id, to_id in all_oo:
        if from_id == 270376567 or to_id == 270376567:
            fm = model_by_id.get(from_id)
            tm = model_by_id.get(to_id)
            fn = node_name(fm) if fm else f"non-Model({from_id})"
            tn = node_name(tm) if tm else f"non-Model({to_id})"
            ft = fm.props[2][1] if fm and len(fm.props) >= 3 else "?"
            tt = tm.props[2][1] if tm and len(tm.props) >= 3 else "?"
            print(f"  OO: {from_id}({fn},{ft}) → {to_id}({tn},{tt})")

if __name__ == "__main__":
    main()
