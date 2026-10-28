import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import {
  FIXED_DT,
  type AnimationState,
  type Body,
  type Camera3D,
  type DrawEvent,
  type Entity,
  type EnvironmentDef,
  type GameEvent,
  type Light as LightSpec,
  type Mesh as MeshSpec,
  type RenderContext,
  type SceneDef,
} from "@ludra/core";
import type { Renderer3D, Renderer3DFactory } from "@ludra/core/browser";

/**
 * The 3D renderer for Ludra: Three.js draws every entity with a `mesh` and lights the scene
 * with its `light` entities, seen through a `camera3d`. It only reads the world, so it can
 * never change what tests verified.
 */

/** The World as the renderer needs it: what to draw, its events, and its render hooks. */
interface WorldView {
  readonly entities: readonly Entity[];
  readonly events?: readonly GameEvent[];
  readonly time?: number;
  callRenderHook?(entity: Entity, extras: Omit<RenderContext, "self" | "world" | "params">): void;
}

const DEG = Math.PI / 180;
const TONE_MAPPING = {
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  none: THREE.NoToneMapping,
} as const;
/** Collider colors in the debug view, as in 2D: static, dynamic, kinematic, sensor, player. */
const DEBUG_COLORS = { static: 0x7fdbff, dynamic: 0xffdc00, kinematic: 0xff851b, sensor: 0x2ecc40, player: 0xff4136 } as const;

/** Creates the 3D renderer for a scene. Pass it to startGame as `loadRenderer3D`. */
export const createRenderer3D: Renderer3DFactory = async (scene, options) => {
  const renderer = new ThreeRenderer(scene, options.width, options.height, options.assetBase);
  await renderer.load();
  return renderer;
};

/** A drawn glTF model and what poses it. */
interface Model {
  root: THREE.Object3D;
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
}

/** A clip an entity started playing, at simulation time `since`. `once` holds the last pose (a jump). */
interface ClipStart {
  clip: string;
  since: number;
  once: boolean;
}

interface Rig {
  position: THREE.Vector3;
  look: THREE.Vector3;
  /** The point shadows are centred on. */
  focus: THREE.Vector3;
  /** Orbit cameras keep turning. */
  yaw: number;
}

export class ThreeRenderer implements Renderer3D {
  readonly canvas: HTMLCanvasElement;
  debug = false;
  /** Three.js itself, for render hooks and anything else (step 4 hands these to scripts). */
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly objects = new Map<Entity, THREE.Object3D>();
  private readonly lights = new Map<Entity, THREE.Light>();
  private readonly textures = new Map<string, THREE.Texture>();
  /** Loaded glTF files by path; null when one failed to load (its entities fall back to a shape). */
  private readonly gltfs = new Map<string, GLTF | null>();
  private readonly gltfLoads = new Map<string, Promise<void>>();
  private gltfLoader: GLTFLoader | undefined;
  private readonly models = new Map<Entity, Model>();
  /** Entities drawn with a placeholder while their model loads. */
  private readonly waiting = new Set<Entity>();
  /**
   * The clips each modelled entity played, recorded once per simulation step (not per frame), so a
   * pose depends only on the simulation: a screenshot shows what the live game shows at that moment.
   */
  private readonly clipHistory = new Map<Entity, ClipStart[]>();
  private readonly debugGroup = new THREE.Group();
  private readonly defaultLights = new THREE.Group();
  private rig: Rig | undefined;
  /** Each render-hook entity's own group, and its ctx.local. */
  private readonly hookGroups = new Map<Entity, THREE.Group>();
  private readonly hookLocals = new Map<Entity, Record<string, unknown>>();
  /** A render hook's own way of drawing the frame (an EffectComposer), if one set it. */
  private customRender: (() => void) | undefined;
  /** Addons render hooks are still loading. */
  private readonly pending = new Set<Promise<unknown>>();

  private readonly def: SceneDef;
  private readonly assetBase: string;

