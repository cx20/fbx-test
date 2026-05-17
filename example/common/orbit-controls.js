// orbit-controls.js — shared orbit-style mouse / touch camera controller for
// the example/webgl1, example/webgl2 and example/webgpu viewers.
//
// Maintains spherical coordinates (azimuth, polar, distance) around a target
// point — same shape as THREE.OrbitControls / BABYLON.ArcRotateCamera — and
// rewrites the caller's `cameraEye` Float32Array in place every time the user
// moves the mouse. The viewer's render loop already reads `cameraEye` each
// frame, so no other changes are needed.
//
// Usage (after including this script before index.js):
//
//   const { vec3 } = window.glMatrix;
//   OrbitControls.create({ canvas, cameraEye, cameraTarget, cameraUp, vec3 });
//
// Bindings:
//   left drag           → orbit (rotate azimuth, polar; polar clamped away from poles)
//   right drag          → pan target along the camera-aligned right/up basis
//   wheel               → zoom (multiply / divide distance by 1.1)
//   1-finger touch drag → orbit
//
// Returns a `{ rotate, zoom, pan, apply }` handle so the caller can drive the
// camera programmatically too (e.g. from a keyboard shortcut or animation).

(function (root) {

function create({ canvas, cameraEye, cameraTarget, cameraUp, vec3,
                  rotateSpeed = 0.005, zoomFactor = 1.1, panSpeed = 0.001,
                  minDistance = 0.1 }) {
    const offset = vec3.create();
    vec3.subtract(offset, cameraEye, cameraTarget);
    let distance = vec3.length(offset);
    let polar    = Math.acos(Math.max(-1, Math.min(1, offset[1] / distance)));
    let azimuth  = Math.atan2(offset[2], offset[0]);
    const EPS = 1e-3;

    function apply() {
        const sp = Math.sin(polar);
        cameraEye[0] = cameraTarget[0] + distance * sp * Math.cos(azimuth);
        cameraEye[1] = cameraTarget[1] + distance * Math.cos(polar);
        cameraEye[2] = cameraTarget[2] + distance * sp * Math.sin(azimuth);
    }
    function rotate(dx, dy) {
        azimuth -= dx;
        polar   = Math.max(EPS, Math.min(Math.PI - EPS, polar - dy));
        apply();
    }
    function zoom(factor) {
        distance = Math.max(minDistance, distance * factor);
        apply();
    }
    function pan(dx, dy) {
        // Build the camera basis (right, up) in world space.
        const forward = vec3.create();
        vec3.subtract(forward, cameraTarget, cameraEye);
        vec3.normalize(forward, forward);
        const right = vec3.create();
        vec3.cross(right, forward, cameraUp);
        vec3.normalize(right, right);
        const up = vec3.create();
        vec3.cross(up, right, forward);
        const scale = distance * panSpeed;
        cameraTarget[0] += (-dx * right[0] + dy * up[0]) * scale;
        cameraTarget[1] += (-dx * right[1] + dy * up[1]) * scale;
        cameraTarget[2] += (-dx * right[2] + dy * up[2]) * scale;
        apply();
    }

    // ---- Event wiring ----
    // mousedown is bound to the canvas so clicks on the lil-gui panel still
    // work; mousemove and mouseup are bound to the window so the drag carries
    // on past the canvas edge.
    let dragMode = null;
    let lastX = 0, lastY = 0;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('mousedown', e => {
        e.preventDefault();
        lastX = e.clientX; lastY = e.clientY;
        if (e.button === 0)      dragMode = 'rotate';
        else if (e.button === 2) dragMode = 'pan';
    });
    window.addEventListener('mouseup', () => { dragMode = null; });
    window.addEventListener('mousemove', e => {
        if (!dragMode) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        if (dragMode === 'rotate') rotate(dx * rotateSpeed, dy * rotateSpeed);
        else                       pan(dx, dy);
    });
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        zoom(e.deltaY > 0 ? zoomFactor : 1 / zoomFactor);
    }, { passive: false });

    let touchX = 0, touchY = 0;
    canvas.addEventListener('touchstart', e => {
        if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }
    });
    canvas.addEventListener('touchmove', e => {
        if (e.touches.length === 1) {
            const t = e.touches[0];
            rotate((t.clientX - touchX) * rotateSpeed, (t.clientY - touchY) * rotateSpeed);
            touchX = t.clientX; touchY = t.clientY;
            e.preventDefault();
        }
    }, { passive: false });

    return { rotate, zoom, pan, apply };
}

root.OrbitControls = { create };

})(window);
