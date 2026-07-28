/**
 * /brand-kit/object: ISOLATED three.js inspector for the Meshy hero GLB. Nothing
 * here touches the live landing or the frozen claim route. We view the generated
 * object directly (react-three-fiber + drei) over the Periwinkle ground.
 *
 * FINDING: Meshy's PBR refine baked GARBLED TEXT onto the face (it turned the
 * "debossed checkmark" instruction into nonsense glyphs), a brand.md §8 violation.
 * So we DISCARD the baked texture and drive the surface ourselves: the matte-cream
 * ceramic is a three.js material override on the (lighter, 688 KB) preview mesh, and
 * the checkmark is a canvas-drawn accent Decal (no AI). The "Raw Meshy PBR" tab is
 * kept only to show the problem.
 */
"use client";

import { Suspense, useMemo, useState } from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { useGLTF, useTexture, OrbitControls, Bounds, ContactShadows, Decal } from "@react-three/drei";

const ACCENT = "#6E5FCE";
// The Meshy slab's big face (with the tail) is the +Y face; stand it up so it faces
// the camera. Decal placement is mesh-local (before this rotation). Iterated visually.
const OBJ_ROT: [number, number, number] = [Math.PI / 2, 0, 0];
const DECAL_POS: [number, number, number] = [0, 0.45, -0.12];
const DECAL_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];
const DECAL_SCALE = 0.95;
const DECAL_DEBUG = false;

function useCheckTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 34;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(66, 134);
    ctx.lineTo(112, 180);
    ctx.lineTo(192, 84);
    ctx.stroke();
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }, []);
}

