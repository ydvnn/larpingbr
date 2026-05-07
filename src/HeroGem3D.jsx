import { Canvas, useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

const OCT_VERTICES = [
  [0, 1.3, 0],
  [0, -1.3, 0],
  [1.3, 0, 0],
  [-1.3, 0, 0],
  [0, 0, 1.3],
  [0, 0, -1.3]
];

const OCT_EDGES = [
  [0, 2], [0, 3], [0, 4], [0, 5],
  [1, 2], [1, 3], [1, 4], [1, 5],
  [2, 4], [4, 3], [3, 5], [5, 2]
];

function PulsingEdge({
  start,
  end,
  baseOpacity = 0.22,
  pulseSpeed = 0.45,
  phase = 0,
  dotCount = 14,
  dotSize = 0.038,
  reverse = false,
  hueOffset = 0,
  pulseEnabled = true
}) {
  const dots = useMemo(() => {
    const a = reverse ? end : start;
    const b = reverse ? start : end;
    const result = [];
    for (let i = 0; i < dotCount; i++) {
      const t = (i + 0.5) / dotCount;
      result.push({
        t,
        pos: [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t
        ]
      });
    }
    return result;
  }, [start, end, dotCount, reverse]);

  const matRefs = useRef([]);
  const meshRefs = useRef([]);
  const haloMatRefs = useRef([]);
  const haloMeshRefs = useRef([]);
  const staticInitialized = useRef(false);

  useFrame(({ clock }) => {
    if (!pulseEnabled) {
      if (staticInitialized.current) return;
      dots.forEach((_, i) => {
        const mat = matRefs.current[i];
        const mesh = meshRefs.current[i];
        const haloMat = haloMatRefs.current[i];
        if (mat) {
          mat.color.setHSL(0, 0, 0.85);
          mat.opacity = baseOpacity;
        }
        if (mesh) mesh.scale.setScalar(0.82);
        if (haloMat) haloMat.opacity = 0;
      });
      staticInitialized.current = true;
      return;
    }
    staticInitialized.current = false;

    const pulseT = (clock.elapsedTime * pulseSpeed + phase) % 1;
    const sigmaLead = 0.04;
    const tauTrail = 0.6;
    const t = clock.elapsedTime;

    dots.forEach((dot, i) => {
      const mat = matRefs.current[i];
      const mesh = meshRefs.current[i];
      if (!mat || !mesh) return;

      let dist = pulseT - dot.t;
      if (dist > 0.5) dist -= 1;
      else if (dist < -0.5) dist += 1;

      const intensity =
        dist < 0
          ? Math.exp(-(dist * dist) / (2 * sigmaLead * sigmaLead))
          : Math.exp(-dist / tauTrail);

      const sigmaHead = 0.022;
      const headIntensity = Math.exp(-(dist * dist) / (2 * sigmaHead * sigmaHead));

      const hue = (t * 0.07 + phase + dot.t * 0.22 + hueOffset) % 1;
      mat.color.setHSL(hue, 0.4, 0.85);
      mat.opacity = baseOpacity + (1 - baseOpacity) * intensity;
      mesh.scale.setScalar(0.82 + intensity * 0.55);

      const haloMat = haloMatRefs.current[i];
      const haloMesh = haloMeshRefs.current[i];
      if (haloMat && haloMesh) {
        haloMat.color.setHSL(hue, 0.32, 0.9);
        haloMat.opacity = headIntensity * 0.2;
        haloMesh.scale.setScalar(0.6 + headIntensity * 0.7);
      }
    });
  });

  return (
    <>
      {dots.map((dot, i) => (
        <group key={i} position={dot.pos}>
          <mesh ref={(el) => (haloMeshRefs.current[i] = el)}>
            <sphereGeometry args={[dotSize * 2.4, 12, 12]} />
            <meshBasicMaterial
              ref={(el) => (haloMatRefs.current[i] = el)}
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
          <mesh ref={(el) => (meshRefs.current[i] = el)}>
            <sphereGeometry args={[dotSize, 8, 8]} />
            <meshBasicMaterial
              ref={(el) => (matRefs.current[i] = el)}
              transparent
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}

function WireOctahedron({
  scale = 1,
  baseOpacity = 0.22,
  pulseSpeed = 0.45,
  dotSize = 0.038,
  dotCount = 14,
  hueOffsetBase = 0
}) {
  return (
    <group scale={scale}>
      {OCT_EDGES.map(([a, b], i) => (
        <PulsingEdge
          key={`pe-${i}`}
          start={OCT_VERTICES[a]}
          end={OCT_VERTICES[b]}
          baseOpacity={baseOpacity}
          pulseSpeed={pulseSpeed}
          phase={(i * 0.137) % 1}
          reverse={i % 2 === 1}
          dotCount={dotCount}
          dotSize={dotSize}
          hueOffset={(hueOffsetBase + i * 0.083) % 1}
          pulseEnabled={i % 2 === 0}
        />
      ))}
    </group>
  );
}

function Gem() {
  const outerRef = useRef();
  const innerRef = useRef();

  useFrame((_, delta) => {
    if (outerRef.current) {
      outerRef.current.rotation.y += delta * 0.45;
    }
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.6;
      innerRef.current.rotation.x += delta * 0.25;
    }
  });

  return (
    <group rotation={[-0.22, 0, 0]}>
      <Float speed={1.0} rotationIntensity={0.22} floatIntensity={0.28}>
        <group ref={outerRef}>
          <WireOctahedron
            baseOpacity={0.5}
            pulseSpeed={0.4}
            dotSize={0.006}
            dotCount={48}
            hueOffsetBase={0}
          />
        </group>
        <group ref={innerRef}>
          <WireOctahedron
            scale={0.58}
            baseOpacity={0.6}
            pulseSpeed={0.6}
            dotSize={0.0105}
            dotCount={28}
            hueOffsetBase={0.42}
          />
        </group>
      </Float>
    </group>
  );
}

export default function HeroGem3D() {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 6.2], fov: 30 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: "transparent" }}
    >
      <ambientLight intensity={1} />
      <Gem />
    </Canvas>
  );
}
