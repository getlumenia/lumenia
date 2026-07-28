/**
 * AvatarShowcase — the 5 Lumenia avatars (the messenger + 4 pose variations), each a
 * Meshy image→3D model, brought alive with PROCEDURAL idle motion in three.js (gentle
 * bob + sway, phase-offset per avatar). Meshy skeletal rigging fails on this stylised
 * non-humanoid blob ("pose estimation failed"), and procedural idle is the right fit
 * for a website mascot anyway. Smooth normals kill the low-poly facets; the messenger
 * also gets its envelope recoloured to the accent (shared mascot-tex.png).
 *
 * `ANIMATE` gates the idle loop so the doc can render a static, screenshot-friendly frame.
 */
"use client";

import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, useTexture, ContactShadows } from "@react-three/drei";
import type { Group } from "three";

export type AvatarDef = { url: string; label: string; note: string; tex?: string };

export const AVATARS: AvatarDef[] = [
  { url: "/models/mascot.glb", tex: "/models/mascot-tex.png", label: "The messenger", note: "hands you the envelope, the hero" },
  { url: "/models/avatar-wave.glb", label: "Wave", note: "welcome / onboarding" },
  { url: "/models/avatar-phone.glb", label: "Tap", note: "tap the link, the claim moment" },
  { url: "/models/avatar-celebrate.glb", label: "Celebrate", note: "money received" },
  { url: "/models/avatar-thumbsup.glb", label: "Thumbs-up", note: "trust / all good" },
  { url: "/models/avatar-point.glb", label: "Point", note: "guiding / onboarding" },
  { url: "/models/avatar-heart.glb", label: "Heart", note: "thank you / grateful" },
];

function smoothNormals(geo: THREE.BufferGeometry) {
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
  for (const n of acc.values()) { const l = Math.hypot(...n) || 1; n[0] /= l; n[1] /= l; n[2] /= l; }
  for (let i = 0; i < pos.count; i++) { const n = acc.get(key(i))!; norm.setXYZ(i, n[0], n[1], n[2]); }
  norm.needsUpdate = true;
}

function Avatar({ url, tex, phase, animate }: { url: string; tex?: string; phase: number; animate: boolean }) {
  const { scene } = useGLTF(url);
  const tinted = useTexture(tex ?? "/models/mascot-tex.png");
  const ref = useRef<Group>(null);

  const object = useMemo(() => {
    const s = scene.clone(true);
    if (tex) {
      tinted.flipY = false;
      tinted.colorSpace = THREE.SRGBColorSpace;
      tinted.needsUpdate = true;
    }
    s.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        smoothNormals(m.geometry);
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat && tex) { mat.map = tinted; mat.needsUpdate = true; }
      }
    });
    // normalize: fit height ~1.9, centre at origin
    const box = new THREE.Box3().setFromObject(s);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const scale = 1.9 / (size.y || 1);
    s.scale.setScalar(scale);
    s.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    return s;
  }, [scene, tinted, tex]);

  useFrame((state) => {
    if (!ref.current || !animate) return;
    const t = state.clock.elapsedTime + phase;
    ref.current.position.y = Math.sin(t * 1.1) * 0.06;
    ref.current.rotation.z = Math.sin(t * 0.7) * 0.035;
    ref.current.rotation.y = Math.sin(t * 0.5) * 0.12;
  });

  return (
    <group ref={ref}>
      <primitive object={object} />
    </group>
  );
}

function AvatarCanvas({ url, tex, phase, animate }: { url: string; tex?: string; phase: number; animate: boolean }) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      frameloop={animate ? "always" : "demand"}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      camera={{ position: [0.35, 0.15, 3.5], fov: 32 }}
      style={{ position: "absolute", inset: 0 }}
    >
      <hemisphereLight args={["#ffffff", "#d8cfe6", 1.15]} />
      <directionalLight position={[4, 6, 6]} intensity={2.1} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
      <directionalLight position={[-6, 2, -2]} intensity={0.55} color="#c9bff0" />
      <Suspense fallback={null}>
        <Avatar url={url} tex={tex} phase={phase} animate={animate} />
        <ContactShadows position={[0, -1.02, 0]} opacity={0.26} scale={5} blur={2.8} far={3} />
      </Suspense>
    </Canvas>
  );
}

export default function AvatarShowcase({ animate = true }: { animate?: boolean }) {
  return (
    <div className="av-grid">
      <style>{CSS}</style>
      {AVATARS.map((a, i) => (
        <figure key={a.url} className={i === 0 ? "av-card av-hero" : "av-card"}>
          <div className="av-stage">
            <AvatarCanvas url={a.url} tex={a.tex} phase={i * 1.3} animate={animate} />
          </div>
          <figcaption>
            <b>{a.label}</b>
            <span>{a.note}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

if (typeof window !== "undefined") {
  AVATARS.forEach((a) => useGLTF.preload(a.url));
}

const CSS = `
.av-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:14px}
@media (max-width:640px){.av-grid{grid-template-columns:1fr 1fr}}
.av-card{background:#FBFAF8;border:1px solid #E5DFE8;border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
.av-hero{border-color:color-mix(in srgb,#6E5FCE 45%,#E5DFE8);box-shadow:0 0 0 1px color-mix(in srgb,#6E5FCE 30%,transparent)}
.av-stage{position:relative;width:100%;aspect-ratio:3/4;
  background:radial-gradient(58% 52% at 50% 46%, color-mix(in srgb,#6E5FCE 12%,transparent), transparent 72%), #F5F3EF}
.av-card figcaption{padding:11px 13px;display:flex;flex-direction:column;gap:2px}
.av-card figcaption b{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:15px;color:#1E1B22}
.av-card figcaption span{font-size:12px;color:#67626E}
`;
