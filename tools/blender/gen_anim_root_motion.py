"""
gen_anim_root_motion.py
=======================
Generates: assets/models/fbx/test/anim_root_motion.fbx

Test: Root bone translation and rotation
  - RootBone translates from X=0 to X=+1m (= 100 FBX units) over 60 frames
    while rotating 360° around Y.
  - ChildBone stays at 45° bend throughout.
  - A box mesh is fully weighted to RootBone.

Expected visual result:
  CORRECT:   box moves to the right while spinning, child visible as overhang
  INCORRECT: box stays at origin or moves in wrong direction

Run:
  blender --background --python gen_anim_root_motion.py
"""

import bpy
import math
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.normpath(
    os.path.join(SCRIPT_DIR, '../../assets/models/fbx/test/anim_root_motion.fbx')
)

# ── Scene reset ──────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = 60

# ── Armature: RootBone + ChildBone ────────────────────────────────────────────
bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.active_object
arm.name = 'RootArm'

bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones

root = eb[0]
root.name = 'RootBone'
root.head = (0.0, 0.0, 0.0)
root.tail = (0.0, 0.0, 0.4)   # 0.4 m = 40 FBX units

child = eb.new('ChildBone')
child.parent = root
child.use_connect = True
child.head = (0.0, 0.0, 0.4)
child.tail = (0.0, 0.0, 0.8)

bpy.ops.object.mode_set(mode='OBJECT')

# ── Mesh: elongated box along the armature ────────────────────────────────────
bpy.ops.mesh.primitive_cube_add(size=1, location=(0.0, 0.0, 0.4))
box = bpy.context.active_object
box.name = 'RootBox'
box.scale = (0.12, 0.12, 0.8)
bpy.ops.object.transform_apply(scale=True)

# All verts → RootBone (box moves with the root)
vg_root = box.vertex_groups.new(name='RootBone')
vg_root.add(list(range(len(box.data.vertices))), 1.0, 'REPLACE')

# Also add ChildBone group (empty — required so the exporter includes it)
box.vertex_groups.new(name='ChildBone')

box.parent = arm
box.parent_type = 'ARMATURE'
mod = box.modifiers.new(name='Armature', type='ARMATURE')
mod.object = arm

# ── Keyframes ─────────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')

pb_root = arm.pose.bones['RootBone']
pb_root.rotation_mode = 'XYZ'

pb_child = arm.pose.bones['ChildBone']
pb_child.rotation_mode = 'XYZ'

for frame in range(1, 61):
    scene.frame_set(frame)
    t = (frame - 1) / 59.0   # 0..1

    # RootBone: translate along X and spin around Z
    pb_root.location = (t * 1.0, 0.0, 0.0)     # X: 0→1 m in armature space
    pb_root.rotation_euler = (0.0, 0.0, math.radians(t * 360.0))
    pb_root.keyframe_insert(data_path='location')
    pb_root.keyframe_insert(data_path='rotation_euler')

    # ChildBone: fixed 45° bend
    pb_child.rotation_euler = (math.radians(45.0), 0.0, 0.0)
    if frame == 1:
        pb_child.keyframe_insert(data_path='rotation_euler')

bpy.ops.object.mode_set(mode='OBJECT')

# ── Export ────────────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
bpy.ops.export_scene.fbx(
    filepath=OUTPUT,
    use_selection=False,
    object_types={'MESH', 'ARMATURE'},
    bake_anim=True,
    bake_anim_use_nla_strips=False,
    bake_anim_use_all_actions=False,
    bake_anim_simplify_factor=0.0,
    bake_anim_step=1.0,
    add_leaf_bones=False,
)
print(f'[OK] {OUTPUT}')
