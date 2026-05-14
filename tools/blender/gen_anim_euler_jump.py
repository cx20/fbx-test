"""
gen_anim_euler_jump.py
======================
Generates: assets/models/fbx/test/anim_euler_jump.fbx

Test: Euler ±180° crossing (Euler jump)
  - 1 bone with 3 sparse keyframes:
      Frame  1: Y =   0°
      Frame 11: Y = 175°
      Frame 21: Y = -175°  ← Euler jump: 350° in Euler space, but only 10° actual rotation
  - FBX has LINEAR interpolation between keyframes.

Expected visual result:
  CORRECT  (quaternion slerp): bone barely moves between frame 11-21 (10° arc)
  INCORRECT (linear Euler):    bone sweeps 350° in the wrong direction

Run:
  blender --background --python gen_anim_euler_jump.py
"""

import bpy
import math
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.normpath(
    os.path.join(SCRIPT_DIR, '../../assets/models/fbx/test/anim_euler_jump.fbx')
)

# ── Scene reset ──────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = 21

# ── Armature: 1 bone pointing up (+Z → +Y in FBX) ────────────────────────────
bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.active_object
arm.name = 'EulerJumpArm'

bpy.ops.object.mode_set(mode='EDIT')
bone = arm.data.edit_bones[0]
bone.name = 'Bone'
bone.head = (0.0, 0.0, 0.0)
bone.tail = (0.0, 0.0, 0.5)   # 0.5 m → 50 FBX units
bpy.ops.object.mode_set(mode='OBJECT')

# ── Arrow mesh: horizontal bar to make the Y-rotation clearly visible ─────────
# The bar lies along X so rotating around Y (the bone's up axis after export)
# visibly sweeps the bar left/right.
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.25))
bar = bpy.context.active_object
bar.name = 'EulerJumpBar'
bar.scale = (0.4, 0.04, 0.04)
bpy.ops.object.transform_apply(scale=True)

# Assign all vertices to the bone
vg = bar.vertex_groups.new(name='Bone')
vg.add(list(range(len(bar.data.vertices))), 1.0, 'REPLACE')

# Parent bar to armature and add armature modifier (required for FBX skinning export)
bar.parent = arm
bar.parent_type = 'ARMATURE'
mod = bar.modifiers.new(name='Armature', type='ARMATURE')
mod.object = arm

# ── Keyframes ─────────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')

pb = arm.pose.bones['Bone']
pb.rotation_mode = 'XYZ'

for frame, y_deg in [(1, 0.0), (11, 175.0), (21, -175.0)]:
    scene.frame_set(frame)
    pb.rotation_euler = (0.0, math.radians(y_deg), 0.0)
    pb.keyframe_insert(data_path='rotation_euler')

# Force LINEAR interpolation so the FBX also uses linear between sparse keys.
# Blender 5.0+ uses Layered Actions: fcurves live inside channelbags.
def iter_fcurves(obj):
    action = obj.animation_data.action
    if hasattr(action, 'fcurves'):          # Blender < 5.0 (legacy action)
        yield from action.fcurves
    else:                                   # Blender 5.0+ (layered action)
        for layer in action.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    yield from cb.fcurves

for fc in iter_fcurves(arm):
    for kp in fc.keyframe_points:
        kp.interpolation = 'LINEAR'

bpy.ops.object.mode_set(mode='OBJECT')

# ── Export ────────────────────────────────────────────────────────────────────
# bake_anim_step=10 → samples at frames 1, 11, 21 (3 sparse keyframes)
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
bpy.ops.export_scene.fbx(
    filepath=OUTPUT,
    use_selection=False,
    object_types={'MESH', 'ARMATURE'},
    bake_anim=True,
    bake_anim_use_nla_strips=False,
    bake_anim_use_all_actions=False,
    bake_anim_simplify_factor=0.0,
    bake_anim_step=10.0,
    add_leaf_bones=False,
)

# ── Binary patch: replace 185.0 → -175.0 in Y-rotation curve ─────────────────
# Blender's FBX bake wraps -175° to 185° to minimise angular differences,
# which defeats the Euler-jump test intent.  We patch the raw float32 in the
# exported binary so the third keyframe is truly -175°.
import struct

old_val = struct.pack('<f', 185.0)
new_val = struct.pack('<f', -175.0)

with open(OUTPUT, 'rb') as f:
    data = f.read()

count = data.count(old_val)
if count == 0:
    print('[WARN] 185.0 not found in FBX — skipping patch')
elif count > 1:
    print(f'[WARN] 185.0 found {count} times — patching all occurrences')
    data = data.replace(old_val, new_val)
    with open(OUTPUT, 'wb') as f:
        f.write(data)
    print(f'[OK] Patched {count} occurrences: 185.0 → -175.0')
else:
    data = data.replace(old_val, new_val)
    with open(OUTPUT, 'wb') as f:
        f.write(data)
    print('[OK] Patched 185.0 → -175.0 in Y-rotation curve')

print(f'[OK] {OUTPUT}')