  constructor(def: SceneDef, width: number, height: number, assetBase: string) {
    this.def = def;
    this.assetBase = assetBase;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    // preserveDrawingBuffer: the frame is copied into the game's 2D canvas after drawing.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const env: EnvironmentDef = def.environment ?? {};
    this.renderer.toneMapping = TONE_MAPPING[env.toneMapping ?? "aces"];
    this.renderer.toneMappingExposure = env.exposure ?? 1;
    this.renderer.shadowMap.enabled = env.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.05, 2000);
    this.applyEnvironment(env);
    this.scene.add(this.debugGroup, this.defaultLights);
  }

  /** Loads every texture and model the scene (and its prefabs) names, so the first frame (and screenshots) are complete. */
  async load(): Promise<void> {
    const loader = new THREE.TextureLoader();
    const meshes = [...this.def.entities, ...Object.values(this.def.prefabs ?? {})].map((e) => e.components?.mesh as Record<string, unknown> | undefined);
    const named = (field: string) => new Set(meshes.map((m) => m?.[field]).filter((p): p is string => typeof p === "string" && p !== ""));
    const paths = named("texture");
    const models = [...named("model")].map((path) => this.loadModel(path));
    await Promise.all([
      ...models,
      ...[...paths].map(async (path) => {
        try {
          const texture = await loader.loadAsync(this.assetBase + path);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = 4;
          this.textures.set(path, texture);
        } catch {
          console.warn(`[ludra] could not load texture "${path}", using the mesh color instead.`);
        }
      }),
    ]);
  }

  /** Loads a glTF file once. Draco and meshopt compressed files work too. */
  private loadModel(path: string): Promise<void> {
    let load = this.gltfLoads.get(path);
    if (load) return load;
    if (!this.gltfLoader) {
      this.gltfLoader = new GLTFLoader();
      const draco = new DRACOLoader();
      // The decoder sits in three's addons, which the import map serves.
      draco.setDecoderPath(new URL("../libs/draco/gltf/", import.meta.resolve("three/addons/loaders/DRACOLoader.js")).href);
      this.gltfLoader.setDRACOLoader(draco);
      this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    }
    load = this.track(
      this.gltfLoader.loadAsync(this.assetBase + path).then(
        (gltf) => void this.gltfs.set(path, gltf),
        (err: unknown) => {
          console.warn(`[ludra] could not load model "${path}" (${(err as Error)?.message ?? err}), drawing its shape instead.`);
          this.gltfs.set(path, null);
        },
      ),
    );
    this.gltfLoads.set(path, load);
    return load;
  }

  private applyEnvironment(env: EnvironmentDef): void {
    const sky = env.sky ?? ["#6fa8ff", "#dfeaff"];
    if (typeof sky === "string") this.scene.background = new THREE.Color(sky);
    else {
      // A vertical gradient: top of the sky to the horizon.
      const c = document.createElement("canvas");
      c.width = 2;
      c.height = 256;
      const g = c.getContext("2d")!;
      const gradient = g.createLinearGradient(0, 0, 0, 256);
      gradient.addColorStop(0, sky[0]);
      gradient.addColorStop(1, sky[1]);
      g.fillStyle = gradient;
      g.fillRect(0, 0, 2, 256);
      const texture = new THREE.CanvasTexture(c);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = texture;
    }
    if (env.fog) {
      const color = env.fog.color ?? (typeof sky === "string" ? sky : sky[1]);
      this.scene.fog = new THREE.Fog(color, env.fog.near ?? 30, env.fog.far ?? 150);
    }
  }

  step(world: WorldView): void {
    this.updateRig(world, FIXED_DT);
    this.recordClips(world);
  }

  reset(world: WorldView): void {
    this.rig = undefined;
    this.clipHistory.clear();
    this.recordClips(world);
    // Things render hooks built belong to the old run.
    for (const group of this.hookGroups.values()) group.removeFromParent();
    this.hookGroups.clear();
    this.hookLocals.clear();
    this.customRender = undefined;
    this.updateRig(world, 0);
  }

  render(world: WorldView): void {
    if (!this.rig) this.updateRig(world, 0);
    this.sync(world);
    const rig = this.rig!;
    this.camera.position.copy(rig.position);
    this.camera.lookAt(rig.look);
    this.poseModels(world);
    this.runRenderHooks(world);
    if (this.customRender) this.customRender();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Waits for every addon render hooks asked for, and for what their callbacks start in turn. */
  async settle(): Promise<void> {
    for (let round = 0; round < 5 && this.pending.size > 0; round++) {
      await Promise.allSettled([...this.pending]);
      // Let .then callbacks run (they often load the next thing or set a custom render).
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  /** Scripts' render hooks: the real three.js, this entity's group, the scene, camera and renderer. */
  private runRenderHooks(world: WorldView): void {
    const live = new Set(world.entities);
    for (const [entity, group] of this.hookGroups) {
      if (live.has(entity)) continue;
      group.removeFromParent();
      this.hookGroups.delete(entity);
      this.hookLocals.delete(entity);
    }
    if (!world.callRenderHook) return;
    for (const e of world.entities) {
      if (!e.script?.module.render) continue;
      let group = this.hookGroups.get(e);
      if (!group) {
        group = new THREE.Group();
        group.name = `${e.id}:render`;
        this.hookGroups.set(e, group);
        this.hookLocals.set(e, {});
        this.scene.add(group);
      }
      placeObject(group, e);
      world.callRenderHook(e, {
        THREE,
        scene: this.scene,
        camera: this.camera,
        renderer: this.renderer,
        object: group,
        model: this.modelHandle(e),
        time: world.time ?? 0,
        local: this.hookLocals.get(e)!,
        view: { width: this.canvas.width, height: this.canvas.height },
        recent: (name, seconds = 0.5) => recentEvents(world, name, seconds),
        addon: (path) => this.track(import(`three/addons/${path}`)),
        setRender: (fn) => {
          this.customRender = fn;
        },
        random: Math.random,
      });
    }
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    for (const texture of this.textures.values()) texture.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- animation

  /** Notes which clip every modelled entity should play now, and when that clip started. */
  private recordClips(world: WorldView): void {
    const time = world.time ?? 0;
    const live = new Set(world.entities);
    for (const entity of this.clipHistory.keys()) if (!live.has(entity)) this.clipHistory.delete(entity);
    for (const e of world.entities) {
      if (!e.mesh?.model) continue;
      const { clip, once } = chooseClip(e);
      const history = this.clipHistory.get(e) ?? [];
      const last = history[history.length - 1];
      if (last && last.clip === clip) continue;
      history.push({ clip, since: time, once });
      // Only the newest two matter: the clip playing and the one it blends out of.
      if (history.length > 2) history.shift();
      this.clipHistory.set(e, history);
    }
  }

  /** Poses every model for this moment: a pure function of simulation time and the clip history. */
  private poseModels(world: WorldView): void {
    const time = world.time ?? 0;
    for (const [e, model] of this.models) {
      if (model.actions.size === 0) continue;
      const spec = e.mesh!;
      const history = this.clipHistory.get(e) ?? [];
      const current = history[history.length - 1];
      const previous = history[history.length - 2];
      const blend = !current || !previous || spec.fade <= 0 ? 1 : Math.min(1, (time - current.since) / spec.fade);
      for (const [name, action] of model.actions) {
        const entry = name === current?.clip ? current : name === previous?.clip && blend < 1 ? previous : undefined;
        if (!entry) {
          action.setEffectiveWeight(0);
          continue;
        }
        const duration = action.getClip().duration;
        const elapsed = Math.max(0, time - entry.since) * spec.animationSpeed;
        action.time = duration <= 0 ? 0 : entry.once ? Math.min(elapsed, duration - 1e-4) : elapsed % duration;
        action.setEffectiveWeight(entry === current ? blend : 1 - blend);
      }
      if (current && current.clip !== "" && !model.actions.has(current.clip) && !warnedClips.has(`${e.id}:${current.clip}`)) {
        warnedClips.add(`${e.id}:${current.clip}`);
        console.warn(`[ludra] entity "${e.id}" asked for the clip "${current.clip}", which its model doesn't have. Clips: ${[...model.actions.keys()].join(", ") || "none"}.`);
      }
      model.mixer.update(0);
    }
  }

  private modelHandle(e: Entity): RenderContext["model"] {
    const model = this.models.get(e);
    return model && { root: model.root, clips: model.clips, mixer: model.mixer };
  }

  // ---------------------------------------------------------------- objects

  /** Brings Three's scene in line with the world: new entities, removed ones, every transform. */
  private sync(world: WorldView): void {
    const live = new Set(world.entities);
    for (const [entity, object] of this.objects) {
      // A model that finished loading replaces its placeholder.
      const ready = this.waiting.has(entity) && this.gltfs.has(entity.mesh!.model);
      if (live.has(entity) && !ready) continue;
      object.removeFromParent();
      this.objects.delete(entity);
      this.models.get(entity)?.mixer.stopAllAction();
      this.models.delete(entity);
      this.waiting.delete(entity);
    }
    for (const [entity, light] of this.lights) {
      if (live.has(entity)) continue;
      light.removeFromParent();
      this.lights.delete(entity);
    }
    let lit = false;
    for (const e of world.entities) {
      if (e.mesh) {
        let object = this.objects.get(e);
        if (!object) {
          object = this.createMesh(e);
          this.objects.set(e, object);
          this.scene.add(object);
        }
        object.visible = e.mesh.visible;
        placeObject(object, e);
      }
      if (e.light) {
        lit = true;
        let light = this.lights.get(e);
        if (!light) {
          light = createLight(e.light);
          this.lights.set(e, light);
          this.scene.add(light);
          if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) this.scene.add(light.target);
        }
        this.placeLight(light, e);
      }
    }
    // A scene without lights would be black: a soft sky and a sun until it has its own.
    if (!lit && this.defaultLights.children.length === 0) this.addDefaultLights();
    this.defaultLights.visible = !lit;
    if (!lit) {
      const sun = this.defaultLights.children.find((c) => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight | undefined;
      if (sun) {
        sun.position.copy(this.rig!.focus).add(new THREE.Vector3(8, 16, 6));
        sun.target.position.copy(this.rig!.focus);
        sun.target.updateMatrixWorld();
      }
    }
    this.syncDebug(world);
  }

  private addDefaultLights(): void {
    const sky = new THREE.HemisphereLight("#dfe9ff", "#4a4036", 1.1);
    const sun = new THREE.DirectionalLight("#fff4e0", 2.4);
    configureSun(sun, 40);
    this.defaultLights.add(sky, sun, sun.target);
  }

  private createMesh(e: Entity): THREE.Object3D {
    const spec = e.mesh!;
    if (spec.model) {
      const gltf = this.gltfs.get(spec.model);
      if (gltf) return this.createModel(e, gltf);
      if (gltf === undefined) {
        // Not loaded yet (a spawned entity whose model the scene never named): an empty stand-in until it is.
        void this.loadModel(spec.model);
        this.waiting.add(e);
        const placeholder = new THREE.Group();
        placeholder.name = e.id;
        return placeholder;
      }
    }
    const geometry = meshGeometry(spec, e.body);
    const texture = spec.texture ? this.textures.get(spec.texture)?.clone() : undefined;
    if (texture && spec.textureScale > 0) {
      // Tile the image every textureScale metres over the mesh's two largest sides.
      geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      const [a, b] = [size.x, size.y, size.z].sort((p, q) => q - p);
      texture.repeat.set(a! / spec.textureScale, b! / spec.textureScale);
      texture.needsUpdate = true;
    }
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.color),
      metalness: spec.metalness,
      roughness: spec.roughness,
      emissive: new THREE.Color(spec.emissive),
      emissiveIntensity: spec.emissiveIntensity,
      transparent: spec.opacity < 1,
      opacity: spec.opacity,
      map: texture ?? null,
      flatShading: spec.flatShading,
      wireframe: spec.wireframe,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = spec.castShadow;
    mesh.receiveShadow = spec.receiveShadow;
    mesh.name = e.id;
    return mesh;
  }

  /**
   * A copy of the model (bones included), turned, fitted to the entity and offset. The returned group
   * is placed like any mesh; inside it a pivot holds the fit, so scripts can still move the root.
   */
  private createModel(e: Entity, gltf: GLTF): THREE.Object3D {
    const spec = e.mesh!;
    const root = cloneSkinned(gltf.scene);
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = spec.castShadow;
        o.receiveShadow = spec.receiveShadow;
      }
    });
    root.rotation.set((spec.turn.x ?? 0) * DEG, (spec.turn.y ?? 0) * DEG, (spec.turn.z ?? 0) * DEG, "YXZ");
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true);
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());

    const w = spec.width || e.body?.width || 0;
    const h = spec.height || e.body?.height || 0;
    const d = spec.depth || e.body?.depth || e.body?.width || 0;
    const fitted = (target: number, own: number) => (target > 0 && own > 0 ? target / own : 1);
    const scale = new THREE.Vector3(1, 1, 1);
    if (spec.fit === "height") scale.setScalar(fitted(h, size.y));
    else if (spec.fit === "box") scale.set(fitted(w, size.x), fitted(h, size.y), fitted(d, size.z));
    scale.multiplyScalar(spec.scale);

    const pivot = new THREE.Group();
    pivot.scale.copy(scale);
    pivot.add(root);
    if (spec.fit !== "none") {
      // Centred on the entity, standing on the bottom of its body (or on its origin without a height).
      root.position.sub(new THREE.Vector3(center.x, box.isEmpty() ? 0 : box.min.y, center.z));
      pivot.position.y = h > 0 ? -h / 2 : 0;
    }
    pivot.position.add(new THREE.Vector3(spec.offset.x ?? 0, spec.offset.y ?? 0, spec.offset.z ?? 0));

    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip);
      action.setEffectiveWeight(0);
      action.play();
      actions.set(clip.name, action);
    }
    this.models.set(e, { root, clips: gltf.animations, mixer, actions });

    const group = new THREE.Group();
    group.name = e.id;
    group.add(pivot);
    return group;
  }

  private placeLight(light: THREE.Light, e: Entity): void {
    const t = e.transform;
    const spec = e.light!;
    const target = new THREE.Vector3(spec.target.x ?? 0, spec.target.y ?? 0, spec.target.z ?? 0);
    if (light instanceof THREE.DirectionalLight) {
      // Sunlight: keep its direction, but centre the shadow area on what the camera watches.
      const direction = new THREE.Vector3(t.x, t.y, t.z).sub(target);
      const focus = this.rig?.focus ?? target;
      light.position.copy(focus).add(direction);
      light.target.position.copy(focus);
      light.target.updateMatrixWorld();
    } else {
      light.position.set(t.x, t.y, t.z);
      if (light instanceof THREE.SpotLight) {
        light.target.position.copy(target);
        light.target.updateMatrixWorld();
      }
    }
  }

  // ---------------------------------------------------------------- camera

  /** Where the camera wants to be this step, eased by its smoothing. Deterministic per step. */
  private updateRig(world: WorldView, dt: number): void {
    const cameraEntity = world.entities.find((e) => e.camera3d);
    const spec: Camera3D = cameraEntity?.camera3d ?? DEFAULT_CAMERA;
    const target = (spec.target ? world.entities.find((e) => e.id === spec.target) : undefined) ?? world.entities.find((e) => e.character) ?? undefined;
    const yaw = (this.rig?.yaw ?? spec.yaw) + (spec.mode === "orbit" ? spec.orbitSpeed * dt : 0);
    this.camera.fov = spec.fov;
    this.camera.updateProjectionMatrix();

    let position: THREE.Vector3;
    let look: THREE.Vector3;
    const center = target ? new THREE.Vector3(target.transform.x, target.transform.y, target.transform.z) : new THREE.Vector3();
    if (spec.mode === "fixed") {
      const t = cameraEntity?.transform ?? { x: 0, y: 10, z: 18 };
      position = new THREE.Vector3(t.x, t.y, t.z);
      look = new THREE.Vector3(spec.lookAt.x ?? 0, spec.lookAt.y ?? 0, spec.lookAt.z ?? 0);
    } else if (spec.mode === "firstPerson" && target) {
      const eye = (target.body?.height ?? 1.8) * 0.4;
      position = center.clone().add(new THREE.Vector3(0, eye, 0));
      // Facing -z at a turn of 0; a turn of -90 faces +x.
      const turn = target.transform.rotationY * DEG;
      look = position.clone().add(new THREE.Vector3(-Math.sin(turn), 0, -Math.cos(turn)));
    } else if (target || spec.mode === "orbit") {
      position = center.clone().add(new THREE.Vector3(Math.sin(yaw * DEG) * spec.distance, spec.height, Math.cos(yaw * DEG) * spec.distance));
      look = center.clone().add(new THREE.Vector3(0, (target?.body?.height ?? 0) * 0.25, 0));
    } else {
      // Nothing to follow: an overview of the origin.
      position = new THREE.Vector3(0, 10, 18);
      look = new THREE.Vector3();
    }

    if (!this.rig || dt === 0 || spec.smoothing === 0) {
      this.rig = { position, look, focus: look.clone(), yaw };
      return;
    }
    // Exponential easing toward the goal: frame-rate independent, the same every run.
    const k = 1 - Math.exp(-dt / spec.smoothing);
    this.rig.position.lerp(position, k);
    this.rig.look.lerp(look, k);
    this.rig.focus.copy(this.rig.look);
    this.rig.yaw = yaw;
  }

  // ---------------------------------------------------------------- debug

  /** Colliders as wireframes in their body's color, drawn over everything, and light positions. */
  private syncDebug(world: WorldView): void {
    this.debugGroup.visible = this.debug;
    if (!this.debug) return;
    for (const child of [...this.debugGroup.children]) {
      child.removeFromParent();
      (child as THREE.LineSegments).geometry?.dispose();
    }
    for (const e of world.entities) {
      const b = e.body;
      if (b) {
        const color = b.sensor ? DEBUG_COLORS.sensor : e.character ? DEBUG_COLORS.player : DEBUG_COLORS[b.type];
        const shape = colliderGeometry(b);
        const lines = new THREE.LineSegments(new THREE.EdgesGeometry(shape, 1), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
        shape.dispose();
        placeObject(lines, e);
        lines.renderOrder = 999;
        this.debugGroup.add(lines);
      }
      if (e.light) {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffee88, depthTest: false }));
        marker.position.set(e.transform.x, e.transform.y, e.transform.z);
        marker.renderOrder = 999;
        this.debugGroup.add(marker);
      }
    }
    const axes = new THREE.AxesHelper(1.5);
    axes.renderOrder = 999;
    (axes.material as THREE.Material).depthTest = false;
    this.debugGroup.add(axes);
  }
}

