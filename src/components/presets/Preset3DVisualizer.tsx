'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';

export interface PanelLegend {
  label: string;
  color: number;
  active: boolean;
}

export interface BuildHelpers {
  addBox: (
    w: number, h: number, d: number,
    material: THREE.Material,
    x: number, y: number, z: number,
  ) => THREE.Mesh;
  activeMat: (color: number, opacity?: number) => THREE.MeshStandardMaterial;
  ghostMat: () => THREE.MeshStandardMaterial;
}

export type PresetRenderer = (
  group: THREE.Group,
  fd: Record<string, any>,
  h: BuildHelpers,
) => PanelLegend[];

export const VIZ_COLORS = {
  amber:   0xEF9F27,
  teal:    0x5DCAA5,
  blue:    0x85B7EB,
  purple:  0xAFA9EC,
  coral:   0xF0997B,
  pink:    0xED93B1,
  green:   0x97C459,
  red:     0xE24B4A,
  ghost:   0x334455,
} as const;

function makeHelpers(group: THREE.Group): BuildHelpers {
  return {
    addBox(w, h, d, material, x, y, z) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      group.add(mesh);
      return mesh;
    },
    activeMat(color, opacity = 1) {
      return new THREE.MeshStandardMaterial({
        color, roughness: 0.65, metalness: 0,
        transparent: opacity < 1, opacity,
      });
    },
    ghostMat() {
      return new THREE.MeshStandardMaterial({
        color: VIZ_COLORS.ghost, roughness: 0.9, metalness: 0,
        transparent: true, opacity: 0.15,
      });
    },
  };
}

// ─── Carcass Renderer ──────────────────────────────────────────────────────────

