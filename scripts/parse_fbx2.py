#!/usr/bin/env python3
"""
FBX Binary Parser v2 for RiggedFigure.fbx — corrected after structure debug.
"""
import struct, zlib, sys, io
from collections import defaultdict
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import os
FBX_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "fbx", "gltf", "RiggedFigure.fbx")

# ── reader ─────────────────────────────────────────────────────────────────────
class FBXReader:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        magic = self.data[:21]
        assert magic == b"Kaydara FBX Binary  \x00", f"Bad magic: {magic!r}"
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
    __slots__ = ("name","props","children")
    def __init__(self, name, props, children):
        self.name=name; self.props=props; self.children=children

def parse_node(reader):
    end_offset    = reader.read_offset()
    num_props     = reader.read_offset()
    prop_list_len = reader.read_offset()
    name_len      = reader.read_u8()
    name = reader.data[reader.pos:reader.pos+name_len].decode("utf-8","replace")
    reader.pos += name_len
    null_size = NULL_RECORD_SIZE_64 if reader.is64 else NULL_RECORD_SIZE_32
    if end_offset == 0 and num_props == 0 and prop_list_len == 0 and name_len == 0:
        return None
    props = [reader.read_property() for _ in range(num_props)]
    children = []
    if reader.pos < end_offset:
        while reader.pos < end_offset - null_size:
            child = parse_node(reader)
            if child is None: break
            children.append(child)
        reader.pos = end_offset
    return FBXNode(name, props, children)

def parse_fbx(path):
    reader = FBXReader(path)
    roots = []
    null_size = NULL_RECORD_SIZE_64 if reader.is64 else NULL_RECORD_SIZE_32
    while reader.pos < len(reader.data) - null_size:
        node = parse_node(reader)
        if node is None: break
        roots.append(node)
    return roots, reader.version

def iter_nodes(nodes, name=None):
    for n in nodes:
        if name is None or n.name == name: yield n
        yield from iter_nodes(n.children, name)

def fbx_name(raw):
    """Strip the \x00\x01Type suffix FBX appends to object names."""
    return raw.split("\x00")[0] if "\x00" in raw else raw

def get_p70(model_node):
    """Return dict propname -> list-of-values from Properties70 P children."""
    result = {}
    for child in model_node.children:
        if child.name == "Properties70":
            for p in child.children:
                if p.name == "P" and p.props:
                    key = p.props[0][1]          # first prop is the property name string
                    vals = [v for _, v in p.props[4:]]  # values start at index 4
                    result[key] = vals
    return result

def fmt_xyz(vals):
    if not vals:
        return "N/A"
    if len(vals) >= 3:
        return f"({vals[0]:.6f}, {vals[1]:.6f}, {vals[2]:.6f})"
    return str(vals)

def fbx_time_to_frame(t, fps=30):
    return round(t / 46186158000 * fps, 3)

# ── parse ──────────────────────────────────────────────────────────────────────
print("=" * 72)
print("Parsing FBX …")
roots, version = parse_fbx(FBX_PATH)
print(f"Version {version}  |  top-level nodes: {len(roots)}")
print()

# ── collect objects ────────────────────────────────────────────────────────────
all_models  = list(iter_nodes(roots, "Model"))
acn_nodes   = list(iter_nodes(roots, "AnimationCurveNode"))
ac_nodes    = list(iter_nodes(roots, "AnimationCurve"))
conn_nodes  = list(iter_nodes(roots, "Connections"))

uid_to_model = {}   # uid -> FBXNode
uid_to_acn   = {}   # uid -> FBXNode
uid_to_ac    = {}   # uid -> FBXNode

for m in all_models:
    uid = m.props[0][1]
    uid_to_model[uid] = m

for acn in acn_nodes:
    uid = acn.props[0][1]
    uid_to_acn[uid] = acn

for ac in ac_nodes:
    uid = ac.props[0][1]
    uid_to_ac[uid] = ac

def model_name(m):
    return fbx_name(m.props[1][1]) if len(m.props) >= 2 else "?"
def model_type(m):
    return m.props[2][1] if len(m.props) >= 3 else "?"
def acn_name_short(acn):
    # name is "T\x00\x01AnimCurveNode" → short label T/R/S
    return fbx_name(acn.props[1][1]) if len(acn.props) >= 2 else "?"

