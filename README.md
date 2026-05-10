# fbx-test

The status of loading and viewing FBX models using different WebGL libraries.

## Samples

- [Three.js + FBXLoader](https://cx20.github.io/fbx-test/example/threejs/index.html)
- [Babylon.js + custom FBX loader](https://cx20.github.io/fbx-test/example/babylonjs/index.html)

## FBX Models

Test environment: Windows 11 + Chrome 147

Legend:

- :white_check_mark: Displayed
- :warning: Partially displayed / work in progress
- :x: Not supported by the current sample

| Model | [Three.js r184](https://github.com/mrdoob/three.js) | [Babylon.js custom loader](example/babylonjs/fbx-loader.js) | Notes |
|---|---|---|---|
| [Samba Dancing](assets/models/fbx/Samba%20Dancing.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=Samba%20Dancing) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=Samba%20Dancing) | Skinned animation model. |
| [morph_test](assets/models/fbx/morph_test.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=morph_test) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=morph_test) | Morph targets are not supported by the custom loader yet. |
| [monkey](assets/models/fbx/monkey.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=monkey) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=monkey) | Static mesh. |
| [monkey_embedded_texture](assets/models/fbx/monkey_embedded_texture.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=monkey_embedded_texture) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=monkey_embedded_texture) | Embedded texture handling is incomplete in the custom loader. |
| [vCube](assets/models/fbx/vCube.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=vCube) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=vCube) | Static mesh. |
| [archer/ArcherRi01](assets/models/fbx/archer/ArcherRi01.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=archer/ArcherRi01) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=archer/ArcherRi01) | T-pose is displayed; weapon geometric transform is handled. Skinning and animation are not supported yet. |
| [warrior/Warrior](assets/models/fbx/warrior/Warrior.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=warrior/Warrior) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=warrior/Warrior) | Skinned animation model. |
| [stanford-bunny](assets/models/fbx/stanford-bunny.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=stanford-bunny) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=stanford-bunny) | Large static mesh; texture/material coverage is limited. |
| [mixamo](assets/models/fbx/mixamo.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=mixamo) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=mixamo) | Skinned animation model. |
| [RotationTest](assets/models/fbx/RotationTest.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=RotationTest) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=RotationTest) | Rotation-order coverage is still being verified. |
| [exampleWindow](assets/models/fbx/exampleWindow.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=exampleWindow) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=exampleWindow) | Static mesh. |
| [Head_69](assets/models/fbx/Head_69.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=Head_69) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=Head_69) | Static mesh; material/texture coverage is still being verified. |
| [morph-translation](assets/models/fbx/morph-translation.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=morph-translation) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=morph-translation) | Morph targets are not supported by the custom loader yet. |

## Current Babylon.js Loader Scope

The Babylon.js sample uses a custom binary FBX parser. It currently focuses on static mesh loading and transform hierarchy validation.

Supported or partially supported:

- Binary FBX parsing
- Mesh geometry
- Normals, UVs, vertex colors
- Basic materials and external diffuse textures
- Model hierarchy transforms
- FBX geometric transforms

Not supported yet:

- Skinning
- Animation playback
- Morph targets
- Embedded texture extraction
