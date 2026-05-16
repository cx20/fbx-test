# glTF → FBX Converted Samples

This directory contains FBX files converted from glTF sample models using
Blender. They are used to verify cross-format compatibility — whether an FBX
loader can correctly handle assets that were originally authored as glTF and
round-tripped through Blender's FBX exporter.

Source repository: [cx20/gltf-test](https://github.com/cx20/gltf-test)

---

## AnimatedTriangle.fbx

| Item | Value |
|------|-------|
| Source | `tutorialModels/AnimatedTriangle/glTF/AnimatedTriangle.gltf` |
| Content | Single triangle mesh with a simple scale/translation animation |
| Skeleton | None |
| Purpose | Minimal animation test — no bones, no skinning |

---

## SimpleSkin.fbx

| Item | Value |
|------|-------|
| Source | `tutorialModels/SimpleSkin/glTF/SimpleSkin.gltf` |
| Content | Flat 2×5 vertex plane that bends around the middle joint |
| Skeleton | Yes (2 bones: `Node_1` → `Node_2`) |
| Purpose | Minimal skinning test — the simplest possible weighted skin |

---

## RiggedSimple.fbx

| Item | Value |
|------|-------|
| Source | `sampleModels/RiggedSimple/glTF-Binary/RiggedSimple.glb` |
| Content | Simple geometric shape with a 2-bone rig |
| Skeleton | Yes (2 bones) |
| Purpose | Basic skinning test with a minimal rigged mesh |

---

## RiggedFigure.fbx

| Item | Value |
|------|-------|
| Source | `sampleModels/RiggedFigure/glTF-Binary/RiggedFigure.glb` |
| Content | Humanoid stick figure with a full-body skeleton |
| Skeleton | Yes (multi-bone hierarchy) |
| Purpose | Hierarchical bone transform test with a humanoid rig |

---

## Fox.fbx

| Item | Value |
|------|-------|
| Source | `sampleModels/Fox/glTF-Binary/Fox.glb` |
| Content | Stylised fox model with Walk, Run, and Survey animation clips |
| Skeleton | Yes |
| Scale override | 0.01 (model is authored at centimetre scale) |
| Purpose | Multi-clip animation test with a production-quality skinned character |

---

## Conversion procedure

All files were converted using Blender's FBX exporter:

1. Open the source `.glb` / `.gltf` in Blender
2. Export as FBX (`File > Export > FBX`)
3. Place the output in this directory

Blender version used: **5.1**