# ── connections ────────────────────────────────────────────────────────────────
# OO: generic object→object parent connection
# OP: object→object with property name (used for ACN→Model property binding)
oo_src_to_dst = defaultdict(list)   # uid -> [dst_uid]
op_connections = []                  # list of (src_uid, dst_uid, prop_name)

for cn in conn_nodes:
    for c in cn.children:
        if c.name != "C" or not c.props: continue
        ctype = c.props[0][1]
        src   = c.props[1][1] if len(c.props) > 1 else None
        dst   = c.props[2][1] if len(c.props) > 2 else None
        prop  = c.props[3][1] if len(c.props) > 3 else ""
        if ctype == "OO":
            oo_src_to_dst[src].append(dst)
        elif ctype == "OP":
            op_connections.append((src, dst, prop))

# ACN → Model (OP connections where src is ACN, dst is Model, prop is Lcl *)
acn_to_model_prop = defaultdict(list)  # acn_uid -> [(model_uid, prop_str)]
# AnimationCurve → ACN (OP connections where src is AC, dst is ACN, prop is d|X/Y/Z)
ac_to_acn_channel = defaultdict(list)  # ac_uid -> [(acn_uid, channel)]

for src, dst, prop in op_connections:
    if src in uid_to_acn and dst in uid_to_model:
        acn_to_model_prop[src].append((dst, prop))
    elif src in uid_to_ac and dst in uid_to_acn:
        ac_to_acn_channel[src].append((dst, prop))

# Build reverse: acn_uid → {channel: ac_uid}
acn_to_channels = defaultdict(dict)   # acn_uid -> {"d|X": ac_uid, ...}
for ac_uid, conns in ac_to_acn_channel.items():
    for (acn_uid, channel) in conns:
        acn_to_channels[acn_uid][channel] = ac_uid

# ═══════════════════════════════════════════════════════════════════════════════
print("=" * 72)
print("SECTION 1 — All Model nodes")
print("=" * 72)
for m in all_models:
    uid = m.props[0][1]
    print(f"  [{uid:>12}]  name={model_name(m)!r:30s}  type={model_type(m)!r}")

kw = ("shoulder","arm","upper")
filtered = [m for m in all_models if any(k in model_name(m).lower() for k in kw)]
print()
print("─" * 72)
print("SECTION 1b — Models with 'shoulder', 'arm', or 'upper' in name")
print("─" * 72)
for m in filtered:
    print(f"  name={model_name(m)!r:30s}  type={model_type(m)!r}")

# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("SECTION 2 — Bone (LimbNode) properties")
print("=" * 72)

bone_models = [m for m in all_models if model_type(m) == "LimbNode"]
print(f"Total LimbNode bones: {len(bone_models)}")
print()

all_rot_orders = set()

for m in bone_models:
    uid = m.props[0][1]
    nm  = model_name(m)
    p70 = get_p70(m)
    pre_rot = p70.get("PreRotation")
    lcl_rot = p70.get("LclRotation")
    rot_ord = p70.get("RotationOrder")
    lcl_tr  = p70.get("LclTranslation")

    if rot_ord:
        all_rot_orders.add(tuple(rot_ord))

    print(f"  Bone: {nm!r}  (uid={uid})")
    print(f"    PreRotation    : {fmt_xyz(pre_rot) if pre_rot else 'not set'}")
    print(f"    LclRotation    : {fmt_xyz(lcl_rot) if lcl_rot else 'not set'}")
    if rot_ord:
        # RotationOrder: 0=XYZ, 1=XZY, 2=YZX, 3=YXZ, 4=ZXY, 5=ZYX, 6=SphericXYZ
        order_names = {0:"XYZ",1:"XZY",2:"YZX",3:"YXZ",4:"ZXY",5:"ZYX",6:"Spheric"}
        ro_val = rot_ord[0] if rot_ord else "?"
        ro_name = order_names.get(ro_val, str(ro_val))
        print(f"    RotationOrder  : {ro_val} ({ro_name})")
    else:
        print(f"    RotationOrder  : not set (default XYZ=0)")
    print(f"    LclTranslation : {fmt_xyz(lcl_tr) if lcl_tr else 'not set'}")
    print()

# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("SECTION 5 — Unique RotationOrder values across all Model nodes")
print("=" * 72)
# Also check non-bone models
for m in all_models:
    p70 = get_p70(m)
    ro = p70.get("RotationOrder")
    if ro:
        all_rot_orders.add(tuple(ro))

