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
| [Samba Dancing](assets/models/fbx/Samba%20Dancing.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=Samba%20Dancing) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=Samba%20Dancing) | Skinned animation model. |
| [morph_test](assets/models/fbx/morph_test.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=morph_test) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=morph_test) | Morph targets are not supported by the custom loader yet. |
| [monkey](assets/models/fbx/monkey.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=monkey) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=monkey) | Static mesh. |
| [monkey_embedded_texture](assets/models/fbx/monkey_embedded_texture.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=monkey_embedded_texture) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=monkey_embedded_texture) | Embedded texture. |
| [vCube](assets/models/fbx/vCube.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=vCube) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=vCube) | Static mesh. |
| [archer/ArcherRi01](assets/models/fbx/archer/ArcherRi01.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=archer/ArcherRi01) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=archer/ArcherRi01) | Static mesh with geometric transform. |
| [warrior/Warrior](assets/models/fbx/warrior/Warrior.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=warrior/Warrior) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=warrior/Warrior) | Skinned animation model. ByVertice UV/normal mapping fix applied. |
| [stanford-bunny](assets/models/fbx/stanford-bunny.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=stanford-bunny) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=stanford-bunny) | Large static mesh; texture/material coverage is limited. |
| [mixamo](assets/models/fbx/mixamo.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=mixamo) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=mixamo) | Skinned animation model. |
| [RotationTest](assets/models/fbx/RotationTest.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=RotationTest) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=RotationTest) | Rotation-order coverage is still being verified. |
| [exampleWindow](assets/models/fbx/exampleWindow.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=exampleWindow) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=exampleWindow) | Static mesh. |
| [Head_69](assets/models/fbx/Head_69.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=Head_69) | :warning: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=Head_69) | Static mesh; material/texture coverage is still being verified. |
| [morph-translation](assets/models/fbx/morph-translation.fbx) | :white_check_mark: [Sample](https://cx20.github.io/fbx-test/example/threejs/index.html?model=morph-translation) | :x: [Sample](https://cx20.github.io/fbx-test/example/babylonjs/index.html?model=morph-translation) | Morph targets are not supported by the custom loader yet. |

## fbx-loader.js Usage

A standalone binary FBX parser and Babylon.js mesh builder. No build step or npm install required — just include it as a `<script>` tag.

### Installation

```html
<script src="example/babylonjs/fbx-loader.js"></script>
```

### API

```js
const nodes = await FBXLoader.loadFBX(url, scene, options);
```

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | URL of the `.fbx` file to load |
| `scene` | `BABYLON.Scene` | Target Babylon.js scene |
| `options` | `object` | Optional settings (see below) |

**Returns:** `Promise<BABYLON.Node[]>` — all created nodes (meshes and transform nodes).

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `animation` | `boolean` | `true` | Start animation playback automatically |
| `animationTime` | `number` | `0` | Initial animation time in seconds |

### Animation Control

When a skinned animation is present, the root node's `metadata.fbxAnimationControls` contains an array of animation control objects.

```js
const nodes = await FBXLoader.loadFBX(url, scene);

// Find the root node (__root__)
const root = nodes.find(n => n.name === '__root__');
const controls = root?.metadata?.fbxAnimationControls ?? [];

// Each control exposes:
const ctrl = controls[0];
ctrl.name;              // animation stack name (string)
ctrl.duration;          // total duration in seconds (number)
ctrl.time;              // current playback time (number)
ctrl.playing;           // true if playing (boolean)
ctrl.setTime(t);        // seek to time t (seconds)
ctrl.setPlaying(bool);  // play or pause
ctrl.dispose();         // clean up observer when done
```

The root node's `metadata.fbxSkeletons` contains an array of `BABYLON.Skeleton` objects for the loaded model.

### Basic Example

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.babylonjs.com/babylon.js"></script>
  <script src="fbx-loader.js"></script>
</head>
<body>
  <canvas id="c" style="width:100%;height:100vh"></canvas>
  <script>
    const canvas = document.getElementById('c');
    const engine = new BABYLON.Engine(canvas, true);
    const scene = new BABYLON.Scene(engine);

    const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2.5, 5, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene);

    FBXLoader.loadFBX('model.fbx', scene, { animation: true }).then(nodes => {
        console.log('Loaded nodes:', nodes.length);
    });

    engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => engine.resize());
  </script>
</body>
</html>
```

### URL Query Parameters (example viewer)

The [example viewer](example/babylonjs/index.html) also accepts these query parameters:

| Parameter | Example | Description |
|---|---|---|
| `model` | `?model=monkey` | Select a bundled model by name |
| `url` | `?url=https://…/model.fbx` | Load an arbitrary FBX URL |
| `scale` | `?scale=0.01` | Override the model scale |
| `animation` | `?animation=0` | Disable auto-play (`0` / `false` / `off`) |
| `time` | `?time=1.5` | Set the initial animation time (seconds) |

## Current Babylon.js Loader Scope

The Babylon.js sample uses a custom binary FBX parser. It currently focuses on static mesh loading, transform hierarchy validation, basic skinning data, and sampled skeleton animation.

Supported or partially supported:

- Binary FBX parsing
- Mesh geometry
- Normals, UVs, vertex colors
- Basic materials and external diffuse textures
- Model hierarchy transforms
- FBX geometric transforms
- Basic skinning: Skin/Cluster deformers, skeleton bones, and vertex bone weights
- Basic sampled skeleton animation: AnimationStack, AnimationLayer, AnimationCurveNode, and AnimationCurve

Not supported yet:

- Morph targets
- Embedded texture extraction
