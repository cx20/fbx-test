#!/usr/bin/env python3
"""
FBX Binary Parser for RiggedFigure.fbx
Extracts Model nodes, bone properties, AnimationCurveNode connections, and keyframe data.
"""

import struct
import zlib
import sys
import io
from collections import defaultdict

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

# ── low-level reader ──────────────────────────────────────────────────────────

class FBXReader:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.pos = 0
        # parse header
        magic = self.data[:21]
        assert magic == b"Kaydara FBX Binary  \x00", f"Bad magic: {magic!r}"
        # skip 0x1A 0x00
        self.version = struct.unpack_from("<I", self.data, 23)[0]
        print(f"FBX version: {self.version}")
        self.is64 = self.version >= 7500
        self.pos = 27  # after magic(21) + 0x1A + 0x00 + version(4)

    def read(self, n):
        v = self.data[self.pos:self.pos+n]
        self.pos += n
        return v

    def u8(self):  return struct.unpack_from("B", self.data, self.pos)[0]; self.pos += 1
    def read_u8(self):
        v = struct.unpack_from("B", self.data, self.pos)[0]
        self.pos += 1
        return v
    def read_u32(self):
        v = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return v
    def read_u64(self):
        v = struct.unpack_from("<Q", self.data, self.pos)[0]
        self.pos += 8
        return v
    def read_i16(self):
        v = struct.unpack_from("<h", self.data, self.pos)[0]
        self.pos += 2
        return v
    def read_i32(self):
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v
    def read_i64(self):
        v = struct.unpack_from("<q", self.data, self.pos)[0]
        self.pos += 8
        return v
    def read_f32(self):
        v = struct.unpack_from("<f", self.data, self.pos)[0]
        self.pos += 4
        return v
    def read_f64(self):
        v = struct.unpack_from("<d", self.data, self.pos)[0]
        self.pos += 8
        return v

    def read_offset(self):
        return self.read_u64() if self.is64 else self.read_u32()

    def read_array(self, fmt, itemsize):
        count    = self.read_u32()
        encoding = self.read_u32()
        comp_len = self.read_u32()
        if encoding == 1:
            raw = zlib.decompress(self.data[self.pos:self.pos+comp_len])
            self.pos += comp_len
        else:
            raw = self.data[self.pos:self.pos+count*itemsize]
            self.pos += count * itemsize
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
            n = self.read_u32()
            return t, self.data[self.pos:self.pos+n].decode("utf-8","replace"); self.pos += n
        elif t == "R":
            n = self.read_u32()
            v = self.data[self.pos:self.pos+n]; self.pos += n
            return t, v
        else:
            raise ValueError(f"Unknown property type: {t!r} at pos {self.pos-1}")

    # workaround: inline read for string so it actually advances pos
    def _read_string(self):
        n = self.read_u32()
        v = self.data[self.pos:self.pos+n].decode("utf-8","replace")
        self.pos += n
        return v

    def read_property2(self):
        """Read a single property, correctly advancing pos for strings/raw."""
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
            return t, self._read_string()
        elif t == "R":
            n = self.read_u32()
            v = self.data[self.pos:self.pos+n]; self.pos += n
            return t, v
        else:
            raise ValueError(f"Unknown property type: {t!r} at pos {self.pos-1}")

# ── node ─────────────────────────────────────────────────────────────────────

class FBXNode:
    __slots__ = ("name","props","children","end_offset")
    def __init__(self, name, props, children, end_offset):
        self.name       = name
        self.props      = props
        self.children   = children
        self.end_offset = end_offset

NULL_RECORD_SIZE_32 = 13
NULL_RECORD_SIZE_64 = 25

