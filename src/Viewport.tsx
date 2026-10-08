import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createShapeGeometry, type Shape } from './geometry';

export type ViewportResult = {
  /** World-space coordinates in metres, packed as xyz triples. */
  points: number[];
  /** Velocity vectors in metres per second, packed as xyz triples. */
  velocity: number[];
  /** Pressure in pascals, one entry per point. */
  pressure: number[];
};

type Props = {
  shapes: Shape[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  result?: ViewportResult | null;
  field: 'velocity' | 'pressure';
  /** Use full-mesh extrema when the displayed cell data has been subsampled. */
  fieldRange?: { min: number; max: number };
  onRenderer?: (label: string) => void;
  resetViewKey?: number;
  showGrid: boolean;
  velocity: number;
  placingEmitter?: boolean;
};

type Renderer = {
  domElement: HTMLCanvasElement;
  setSize: (width: number, height: number, updateStyle?: boolean) => void;
  setPixelRatio: (ratio: number) => void;
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  dispose: () => void;
  outputColorSpace: string;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
};

type Runtime = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: Renderer;
  controls: OrbitControls;
  objects: THREE.Group;
  results: THREE.Group;
  selection: THREE.Group;
  inlet: THREE.Group;
  grid: THREE.GridHelper;
};

const HOME = new THREE.Vector3(1.65, 1.4, 2.1);
const TEAL = new THREE.Color('#70ded0');
const COLOR_STOPS = ['#5269d1', '#3995d1', '#49c9bb', '#cfe294', '#f1ae5a', '#ed6d58'].map((color) => new THREE.Color(color));

function fieldColor(t: number, target: THREE.Color) {
  const scaled = THREE.MathUtils.clamp(t, 0, 1) * (COLOR_STOPS.length - 1);
  const lower = Math.min(Math.floor(scaled), COLOR_STOPS.length - 2);
  return target.copy(COLOR_STOPS[lower]).lerp(COLOR_STOPS[lower + 1], scaled - lower);
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const rendered = child as THREE.Mesh;
    rendered.geometry?.dispose();
    const materials = rendered.material ? (Array.isArray(rendered.material) ? rendered.material : [rendered.material]) : [];
    for (const material of materials) {
      const mapped = material as THREE.MeshBasicMaterial;
      mapped.map?.dispose();
      material.dispose();
    }
  });
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function label(text: string, color: string, position: THREE.Vector3, scale = 0.09) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.font = '500 35px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, 64, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, opacity: 0.85 }));
  sprite.position.copy(position);
  sprite.scale.set(scale * 2, scale, 1);
  return sprite;
}

function buildScene(): Omit<Runtime, 'renderer' | 'controls'> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#111e24');
  const camera = new THREE.PerspectiveCamera(39, 1, 0.01, 100);
  camera.position.copy(HOME);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight('#d9e8e8', '#34484d', 2.1));
  const key = new THREE.DirectionalLight('#fffaf0', 3.1);
  key.position.set(1, 3, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#78b7c2', 1.3);
  rim.position.set(-2, 1, -2);
  scene.add(rim);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: '#14242a', roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.526;
  scene.add(floor);
  const grid = new THREE.GridHelper(4, 40, '#344c54', '#253c44');
  grid.position.y = -0.523;
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.65;
  scene.add(grid);

  const box = new THREE.BoxGeometry(2, 1, 1);
  const domain = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#6c929d', transparent: true, opacity: 0.23 }));
  box.dispose();
  scene.add(domain);

  // The miniature world axes share the model's actual axis directions.
  const origin = new THREE.Vector3(-1.12, -0.51, 0.65);
  for (const [axis, color, letter] of [
    [new THREE.Vector3(1, 0, 0), '#c98075', 'X'],
    [new THREE.Vector3(0, 1, 0), '#8bbb96', 'Y'],
    [new THREE.Vector3(0, 0, 1), '#829bd2', 'Z'],
  ] as const) {
    const arrow = new THREE.ArrowHelper(axis, origin, 0.18, color, 0.032, 0.018);
    scene.add(arrow);
    scene.add(label(letter, color, origin.clone().addScaledVector(axis, 0.23), 0.054));
  }

  const objects = new THREE.Group();
  const results = new THREE.Group();
  const selection = new THREE.Group();
  const inlet = new THREE.Group();
  scene.add(objects, results, selection, inlet);
  return { scene, camera, objects, results, selection, inlet, grid };
}