const buildCarcass: PresetRenderer = (group, fd, { activeMat }) => {
  const W = (parseFloat(fd.width ?? 600) || 600) / 1000;
  const H = (parseFloat(fd.height ?? 720) || 720) / 1000;
  const D = (parseFloat(fd.depth ?? 550) || 550) / 1000;
  const T = (parseFloat(fd.panelThickness ?? 18) || 18) / 1000;
  
  const iW = W - 2 * T;
  const iH = H - 2 * T;
  const iD = D - T;
  
  const shelves = Math.max(0, Math.min(8, parseInt(fd.shelfCount ?? 2) || 0));
  const doorCount = Math.max(1, Math.min(4, parseInt(fd.doorCount ?? 2) || 2));
  const drawerCount = Math.max(1, Math.min(6, parseInt(fd.drawerCount ?? 2) || 2));
  const dividerCount = Math.max(1, Math.min(3, parseInt(fd.dividerCount ?? 1) || 1));
  
  const maxDim = Math.max(W, H, D);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, -(H * scale) / 2, 0);
  
  const addPanel = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, opacity: number = 1) => {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, transparent: opacity < 1, opacity })
    );
    box.position.set(x, y, z);
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
    return box;
  };
  
  // Back Panel
  if (fd.hasBack) {
    addPanel(0, H / 2, -D / 2 + T / 2, iW, iH, T * 0.8, VIZ_COLORS.amber, 0.85);
  }
  
  // Bottom Panel
  if (fd.hasBottom !== false) {
    addPanel(0, T / 2, 0, iW, T, iD, VIZ_COLORS.teal, 1);
  }
  
  // Top Panel
  if (fd.hasTop !== false) {
    addPanel(0, H - T / 2, 0, iW, T, iD, VIZ_COLORS.teal, 1);
  }
  
  // Left Side Panel
  if (fd.hasLeftSide !== false) {
    addPanel(-W / 2 + T / 2, H / 2, 0, T, H, D, VIZ_COLORS.blue, 1);
  }
  
  // Right Side Panel
  if (fd.hasRightSide !== false) {
    addPanel(W / 2 - T / 2, H / 2, 0, T, H, D, VIZ_COLORS.blue, 1);
  }
  
  // Toe Kick
  if (fd.hasToeKick) {
    addPanel(0, 0.06, D / 2 - 0.03, W, 0.1, 0.06, VIZ_COLORS.pink, 1);
  }
  
  // Shelves
  if (shelves > 0 && iH > 0) {
    const shelfSpacing = iH / (shelves + 1);
    for (let i = 1; i <= shelves; i++) {
      const y = T + i * shelfSpacing;
      addPanel(0, y, 0, iW - 0.01, T, iD, VIZ_COLORS.purple, 0.85);
    }
  }
  
  // Vertical Dividers
  if (fd.hasDivider && dividerCount > 0 && iW > 0) {
    const startX = -iW / 2;
    const step = iW / (dividerCount + 1);
    for (let i = 1; i <= dividerCount; i++) {
      const x = startX + i * step;
      addPanel(x, H / 2, 0, T * 0.8, iH, iD, VIZ_COLORS.purple, 0.7);
    }
  }
  
  // Doors
  if (fd.hasDoors && doorCount > 0) {
    const doorWidth = iW / doorCount;
    const doorHeight = iH;
    const startX = -iW / 2 + doorWidth / 2;
    
    for (let i = 0; i < doorCount; i++) {
      const x = startX + i * doorWidth;
      addPanel(x, H / 2, D / 2 + 0.008, doorWidth - 0.005, doorHeight - 0.01, 0.018, VIZ_COLORS.coral, 0.92);
      
      const handleX = x + (i === 0 ? doorWidth * 0.3 : -doorWidth * 0.3);
      const handleGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.06, 6);
      const handleMat = new THREE.MeshStandardMaterial({ color: 0xc0a060, metalness: 0.7 });
      const handle = new THREE.Mesh(handleGeo, handleMat);
      handle.position.set(handleX, H / 2, D / 2 + 0.02);
      handle.rotation.z = Math.PI / 2;
      group.add(handle);
    }
  }
  
  // Drawers
  if (fd.hasDrawers && drawerCount > 0 && iH > 0) {
    const drawerHeight = iH / drawerCount;
    for (let i = 0; i < drawerCount; i++) {
      const y = T + drawerHeight * i + drawerHeight / 2;
      addPanel(0, y, D / 2 + 0.008, iW - 0.02, drawerHeight - 0.008, 0.018, VIZ_COLORS.coral, 0.92);
      addPanel(0, y, D / 2 + 0.022, iW / 3, 0.006, 0.008, 0xc0a060, 1);
    }
  }
  
  return [
    { label: 'Back panel',   color: VIZ_COLORS.amber,  active: !!fd.hasBack },
    { label: 'Top / bottom', color: VIZ_COLORS.teal,   active: !!(fd.hasTop !== false || fd.hasBottom !== false) },
    { label: 'Side panels',  color: VIZ_COLORS.blue,   active: !!(fd.hasLeftSide !== false || fd.hasRightSide !== false) },
    { label: 'Shelves',      color: VIZ_COLORS.purple, active: shelves > 0 },
    { label: 'Doors/drawers', color: VIZ_COLORS.coral, active: !!(fd.hasDoors || fd.hasDrawers) },
    { label: 'Toe kick',     color: VIZ_COLORS.pink,   active: !!fd.hasToeKick },
  ];
};

// ─── Registry ──────────────────────────────────────────────────────────────────

export const PRESET_RENDERERS: Record<string, PresetRenderer> = {
  'carcass': buildCarcass,
};

function LegendChip({ label, color, active }: PanelLegend) {
  const hex = '#' + color.toString(16).padStart(6, '0');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      opacity: active ? 1 : 0.28,
    }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: hex, flexShrink: 0 }} />
      <span style={{
        fontSize: 9, fontFamily: 'monospace',
        textTransform: 'uppercase', letterSpacing: '0.07em',
        color: '#888',
        whiteSpace: 'nowrap',
      }}>{label}</span>
    </div>
  );
}

interface Preset3DVisualizerProps {
  presetId: string;
  formData: Record<string, any>;
  height?: number;
}