def parse_node(reader):
    end_offset = reader.read_offset()
    num_props  = reader.read_offset()
    prop_list_len = reader.read_offset()
    name_len   = reader.read_u8()
    name       = reader.data[reader.pos:reader.pos+name_len].decode("utf-8","replace")
    reader.pos += name_len

    # null record check
    null_size = NULL_RECORD_SIZE_64 if reader.is64 else NULL_RECORD_SIZE_32
    if end_offset == 0 and num_props == 0 and prop_list_len == 0 and name_len == 0:
        return None

    props = []
    for _ in range(num_props):
        props.append(reader.read_property2())

    children = []
    if reader.pos < end_offset:
        sentinel = null_size
        while reader.pos < end_offset - sentinel:
            child = parse_node(reader)
            if child is None:
                break
            children.append(child)
        # skip sentinel
        reader.pos = end_offset

    return FBXNode(name, props, children, end_offset)


def parse_fbx(path):
    reader = FBXReader(path)
    roots = []
    data_len = len(reader.data)
    null_size = NULL_RECORD_SIZE_64 if reader.is64 else NULL_RECORD_SIZE_32
    while reader.pos < data_len - null_size:
        node = parse_node(reader)
        if node is None:
            break
        roots.append(node)
    return roots, reader.version


# ── helpers ───────────────────────────────────────────────────────────────────

def iter_nodes(nodes, name=None):
    for n in nodes:
        if name is None or n.name == name:
            yield n
        yield from iter_nodes(n.children, name)


def get_p70_props(model_node):
    """Return dict of property-name -> (value...) from P70 Properties70 children."""
    result = {}
    for child in model_node.children:
        if child.name == "Properties70":
            for p in child.children:
                if p.name == "P" and p.props:
                    pname = p.props[0][1] if p.props else ""
                    result[pname] = [v for _, v in p.props[1:]]
    return result