/** Events in the last `seconds`, as hooks see them. */
function recentEvents(world: WorldView, name: string | undefined, seconds: number): DrawEvent[] {
  const events = world.events ?? [];
  const since = (world.time ?? 0) - seconds;
  const result: DrawEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.time < since) break;
    const eventName = event.type === "custom" ? event.name : event.type;
    if (name !== undefined && eventName !== name) continue;
    const { type: _type, frame: _frame, time, x, y, entity, ...details } = event as GameEvent & { data?: unknown };
    result.push({ name: eventName, time, x, y, entity, data: event.type === "custom" ? event.data : details });
  }
  return result.reverse();
}

/** Clips already reported missing, so the console says it once. */
const warnedClips = new Set<string>();

/**
 * The clip an entity should play: a script's `state.animation`, then `mesh.animation`, then the
 * clip its `animations` map gives the way it moves (in the air: jump while rising, fall after).
 */
function chooseClip(e: Entity): { clip: string; once: boolean } {
  const spec = e.mesh!;
  const scripted = e.state.animation;
  if (typeof scripted === "string" && scripted !== "") return { clip: scripted, once: false };
  if (spec.animation) return { clip: spec.animation, once: false };
  const map = spec.animations;
  const pick = (...states: AnimationState[]) => states.map((s) => map[s]).find((c) => c) ?? "";
  const b = e.body;
  if (!b) return { clip: pick("idle"), once: false };
  if (!b.grounded && b.type === "dynamic") {
    const clip = b.vy > 0 ? pick("jump", "fall", "idle") : pick("fall", "jump", "idle");
    // A jump plays once and holds its last pose; a fall loops.
    return { clip, once: clip === map.jump && clip !== map.fall };
  }
  const speed = Math.hypot(b.vx, b.vz);
  if (speed > 0.3) {
    const runFrom = (e.character?.speed ?? 5) * 0.6;
    return { clip: speed < runFrom ? pick("walk", "run", "idle") : pick("run", "walk", "idle"), once: false };
  }
  return { clip: pick("idle"), once: false };
}