export default function Preset3DVisualizer({
  presetId,
  formData,
  height = 400,
}: Preset3DVisualizerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const rafRef = useRef<number>(0);
  const orbitRef = useRef({ phi: 0.45, theta: 0.62, radius: 2.4, dragging: false, prevX: 0, prevY: 0 });
  const [legend, setLegend] = React.useState<PanelLegend[]>([]);

  const updateCameraPos = useCallback((cam: THREE.PerspectiveCamera) => {
    const { phi, theta, radius } = orbitRef.current;
    cam.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta)
    );
    cam.lookAt(0, 0, 0);
  }, []);

  // Initialize Three.js
  useEffect(() => {
    if (!mountRef.current) return;
    
    const W = mountRef.current.clientWidth;
    const H = height;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x0a0a0a, 1);
    mountRef.current.innerHTML = '';
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);
    
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(2, 3, 2);
    keyLight.castShadow = true;
    scene.add(keyLight);
    
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-2, 1, -1);
    scene.add(fillLight);
    
    const rimLight = new THREE.DirectionalLight(0xffa020, 0.25);
    rimLight.position.set(0, -2, 1);
    scene.add(rimLight);

    const gridHelper = new THREE.GridHelper(4, 24, 0x2a2a2a, 0x1a1a1a);
    gridHelper.position.y = -0.05;
    scene.add(gridHelper);

    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
    updateCameraPos(camera);
    cameraRef.current = camera;

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    const onResize = () => {
      if (!mountRef.current || !rendererRef.current || !cameraRef.current) return;
      const nW = mountRef.current.clientWidth;
      rendererRef.current.setSize(nW, H);
      cameraRef.current.aspect = nW / H;
      cameraRef.current.updateProjectionMatrix();
    };
    
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mountRef.current);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(rafRef.current);
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (mountRef.current) {
        mountRef.current.innerHTML = '';
      }
    };
  }, [height, updateCameraPos]);

  // Orbit controls
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    
    const onDown = (e: MouseEvent) => {
      orbitRef.current.dragging = true;
      orbitRef.current.prevX = e.clientX;
      orbitRef.current.prevY = e.clientY;
    };
    const onUp = () => { orbitRef.current.dragging = false; };
    const onMove = (e: MouseEvent) => {
      if (!orbitRef.current.dragging || !cameraRef.current) return;
      orbitRef.current.theta -= (e.clientX - orbitRef.current.prevX) * 0.008;
      orbitRef.current.phi = Math.max(0.05, Math.min(Math.PI * 0.48, 
        orbitRef.current.phi + (e.clientY - orbitRef.current.prevY) * 0.008));
      orbitRef.current.prevX = e.clientX;
      orbitRef.current.prevY = e.clientY;
      updateCameraPos(cameraRef.current);
    };
    const onWheel = (e: WheelEvent) => {
      orbitRef.current.radius = Math.max(0.8, Math.min(6, orbitRef.current.radius + e.deltaY * 0.004));
      if (cameraRef.current) updateCameraPos(cameraRef.current);
      e.preventDefault();
    };
    
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    el.addEventListener('wheel', onWheel, { passive: false });
    
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
      el.removeEventListener('wheel', onWheel);
    };
  }, [updateCameraPos]);

  // Rebuild geometry
  const rebuild = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) (child.geometry as THREE.BufferGeometry).dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
      group.remove(child);
    }

    const renderer = PRESET_RENDERERS[presetId];
    if (!renderer) return;

    const helpers = makeHelpers(group);
    const newLegend = renderer(group, formData, helpers);
    setLegend(newLegend);
  }, [presetId, formData]);

  useEffect(() => { rebuild(); }, [rebuild]);

  const hasRenderer = !!PRESET_RENDERERS[presetId];

  return (
    <div style={{ 
      borderRadius: '8px', 
      overflow: 'hidden', 
      border: '1px solid #2a2a2a', 
      background: '#0a0a0a',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div
        ref={mountRef}
        style={{ width: '100%', height, cursor: 'grab', position: 'relative', flexShrink: 0 }}
      >
        {!hasRenderer && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace', fontSize: 11,
            textTransform: 'uppercase',
          }}>
            No 3D renderer for "{presetId}"
          </div>
        )}
        <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'none' }}>
          <div style={{
            background: 'rgba(0,0,0,0.65)', border: '0.5px solid rgba(239,159,39,0.35)',
            color: '#EF9F27', fontSize: 9, fontFamily: 'monospace',
            padding: '2px 7px', textTransform: 'uppercase',
          }}>
            {presetId.replace('-', ' ')}
          </div>
          <div style={{
            background: 'rgba(0,0,0,0.65)', border: '0.5px solid rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.4)', fontSize: 9, fontFamily: 'monospace',
            padding: '2px 7px',
          }}>
            drag · scroll
          </div>
        </div>
      </div>

      {legend.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '6px 14px',
          padding: '8px 12px',
          borderTop: '0.5px solid rgba(255,255,255,0.06)',
          background: '#0d0d0d',
          flexShrink: 0,
        }}>
          {legend.map((l, i) => <LegendChip key={i} {...l} />)}
        </div>
      )}
    </div>
  );
}