# ── main analysis ─────────────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("Parsing FBX …")
    roots, version = parse_fbx(FBX_PATH)
    print(f"Version {version}  |  top-level nodes: {len(roots)}")
    print()

    # ── 1. Collect all Model nodes ────────────────────────────────────────────
    all_models = list(iter_nodes(roots, "Model"))
    print(f"Total Model nodes: {len(all_models)}")
    print()

    # Determine type from props[2] (index 2 = object type string)
    def model_type(m):
        if len(m.props) >= 3:
            return m.props[2][1]
        return "?"

    def model_name(m):
        raw = m.props[1][1] if len(m.props) >= 2 else "?"
        # FBX names are often "Name\x00\x01Type"
        return raw.split("\x00")[0] if "\x00" in raw else raw

    # Print all models
    print("─" * 70)
    print("SECTION 1 — All Model nodes")
    print("─" * 70)
    for m in all_models:
        uid  = m.props[0][1] if m.props else "?"
        nm   = model_name(m)
        tp   = model_type(m)
        print(f"  [{uid}]  name={nm!r}  type={tp!r}")

    # Filter shoulder/arm/upper
    kw = ("shoulder","arm","upper")
    filtered = [m for m in all_models if any(k in model_name(m).lower() for k in kw)]
    print()
    print("─" * 70)
    print("SECTION 1b — Models with 'shoulder', 'arm', or 'upper' in name")
    print("─" * 70)
    for m in filtered:
        print(f"  name={model_name(m)!r}  type={model_type(m)!r}")

    # ── 2. Bone properties ────────────────────────────────────────────────────
    print()
    print("─" * 70)
    print("SECTION 2 — Bone Model node properties")
    print("─" * 70)
    bone_models = [m for m in all_models if model_type(m) == "LimbNode"]
    print(f"Total LimbNode (bone) models: {len(bone_models)}")
    print()

    bone_props_map = {}  # uid -> dict
    for m in bone_models:
        uid  = m.props[0][1] if m.props else None
        nm   = model_name(m)
        p70  = get_p70_props(m)
        bone_props_map[uid] = {"name": nm, "p70": p70}

        pre_rot  = p70.get("PreRotation",    ["N/A"])
        lcl_rot  = p70.get("LclRotation",    ["N/A"])
        rot_ord  = p70.get("RotationOrder",  ["N/A"])
        lcl_tr   = p70.get("LclTranslation", ["N/A"])

        print(f"  Bone: {nm!r}  (uid={uid})")
        print(f"    PreRotation    : {pre_rot}")
        print(f"    LclRotation    : {lcl_rot}")
        print(f"    RotationOrder  : {rot_ord}")
        print(f"    LclTranslation : {lcl_tr}")
        print()

    # ── 5. Unique RotationOrder values ────────────────────────────────────────
    rot_orders = set()
    for m in all_models:
        p70 = get_p70_props(m)
        ro = p70.get("RotationOrder")
        if ro:
            rot_orders.add(tuple(ro))
    print()
    print("─" * 70)
    print("SECTION 5 — Unique RotationOrder values across all Model nodes")
    print("─" * 70)
    for ro in sorted(rot_orders, key=str):
        print(f"  {ro}")

    # ── 3. AnimationCurveNode connections ─────────────────────────────────────
    # Build uid -> name map for Models and CurveNodes
    uid_to_name = {}
    for m in all_models:
        uid = m.props[0][1] if m.props else None
        uid_to_name[uid] = model_name(m)

    acn_nodes = list(iter_nodes(roots, "AnimationCurveNode"))
    print()
    print("─" * 70)
    print(f"SECTION 3 — AnimationCurveNode list ({len(acn_nodes)} nodes)")
    print("─" * 70)
    acn_map = {}  # uid -> name
    for acn in acn_nodes:
        uid  = acn.props[0][1] if acn.props else None
        nm   = acn.props[1][1] if len(acn.props) > 1 else "?"
        nm   = nm.split("\x00")[0] if "\x00" in nm else nm
        acn_map[uid] = nm
        print(f"  ACN uid={uid}  name={nm!r}")

    # Connections
    conn_nodes = list(iter_nodes(roots, "Connections"))
    print()
    print("─" * 70)
    print("SECTION 3b — AnimationCurveNode → Model connections")
    print("─" * 70)

    # connections: OO or OP
    acn_to_model   = defaultdict(list)  # acn_uid -> [(model_uid, prop_name)]
    curve_to_acn   = defaultdict(list)  # curve_uid -> [(acn_uid, channel)]

    for cn in conn_nodes:
        for c in cn.children:
            if c.name != "C":
                continue
            ctype = c.props[0][1] if c.props else ""
            if ctype == "OO":
                src = c.props[1][1] if len(c.props) > 1 else None
                dst = c.props[2][1] if len(c.props) > 2 else None
                if src in acn_map and dst in uid_to_name:
                    acn_to_model[src].append((dst, "OO"))
            elif ctype == "OP":
                src  = c.props[1][1] if len(c.props) > 1 else None
                dst  = c.props[2][1] if len(c.props) > 2 else None
                prop = c.props[3][1] if len(c.props) > 3 else ""
                if src in acn_map and dst in uid_to_name:
                    acn_to_model[src].append((dst, prop))

    for acn_uid, targets in sorted(acn_to_model.items(), key=lambda x: str(x[0])):
        acn_nm = acn_map.get(acn_uid, "?")
        for (mdl_uid, prop) in targets:
            mdl_nm = uid_to_name.get(mdl_uid, f"uid:{mdl_uid}")
            print(f"  ACN {acn_nm!r} (uid={acn_uid}) → Model {mdl_nm!r} prop={prop!r}")

    # ── 4. Keyframe data for shoulder/arm bone CurveNodes ─────────────────────
    print()
    print("─" * 70)
    print("SECTION 4 — Keyframe data for shoulder/arm rotation CurveNodes")
    print("─" * 70)

    # find ACN uids that connect to shoulder/arm bones with Lcl Rotation
    target_acn_uids = set()
    kw_set = {"shoulder","arm","upper"}
    for acn_uid, targets in acn_to_model.items():
        acn_nm = acn_map.get(acn_uid, "")
        if "Rotation" not in acn_nm and "rotation" not in acn_nm:
            continue
        for (mdl_uid, prop) in targets:
            mdl_nm = uid_to_name.get(mdl_uid, "").lower()
            if any(k in mdl_nm for k in kw_set):
                target_acn_uids.add(acn_uid)

    # Also collect AnimationCurve nodes and their connection to ACNs
    ac_nodes = list(iter_nodes(roots, "AnimationCurve"))
    ac_map   = {}  # uid -> node
    for ac in ac_nodes:
        uid = ac.props[0][1] if ac.props else None
        ac_map[uid] = ac

    # Build curve→acn map from Connections
    curve_to_acn_channel = defaultdict(list)  # curve_uid -> [(acn_uid, channel_prop)]
    for cn in conn_nodes:
        for c in cn.children:
            if c.name != "C":
                continue
            ctype = c.props[0][1] if c.props else ""
            if ctype == "OP":
                src  = c.props[1][1] if len(c.props) > 1 else None
                dst  = c.props[2][1] if len(c.props) > 2 else None
                prop = c.props[3][1] if len(c.props) > 3 else ""
                if src in ac_map and dst in acn_map:
                    curve_to_acn_channel[src].append((dst, prop))

    # For each target ACN, find associated curves (X, Y, Z channels)
    if not target_acn_uids:
        print("  (No shoulder/arm rotation CurveNodes found via connections)")
        print("  Trying to find by ACN name pattern …")
        for acn_uid, acn_nm in acn_map.items():
            if "Rotation" in acn_nm or "rotation" in acn_nm:
                target_acn_uids.add(acn_uid)
        print(f"  Found {len(target_acn_uids)} rotation ACNs total")

    # group curves by their ACN
    acn_to_curves = defaultdict(dict)  # acn_uid -> {channel: curve_node}
    for curve_uid, conns in curve_to_acn_channel.items():
        for (acn_uid, channel) in conns:
            acn_to_curves[acn_uid][channel] = curve_uid

    def show_keyframes(curve_uid, label):
        ac = ac_map.get(curve_uid)
        if ac is None:
            print(f"    {label}: curve not found (uid={curve_uid})")
            return
        # KeyValueFloat child
        times  = None
        values = None
        for child in ac.children:
            if child.name == "KeyTime":
                times  = child.props[0][1] if child.props else []
            if child.name == "KeyValueFloat":
                values = child.props[0][1] if child.props else []
        if values is None:
            print(f"    {label}: no KeyValueFloat found")
            return
        total = len(values)
        first5 = values[:5]
        last5  = values[-5:] if total >= 5 else values
        print(f"    {label} ({total} keyframes):")
        print(f"      first 5: {[round(v,6) for v in first5]}")
        print(f"      last  5: {[round(v,6) for v in last5]}")
        if times:
            t_first5 = times[:5]
            t_last5  = times[-5:] if len(times) >= 5 else times
            # FBX time unit = 1/46186158000 seconds (but often shown as frames)
            def fbx_time_to_frame(t, fps=30):
                return round(t / 46186158000 * fps, 2)
            print(f"      first 5 times (frames@30fps): {[fbx_time_to_frame(t) for t in t_first5]}")
            print(f"      last  5 times (frames@30fps): {[fbx_time_to_frame(t) for t in t_last5]}")

    for acn_uid in sorted(target_acn_uids, key=str):
        acn_nm = acn_map.get(acn_uid, "?")
        # find which model this connects to
        tgts = acn_to_model.get(acn_uid, [])
        mdl_names = [uid_to_name.get(mu, f"uid:{mu}") for (mu,_) in tgts]
        print(f"\n  ACN: {acn_nm!r} (uid={acn_uid}) → bones: {mdl_names}")
        curves = acn_to_curves.get(acn_uid, {})
        if not curves:
            print("    (no AnimationCurve children found)")
            continue
        for channel in sorted(curves.keys()):
            show_keyframes(curves[channel], channel)

    print()
    print("=" * 70)
    print("Done.")


if __name__ == "__main__":
    main()