const DEFAULT_CAMERA: Camera3D = { mode: "follow", target: "", fov: 55, distance: 9, height: 4, yaw: 0, orbitSpeed: 20, lookAt: {}, smoothing: 0.12 };

function placeObject(object: THREE.Object3D, e: Entity): void {
  const t = e.transform;
  object.position.set(t.x, t.y, t.z);
  // Ludra's 3D rotations are applied y, then x, then z: Three's "YXZ" order.
  object.rotation.set(t.rotationX * DEG, t.rotationY * DEG, t.rotation * DEG, "YXZ");
}

function configureSun(light: THREE.DirectionalLight, size: number): void {
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const half = size / 2;
  Object.assign(light.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: size * 4 });
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
}

function createLight(spec: LightSpec): THREE.Light {
  const color = new THREE.Color(spec.color);
  switch (spec.type) {
    case "ambient":
      return new THREE.AmbientLight(color, spec.intensity);
    case "hemisphere":
      return new THREE.HemisphereLight(color, new THREE.Color(spec.groundColor), spec.intensity);
    case "point": {
      const light = new THREE.PointLight(color, spec.intensity, spec.distance, 2);
      light.castShadow = spec.castShadow;
      light.shadow.mapSize.set(512, 512);
      light.shadow.bias = -0.002;
      return light;
    }
    case "spot": {
      const light = new THREE.SpotLight(color, spec.intensity, spec.distance, spec.angle * DEG, spec.penumbra, 2);
      light.castShadow = spec.castShadow;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.001;
      return light;
    }
    default: {
      const light = new THREE.DirectionalLight(color, spec.intensity);
      if (spec.castShadow) configureSun(light, spec.shadowSize);
      return light;
    }
  }
}

