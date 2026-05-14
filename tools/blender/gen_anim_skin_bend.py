"""
gen_anim_skin_bend.py
=====================
Generates: assets/models/fbx/test/anim_skin_bend.fbx

Test: Basic 2-bone skinned mesh animation
  - 1m cylinder split evenly between LowerBone and UpperBone
  - UpperBone bends 0° → 90° → 0° over 60 frames (2 seconds at 30fps)

Expected visual result:
  CORRECT:   cylinder bends like an elbow — smooth deformation, no vertex artefacts
  INCORRECT: vertices fly away or upper half stays frozen

Run:
  blender --background --python gen_anim_skin_bend.py
"""

import bpy
import math
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.normpath(
    os.path.join(SCRIPT_DIR, '../../assets/models/fbx/test/anim_skin_bend.fbx')
)

# ── Scene reset ──────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = 60

# ── Armature: 2 bones (each 0.5 m = 50 FBX units) ────────────────────────────
bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.active_object
arm.name = 'ArmArmature'

bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones

b1 = eb[0]
b1.name = 'LowerBone'
b1.head = (0.0, 0.0, 0.0)
b1.tail = (0.0, 0.0, 0.5)   # first half

b2 = eb.new('UpperBone')
b2.parent = b1
b2.use_connect = True
b2.head = (0.0, 0.0, 0.5)
b2.tail = (0.0, 0.0, 1.0)   # second half

bpy.ops.object.mode_set(mode='OBJECT')

# ── Mesh: 1m cylinder (local Z = -0.5..+0.5, mesh centre at Z=0.5 world) ─────
bpy.ops.mesh.primitive_cylinder_add(
    radius=0.08, depth=1.0, vertices=16,
    location=(0.0, 0.0, 0.5),
    end_fill_type='NGON',
)
cyl = bpy.context.active_object
cyl.name = 'Arm'

# Manual vertex weights: local z < 0 → LowerBone, local z >= 0 → UpperBone
vg_lower = cyl.vertex_groups.new(name='LowerBone')
vg_upper = cyl.vertex_groups.new(name='UpperBone')
for v in cyl.data.vertices:
    if v.co.z < 0.0:
        vg_lower.add([v.index], 1.0, 'REPLACE')
    else:
        vg_upper.add([v.index], 1.0, 'REPLACE')

# Parent cylinder to armature (ARMATURE type uses vertex groups)
cyl.parent = arm
cyl.parent_type = 'ARMATURE'

# ── Add armature modifier (required for skinning at render/export time) ────────
mod = cyl.modifiers.new(name='Armature', type='ARMATURE')
mod.object = arm

# ── Keyframes: UpperBone bends around X ──────────────────────────────────────
bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')

pb2 = arm.pose.bones['UpperBone']
pb2.rotation_mode = 'XYZ'

for frame, x_deg in [(1, 0.0), (30, 90.0), (60, 0.0)]:
    scene.frame_set(frame)
    pb2.rotation_euler = (math.radians(x_deg), 0.0, 0.0)
    pb2.keyframe_insert(data_path='rotation_euler')

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