order_names = {0:"XYZ",1:"XZY",2:"YZX",3:"YXZ",4:"ZXY",5:"ZYX",6:"Spheric"}
if all_rot_orders:
    for ro in sorted(all_rot_orders):
        ro_val = ro[0]
        print(f"  RotationOrder = {ro_val} ({order_names.get(ro_val, 'unknown')})")
else:
    print("  (None explicitly set — all default to XYZ = 0)")

# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("SECTION 3 — AnimationCurveNode list and Model connections")
print("=" * 72)
print(f"Total AnimationCurveNodes: {len(acn_nodes)}")
print(f"Total AnimationCurves    : {len(ac_nodes)}")
print()
print("ACN → Model connections (all):")
print("-" * 72)

# Sort by bone name then ACN short name
conn_list = []
for acn_uid, targets in acn_to_model_prop.items():
    acn_short = acn_name_short(uid_to_acn[acn_uid])
    for (mdl_uid, prop) in targets:
        mdl_nm = model_name(uid_to_model[mdl_uid])
        conn_list.append((mdl_nm, acn_short, acn_uid, mdl_uid, prop))

conn_list.sort()
for (mdl_nm, acn_short, acn_uid, mdl_uid, prop) in conn_list:
    print(f"  ACN '{acn_short}' (uid={acn_uid}) → '{mdl_nm}' [{prop}]")

# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("SECTION 4 — Keyframe data for arm bone Rotation CurveNodes")
print("=" * 72)

# Find all rotation ACNs (name == "R") that drive arm_ bones
arm_rot_acns = []
for acn_uid, targets in acn_to_model_prop.items():
    acn = uid_to_acn[acn_uid]
    acn_short = acn_name_short(acn)
    if acn_short != "R":
        continue
    for (mdl_uid, prop) in targets:
        if prop != "Lcl Rotation":
            continue
        mdl_nm = model_name(uid_to_model[mdl_uid])
        if any(k in mdl_nm.lower() for k in ("arm","shoulder","upper")):
            arm_rot_acns.append((mdl_nm, acn_uid))

arm_rot_acns.sort()
print(f"Arm rotation ACNs found: {len(arm_rot_acns)}")

def get_curve_keyframes(ac_uid):
    ac = uid_to_ac.get(ac_uid)
    if ac is None:
        return None, None
    times  = None
    values = None
    for child in ac.children:
        if child.name == "KeyTime"       and child.props: times  = child.props[0][1]
        if child.name == "KeyValueFloat" and child.props: values = child.props[0][1]
    return times, values

for (mdl_nm, acn_uid) in arm_rot_acns:
    acn = uid_to_acn[acn_uid]
    # Also get default values from Properties70 d|X d|Y d|Z
    acn_p70 = get_p70(acn)
    dx = acn_p70.get("d|X", [None])[0]
    dy = acn_p70.get("d|Y", [None])[0]
    dz = acn_p70.get("d|Z", [None])[0]

    print()
    print(f"  Bone: {mdl_nm!r}  ACN uid={acn_uid}")
    print(f"    Default (base) values: X={dx}  Y={dy}  Z={dz}")

    channels = acn_to_channels.get(acn_uid, {})
    for channel in ("d|X", "d|Y", "d|Z"):
        axis = channel.split("|")[1]
        ac_uid = channels.get(channel)
        if ac_uid is None:
            print(f"    {axis}: no AnimationCurve connected (static = default value)")
            continue
        times, values = get_curve_keyframes(ac_uid)
        if values is None:
            print(f"    {axis}: AnimationCurve found but no KeyValueFloat")
            continue
        total = len(values)
        first5 = values[:5]
        last5  = values[max(0,total-5):]
        print(f"    {axis} axis (ac_uid={ac_uid})  total={total} keyframes:")
        print(f"      first 5 values : {[round(v,6) for v in first5]}")
        print(f"      last  5 values : {[round(v,6) for v in last5]}")
        if times:
            tf = [fbx_time_to_frame(t) for t in times[:5]]
            tl = [fbx_time_to_frame(t) for t in times[max(0,total-5):]]
            print(f"      first 5 frames (@30fps): {tf}")
            print(f"      last  5 frames (@30fps): {tl}")

print()
print("=" * 72)
print("Done.")