/** The mesh's geometry: its own shape and size, or its body's. */
function meshGeometry(spec: MeshSpec, body: Body | undefined): THREE.BufferGeometry {
  const shape = spec.shape === "auto" ? (body ? bodyShape(body) : "box") : spec.shape;
  if ((shape === "convex" || shape === "mesh") && body && spec.shape === "auto") return colliderGeometry(body);
  const w = spec.width || body?.width || 1;
  const h = spec.height || body?.height || 1;
  const d = spec.depth || (body ? body.depth || body.width : w);
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(w / 2, 40, 24);
    case "capsule":
      return new THREE.CapsuleGeometry(w / 2, Math.max(0, h - w), 10, 24);
    case "cylinder":
      return new THREE.CylinderGeometry(w / 2, w / 2, h, 40);
    case "cone":
      return new THREE.ConeGeometry(w / 2, h, 40);
    case "plane":
      return new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    case "torus":
      return new THREE.TorusGeometry((w - h) / 2, h / 2, 20, 56);
    default:
      return new THREE.BoxGeometry(w, h, d);
  }
}

function bodyShape(body: Body): string {
  return body.shape === "box" || body.shape === "sphere" || body.shape === "capsule" || body.shape === "cylinder" || body.shape === "convex" || body.shape === "mesh" ? body.shape : "box";
}