function resetCamera(runtime: Runtime) {
  runtime.camera.position.copy(HOME);
  runtime.controls.target.set(0, 0, 0);
  runtime.controls.update();
}

/** A real 3D geometry and solver-data viewport, with WebGPU when available. */
export default function Viewport(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    const host = hostRef.current!;
    let cancelled = false;
    let frame = 0;
    let cleanup: (() => void) | undefined;
    const sceneParts = buildScene();

    async function start() {
      let renderer: Renderer | undefined;
      let rendererLabel = 'WebGL2';
      if ('gpu' in navigator) {
        let candidate: (Renderer & { init: () => Promise<void> }) | undefined;
        try {
          const { WebGPURenderer } = await import('three/webgpu');
          candidate = new WebGPURenderer({ antialias: true, alpha: false }) as unknown as typeof candidate;
          await candidate!.init();
          renderer = candidate;
          const backend = candidate as unknown as { backend?: { isWebGPUBackend?: boolean } };
          rendererLabel = backend.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
        } catch {
          candidate?.dispose();
        }
      }
      if (!renderer) {
        try {
          renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        } catch {
          disposeObject(sceneParts.scene);
          if (!cancelled) {
            setRenderError(true);
            propsRef.current.onRenderer?.('Unavailable');
          }
          return;
        }
      }
      if (cancelled) {
        renderer.dispose();
        disposeObject(sceneParts.scene);
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      let canvas = renderer.domElement;
      const prepareCanvas = () => {
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.tabIndex = 0;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'Interactive 3D geometry. Drag to orbit, scroll to zoom, click to select. Arrow keys rotate; Home resets the view.');
      };
      prepareCanvas();
      host.appendChild(canvas);

      const controls = new OrbitControls(sceneParts.camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.09;
      controls.rotateSpeed = 0.7;
      controls.zoomSpeed = 0.85;
      controls.panSpeed = 0.7;
      controls.minDistance = 0.15;
      controls.maxDistance = 12;
      controls.maxPolarAngle = Math.PI * 0.91;
      const runtime = { ...sceneParts, renderer, controls };
      runtimeRef.current = runtime;

      const resize = () => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        runtime.camera.aspect = width / height;
        runtime.camera.updateProjectionMatrix();
        renderer!.setSize(width, height, false);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const hitAt = (event: MouseEvent | PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, runtime.camera);
        return raycaster.intersectObjects(runtime.objects.children.filter((child) => child.userData.shapeId), false)[0];
      };
      let pointerDown: { x: number; y: number; button: number } | null = null;
      const down = (event: PointerEvent) => { pointerDown = { x: event.clientX, y: event.clientY, button: event.button }; };
      const up = (event: PointerEvent) => {
        if (!pointerDown || pointerDown.button !== 0) return;
        const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
        pointerDown = null;
        if (distance < 5 && !propsRef.current.placingEmitter) {
          const hit = hitAt(event);
          propsRef.current.onSelect(hit?.object.userData.shapeId ?? null);
        }
      };
      const doubleClick = (event: MouseEvent) => {
        const hit = hitAt(event);
        if (!hit) return;
        const bounds = new THREE.Box3().setFromObject(hit.object);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const direction = runtime.camera.position.clone().sub(controls.target).normalize();
        controls.target.copy(center);
        runtime.camera.position.copy(center).addScaledVector(direction, Math.max(0.45, size.length() * 1.75));
        controls.update();
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Home') { event.preventDefault(); resetCamera(runtime); return; }
        const rotate = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
        if (!rotate && !['+', '=', '-'].includes(event.key)) return;
        event.preventDefault();
        const offset = runtime.camera.position.clone().sub(controls.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        if (event.key === 'ArrowLeft') spherical.theta -= 0.1;
        if (event.key === 'ArrowRight') spherical.theta += 0.1;
        if (event.key === 'ArrowUp') spherical.phi = Math.max(0.05, spherical.phi - 0.1);
        if (event.key === 'ArrowDown') spherical.phi = Math.min(Math.PI * 0.91, spherical.phi + 0.1);
        if (['+', '='].includes(event.key)) spherical.radius = Math.max(0.15, spherical.radius * 0.9);
        if (event.key === '-') spherical.radius = Math.min(12, spherical.radius * 1.1);
        runtime.camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
        controls.update();
      };
      const attachInput = () => {
        canvas.addEventListener('pointerdown', down);
        canvas.addEventListener('pointerup', up);
        canvas.addEventListener('dblclick', doubleClick);
        canvas.addEventListener('keydown', keydown);
      };
      const detachInput = () => {
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('dblclick', doubleClick);
        canvas.removeEventListener('keydown', keydown);
      };
      attachInput();

      // A successful adapter request does not guarantee a working GPU device.
      // Keep the scene and camera when a driver fails during shader compilation.
      let usingWebGPU = rendererLabel === 'WebGPU';
      const recoverRenderer = () => {
        if (cancelled || !usingWebGPU) return;
        usingWebGPU = false;
        const previous = renderer!;
        try {
          const replacement = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
          replacement.setPixelRatio(Math.min(window.devicePixelRatio, 2));
          replacement.outputColorSpace = THREE.SRGBColorSpace;
          replacement.toneMapping = THREE.ACESFilmicToneMapping;
          replacement.toneMappingExposure = 0.95;
          detachInput();
          controls.disconnect();
          const oldCanvas = canvas;
          canvas = replacement.domElement;
          prepareCanvas();
          host.replaceChild(canvas, oldCanvas);
          controls.connect(canvas);
          attachInput();
          renderer = replacement;
          runtime.renderer = replacement;
          resize();
          propsRef.current.onRenderer?.('WebGL2');
        } catch {
          setRenderError(true);
          propsRef.current.onRenderer?.('Unavailable');
          cancelAnimationFrame(frame);
        }
        void Promise.resolve(previous.dispose()).catch(() => { /* The failed device may already be gone. */ });
      };
      if (usingWebGPU) {
        const gpuRenderer = renderer as Renderer & { onDeviceLost: () => void; onError: () => void };
        gpuRenderer.onDeviceLost = recoverRenderer;
        gpuRenderer.onError = recoverRenderer;
      }
      const gpuRejection = (event: PromiseRejectionEvent) => {
        // Dawn can reject error scopes after a failed device has been destroyed.
        // Handle that specific driver failure, including its outstanding scopes.
        const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
        if (message.includes('popErrorScope')) {
          event.preventDefault();
          recoverRenderer();
        }
      };
      if (rendererLabel === 'WebGPU') window.addEventListener('unhandledrejection', gpuRejection);

      const draw = () => {
        if (cancelled) return;
        controls.update();
        try {
          renderer!.render(runtime.scene, runtime.camera);
        } catch (error) {
          if (usingWebGPU) recoverRenderer();
          else {
            setRenderError(true);
            propsRef.current.onRenderer?.('Unavailable');
            return;
          }
        }
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        detachInput();
        window.removeEventListener('unhandledrejection', gpuRejection);
        controls.dispose();
        disposeObject(runtime.scene);
        renderer!.dispose();
        canvas.remove();
        runtimeRef.current = null;
      };
      setReady(true);
      propsRef.current.onRenderer?.(rendererLabel);
    }
    void start();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    clearGroup(runtime.objects);
    for (const shape of props.shapes) {
      const geometry = createShapeGeometry(shape);
      const material = new THREE.MeshStandardMaterial({
        color: '#bdcbc7',
        roughness: 0.52,
        metalness: 0.16,
        side: THREE.DoubleSide,
        transparent: Boolean(props.result),
        opacity: props.result ? 0.55 : 1,
        depthWrite: !props.result,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(shape.x, shape.y, shape.z);
      mesh.rotation.set(...shape.rotation.map((angle) => THREE.MathUtils.degToRad(angle)) as [number, number, number]);
      mesh.userData.shapeId = shape.id;
      mesh.userData.shapeName = shape.name;
      runtime.objects.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 35), new THREE.LineBasicMaterial({ color: '#78938f', transparent: true, opacity: props.result ? 0.23 : 0.3 }));
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      runtime.objects.add(edges);
    }
    runtime.objects.updateMatrixWorld(true);
  }, [props.shapes, Boolean(props.result), ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    clearGroup(runtime.selection);
    const object = runtime.objects.children.find((child) => child.userData.shapeId === props.selectedId);
    if (object) {
      const helper = new THREE.BoxHelper(object, '#75ddd0');
      const material = helper.material as THREE.LineBasicMaterial;
      material.transparent = true;
      material.opacity = 0.8;
      runtime.selection.add(helper);
    }
  }, [props.selectedId, props.shapes, Boolean(props.result), ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.grid.visible = props.showGrid;
  }, [props.showGrid, ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime) resetCamera(runtime);
  }, [props.resetViewKey, ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    clearGroup(runtime.inlet);
    if (props.velocity <= 0) return;
    // These arrows depict the specified inlet boundary, not a solved flow field.
    for (let y = -0.3; y <= 0.31; y += 0.2) {
      for (let z = -0.3; z <= 0.31; z += 0.2) {
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1.08, y, z), 0.145, TEAL, 0.039, 0.019);
        (arrow.line.material as THREE.LineBasicMaterial).transparent = true;
        (arrow.line.material as THREE.LineBasicMaterial).opacity = 0.75;
        runtime.inlet.add(arrow);
      }
    }
    runtime.inlet.add(label('INLET', '#7bd4c8', new THREE.Vector3(-1.12, 0.52, 0), 0.07));
  }, [props.velocity, ready]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    clearGroup(runtime.results);
    if (!props.result || props.result.points.length < 3) return;
    const { points, velocity, pressure } = props.result;
    const count = Math.floor(points.length / 3);
    const scalars = new Float32Array(count);
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < count; index++) {
      const value = props.field === 'pressure'
        ? pressure[index]
        : Math.hypot(velocity[index * 3], velocity[index * 3 + 1], velocity[index * 3 + 2]);
      scalars[index] = Number.isFinite(value) ? value : 0;
      min = Math.min(min, scalars[index]);
      max = Math.max(max, scalars[index]);
    }
    // Speed has a physical zero; pressure can have either sign.
    if (props.field === 'velocity') min = 0;
    if (props.fieldRange && Number.isFinite(props.fieldRange.min) && Number.isFinite(props.fieldRange.max) && props.fieldRange.max >= props.fieldRange.min) {
      min = props.fieldRange.min;
      max = props.fieldRange.max;
    }
    const range = Math.max(max - min, 1e-10);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    for (let index = 0; index < count; index++) {
      fieldColor((scalars[index] - min) / range, color);
      color.toArray(colors, index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.slice(0, count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    runtime.results.add(new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.024, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.83, depthWrite: false })));

    if (props.field === 'velocity') {
      const stride = Math.max(1, Math.ceil(count / 70));
      const maxSpeed = Math.max(max, 1e-10);
      for (let index = 0; index < count; index += stride) {
        const vector = new THREE.Vector3(velocity[index * 3], velocity[index * 3 + 1], velocity[index * 3 + 2]);
        const speed = vector.length();
        if (!Number.isFinite(speed) || speed < 1e-10) continue;
        const origin = new THREE.Vector3(points[index * 3], points[index * 3 + 1], points[index * 3 + 2]);
        const length = 0.035 + Math.min(speed / maxSpeed, 1) * 0.07;
        const arrow = new THREE.ArrowHelper(vector.normalize(), origin, length, fieldColor(speed / maxSpeed, color).clone(), length * 0.32, length * 0.14);
        runtime.results.add(arrow);
      }
    }
  }, [props.result, props.field, props.fieldRange?.min, props.fieldRange?.max, ready]);

  return (
    <div
      ref={hostRef}
      className="three-viewport"
      data-testid="viewport"
      style={{ width: '100%', height: '100%', position: 'relative', cursor: props.placingEmitter ? 'crosshair' : 'grab', overflow: 'hidden' }}
    >
      {(!ready || renderError) && (
        <div role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#8aa2a8', fontSize: 12, pointerEvents: 'none' }}>
          {renderError ? '3D rendering is unavailable in this browser.' : 'Preparing 3D workspace…'}
        </div>
      )}
    </div>
  );
}