// Smooth shading across the whole mesh INCLUDING UV seams: average each vertex's
// normal with every other vertex at the same position (Meshy splits seam vertices, so
// plain computeVertexNormals leaves faceted seams). Geometry/UVs are untouched.
function smoothNormalsAcrossSeams(geo: THREE.BufferGeometry) {
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const acc = new Map<string, [number, number, number]>();
  const key = (i: number) =>
    `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let n = acc.get(k);
    if (!n) { n = [0, 0, 0]; acc.set(k, n); }
    n[0] += norm.getX(i); n[1] += norm.getY(i); n[2] += norm.getZ(i);
  }
  for (const n of acc.values()) {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= l; n[1] /= l; n[2] /= l;
  }
  for (let i = 0; i < pos.count; i++) {
    const n = acc.get(key(i))!;
    norm.setXYZ(i, n[0], n[1], n[2]);
  }
  norm.needsUpdate = true;
}

function firstGeometry(root: THREE.Object3D): THREE.BufferGeometry | undefined {
  let g: THREE.BufferGeometry | undefined;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !g) g = m.geometry;
  });
  return g;
}

function CleanBubble() {
  const { scene } = useGLTF("/models/hero-preview.glb");
  const geometry = useMemo(() => firstGeometry(scene), [scene]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#EBE5F0"),
        roughness: 0.92,
        metalness: 0.0,
      }),
    [],
  );
  const check = useCheckTexture();
  if (!geometry) return null;
  return (
    <group rotation={OBJ_ROT}>
      <mesh geometry={geometry} material={material} castShadow receiveShadow>
        <Decal position={DECAL_POS} rotation={DECAL_ROT} scale={DECAL_SCALE} debug={DECAL_DEBUG}>
          <meshStandardMaterial
            map={check}
            transparent
            polygonOffset
            polygonOffsetFactor={-10}
            roughness={0.85}
            metalness={0}
            toneMapped={false}
          />
        </Decal>
      </mesh>
    </group>
  );
}

function RawModel() {
  const { scene } = useGLTF("/models/hero.glb");
  const object = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={object} />;
}

// The chosen hero: the "messenger" mascot (image→3D from V2). Two post-fixes: smooth
// vertex normals (kills low-poly shading facets) + a recolored base texture whose
// saturated violet envelope is pulled to the brand accent (#6E5FCE periwinkle).
function MascotModel() {
  const { scene } = useGLTF("/models/mascot.glb");
  const tinted = useTexture("/models/mascot-tex.png");
  const object = useMemo(() => {
    tinted.flipY = false; // GLTF UV convention
    tinted.colorSpace = THREE.SRGBColorSpace;
    tinted.needsUpdate = true;
    const s = scene.clone(true);
    s.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        smoothNormalsAcrossSeams(m.geometry);
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat) {
          mat.map = tinted;
          mat.needsUpdate = true;
        }
      }
    });
    return s;
  }, [scene, tinted]);
  return <primitive object={object} />;
}

export default function ObjectInspector() {
  const [idx, setIdx] = useState(0);

  return (
    <div className="oi">
      <style>{CSS}</style>

      <div className="oi-head">
        <span className="oi-mark">Lumenia</span>
        <span className="oi-sub">Hero object: three.js inspector</span>
        <div className="oi-tabs">
          {["Mascot (V2)", "Bubble (clean)", "Bubble (raw)"].map((label, i) => (
            <button
              key={label}
              className={i === idx ? "oi-tab oi-tab-on" : "oi-tab"}
              onClick={() => setIdx(i)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="oi-stage">
        <Canvas
          key={String(idx)}
          shadows
          dpr={[1, 2]}
          style={{ position: "absolute", inset: 0 }}
          gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
          camera={{ position: [1.0, 0.35, 2.9], fov: 34 }}
        >
          <color attach="background" args={["#F5F3EF"]} />
          <hemisphereLight args={["#ffffff", "#d8cfe6", 1.15]} />
          <directionalLight
            position={[4, 6, 6]}
            intensity={2.2}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
          />
          <directionalLight position={[-6, 2, -2]} intensity={0.6} color="#c9bff0" />
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.2}>
              {idx === 0 ? <MascotModel /> : idx === 1 ? <CleanBubble /> : <RawModel />}
            </Bounds>
            <ContactShadows position={[0, -1.0, 0]} opacity={0.3} scale={7} blur={2.8} far={3.5} />
          </Suspense>
          <OrbitControls makeDefault autoRotate autoRotateSpeed={0.8} enablePan={false} minDistance={1.6} maxDistance={7} />
        </Canvas>
      </div>

      <p className="oi-note">
        Drag to orbit · scroll to zoom. Ground = Periwinkle paper #F5F3EF. “Clean ceramic” =
        three.js material override + canvas-drawn accent Decal (baked Meshy texture discarded).
      </p>
    </div>
  );
}

if (typeof window !== "undefined") {
  useGLTF.preload("/models/mascot.glb");
  useGLTF.preload("/models/hero-preview.glb");
  useGLTF.preload("/models/hero.glb");
}

const CSS = `
.oi{--paper:#F5F3EF;--ink:#1E1B22;--muted:#67626E;--accent:#6E5FCE;--accent-soft:#E8E3F7;--line:#E5DFE8;
  min-height:100dvh;background:var(--paper);color:var(--ink);
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;display:flex;flex-direction:column}
.oi-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:18px clamp(18px,4vw,36px);border-bottom:1px solid var(--line)}
.oi-mark{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:20px;letter-spacing:-.02em}
.oi-sub{font-size:13px;color:var(--muted);letter-spacing:.02em}
.oi-tabs{margin-left:auto;display:flex;gap:8px}
.oi-tab{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:10px;cursor:pointer;
  border:1px solid var(--line);background:#FBFAF8;color:var(--muted)}
.oi-tab-on{background:var(--accent-soft);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 30%,var(--line))}
.oi-stage{flex:1;min-height:0;position:relative;
  background:
    radial-gradient(58% 46% at 50% 42%, color-mix(in srgb,var(--accent) 12%,transparent), transparent 72%),
    var(--paper)}
.oi-stage canvas{display:block}
.oi-note{padding:12px clamp(18px,4vw,36px);border-top:1px solid var(--line);
  font-size:12px;color:var(--muted);letter-spacing:.02em;line-height:1.5}
`;
