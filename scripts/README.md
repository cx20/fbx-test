# scripts/

Diagnostic and analysis scripts collected during the investigation of the
Babylon.js custom FBX loader. They are **not** part of the runtime — they exist
to help future contributors reproduce findings documented in
[example/babylonjs/README.md](../example/babylonjs/README.md).

Most scripts target a single FBX file and print structured information about
its contents. They are kept intentionally simple (each is a single file with
an inlined FBX parser) so that anyone can copy one and adapt it without
needing a build step.

## Prerequisites

| Tool | Used by |
|---|---|
| **Python 3.10+** | All `*.py` scripts |
| `numpy` | `check_hierarchy_vs_tl.py`, `verify_fix.py` |
| **Node.js 20+** | All `*.js` scripts |
| `playwright` (`npm i playwright && npx playwright install chromium`) | `compare_viewers.js`, `check_mesh_parent.js` |
| A local static server on `http://127.0.0.1:5500/` serving the repo root | `compare_viewers.js`, `check_mesh_parent.js` |

Run scripts from the repo root:

```bash
python scripts/analyze_simpleskin.py
node scripts/compare_viewers.js gltf/RiggedFigure 1.0 "Armature|Anim_0.002"
```

The Python scripts resolve their FBX path relative to the script file, so the
working directory does not strictly matter — but running from the repo root
keeps output paths consistent.

## Inventory

### Headless viewer comparison

| Script | Purpose |
|---|---|
| [`compare_viewers.js`](compare_viewers.js) | Open the Three.js and Babylon.js viewers in headless Chromium under matching URL parameters, save screenshots to `scripts/screenshots/`. CLI: `node compare_viewers.js <model> [time] [clip]`. |
| [`check_mesh_parent.js`](check_mesh_parent.js) | Dump the BJS scene-graph parent chain and world matrix of the skinned mesh, used when investigating the `mesh.world` × `bone matrix` ordering issue. |

### Per-model structural analysis

| Script | Target FBX | Purpose |
|---|---|---|
| [`analyze_simpleskin.py`](analyze_simpleskin.py) | `gltf/SimpleSkin.fbx` | Dump models, geometries, deformers (skin/cluster), animation stacks, and connections. |
| [`analyze_simpleskin_anim.py`](analyze_simpleskin_anim.py) | `gltf/SimpleSkin.fbx` | Dump every animated channel grouped by target model. |
| [`analyze_riggedsimple.py`](analyze_riggedsimple.py) | `gltf/RiggedSimple.fbx` | Same shape of analysis for RiggedSimple. |
| [`debug_fbx.py`](debug_fbx.py) | `gltf/RiggedFigure.fbx` | Quick structure inspection helper. |
| [`parse_fbx.py`](parse_fbx.py) / [`parse_fbx2.py`](parse_fbx2.py) | `gltf/RiggedFigure.fbx` | Generic FBX dumpers (kept for historical reference; superseded by the focused `check_*.py` scripts). |

### Bind-pose / skinning diagnostics for `gltf/RiggedFigure`

These all target the long-standing shoulder-ROM issue (see
[example/babylonjs/README.md](../example/babylonjs/README.md#known-issues)).

| Script | Purpose |
|---|---|
| [`check_props70_vs_tl.py`](check_props70_vs_tl.py) | Compare the world matrix derived from the `Properties70` ancestor chain (including `Z_UP`/`Armature`) against the FBX `TransformLink` for `arm_joint_L_1`. Establishes that the file's "current pose" differs from the bind pose. |
| [`check_hierarchy_vs_tl.py`](check_hierarchy_vs_tl.py) | Same comparison but using animation-curve values at `t=0` instead of `Properties70`. |
| [`check_bone_props.py`](check_bone_props.py) | Extract `PreRotation` / `RotationOrder` / `LclRotation` of every bone. |
| [`check_bone_chain.py`](check_bone_chain.py) | Verify the bone → cluster connection direction and confirm `arm_joint_L_1` is bound as a `Model/LimbNode`. |
| [`compare_bind_matrices.py`](compare_bind_matrices.py) | Compute the hierarchy-derived BJS bind matrix and compare against the BJS-coordinate `TransformLink`. |
| [`verify_fix.py`](verify_fix.py) | Numerical check of a candidate `inv_bind` correction (`invTL × prefix_bjs == chain_bind⁻¹`). |

### Animation channel diagnostics

| Script | Purpose |
|---|---|
| [`check_arm_anim.py`](check_arm_anim.py) | Dump `arm_joint_L_1`'s animation curves in `Armature\|Anim_0.002` — keyframes, ranges, interpolation flags. |
| [`check_armature_anim.py`](check_armature_anim.py) | Same for the `Armature` node itself (verifies whether the rig root is animated). |
| [`check_torso_anim.py`](check_torso_anim.py) | List every bone with an animation channel + skinning cluster — useful for spotting bridge bones that lack one or the other. |
| [`check_acn_layer.py`](check_acn_layer.py) | Trace a specific `AnimationCurveNode` → `AnimationLayer` → `AnimationStack` connection chain. |
| [`check_connections.py`](check_connections.py) | Dump every `Connections` row involving a given object id (useful for understanding FBX cross-references). |

### Coordinate-system & global state

| Script | Purpose |
|---|---|
| [`check_global_settings.py`](check_global_settings.py) | Read `GlobalSettings` (`UpAxis`, `FrontAxis`, `CoordAxis`, `UnitScaleFactor`, `OriginalUpAxis`) — needed to understand how Blender's Z-up source ended up in a Y-up FBX. |

## Patterns

All Python scripts share a minimal binary FBX parser inlined as classes `R` and
`N` (reader and node). It supports:

- 16-bit (legacy) and 64-bit FBX offsets (version 7500+)
- Zlib-compressed and raw property arrays
- All standard FBX scalar/array property types
- Tree traversal via `iter_nodes(roots, name=None)` and `find_child(node, name)`

To write a new diagnostic, copy the parser block from any `check_*.py` and add
your specific traversal logic at the bottom.