/** The exact collider shape, for the debug view and convex meshes. */
function colliderGeometry(b: Body): THREE.BufferGeometry {
  const d = b.depth || b.width;
  switch (b.shape) {
    case "sphere":
      return new THREE.SphereGeometry(b.width / 2, 16, 10);
    case "capsule":
      return new THREE.CapsuleGeometry(b.width / 2, Math.max(0, b.height - b.width), 4, 12);
    case "cylinder":
      return new THREE.CylinderGeometry(b.width / 2, b.width / 2, b.height, 16);
    case "convex":
      if (b.points.length >= 4) return new ConvexGeometry(b.points.map(([x, y, z]) => new THREE.Vector3(x, y, z ?? 0)));
      return new THREE.BoxGeometry(b.width, b.height, d);
    case "mesh": {
      if (b.points.length < 3 || b.triangles.length === 0) return new THREE.BoxGeometry(b.width, b.height, d);
      // Exactly the collider's triangles, so procedural terrain is drawn as it collides.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.points.flatMap(([x, y, z]) => [x!, y!, z ?? 0]), 3));
      geometry.setIndex(b.triangles.flat());
      geometry.computeVertexNormals();
      return geometry;
    }
    default:
      return new THREE.BoxGeometry(b.width, b.height, d);
  }
}
