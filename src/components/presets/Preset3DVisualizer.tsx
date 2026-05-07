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

// ─── Door Renderer ─────────────────────────────────────────────────────────────

const buildDoor: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const qty = Math.max(1, Math.min(4, parseInt(fd.quantity ?? 1) || 1));
  const widthMm = parseFloat(fd.width?.replace('mm', '') ?? 800) || 800;
  const heightMm = parseFloat(fd.height?.replace('mm', '') ?? 2100) || 2100;
  const W = widthMm / 1000;
  const H = heightMm / 1000;
  const frameDepth = 0.08;
  const doorThickness = 0.04;

  const maxDim = Math.max(W, H, frameDepth);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, -(H * scale) / 2, 0);

  // Render qty doors side by side
  const spacing = W + 0.2;
  for (let i = 0; i < qty; i++) {
    const offsetX = (i - (qty - 1) / 2) * spacing;
    
    // Door frame
    addBox(W, H, frameDepth, activeMat(0x8B7355), offsetX, H / 2, 0);
    
    // Door leaf (different color based on material)
    let doorColor = 0xD2B48C; // Wood
    if (fd.material === 'Steel') doorColor = 0xA9A9A9;
    if (fd.material === 'Aluminium') doorColor = 0xC0C0C0;
    if (fd.material === 'Glass') doorColor = 0xE8F4F8;
    
    addBox(W - 0.04, H - 0.04, doorThickness, activeMat(doorColor, fd.material === 'Glass' ? 0.3 : 1), offsetX, H / 2, frameDepth / 2);
  }

  return [
    { label: 'Frame',    color: 0x8B7355, active: true },
    { label: fd.material || 'Door', color: 0xD2B48C, active: true },
    { label: 'Fire/Acoustic', color: VIZ_COLORS.blue, active: !!fd.fireRating },
  ];
};

// ─── Window Renderer ───────────────────────────────────────────────────────────

const buildWindow: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const qty = Math.max(1, Math.min(6, parseInt(fd.quantity ?? 1) || 1));
  const widthMm = parseFloat(fd.width?.replace('mm', '') ?? 1200) || 1200;
  const heightMm = parseFloat(fd.height?.replace('mm', '') ?? 900) || 900;
  const W = widthMm / 1000;
  const H = heightMm / 1000;
  const frameWidth = 0.06;
  const glassThickness = 0.01;

  const maxDim = Math.max(W, H, frameWidth * 3);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, -(H * scale) / 2, 0);

  const spacing = W + 0.25;
  for (let i = 0; i < qty; i++) {
    const offsetX = (i - (qty - 1) / 2) * spacing;
    
    // Window frame
    addBox(W, H, frameWidth, activeMat(0x8B7355), offsetX, H / 2, 0);
    
    // Glass panes
    const glassColor = 0xADD8E6;
    addBox(W - frameWidth * 2, (H - frameWidth * 3) / 2, glassThickness, activeMat(glassColor, 0.4), offsetX, H * 0.7, frameWidth / 2);
    addBox(W - frameWidth * 2, (H - frameWidth * 3) / 2, glassThickness, activeMat(glassColor, 0.4), offsetX, H * 0.3, frameWidth / 2);
  }

  return [
    { label: 'Frame',  color: 0x8B7355, active: true },
    { label: 'Glass',  color: 0xADD8E6, active: true },
    { label: fd.glassType || 'Type', color: VIZ_COLORS.blue, active: !!fd.glassType },
  ];
};

// ─── Stud Wall Renderer ────────────────────────────────────────────────────────

const buildStudWall: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const L = (parseFloat(fd.length ?? 0) || 5000) / 1000;
  const H = (parseFloat(fd.height ?? 0) || 2700) / 1000;
  const isCustom = fd.spacing === 'Custom';
  const spacing = (isCustom ? parseInt(fd.customSpacing ?? 600) : (fd.spacing === '600mm' ? 600 : 450)) / 1000;
  const thickness = (parseFloat(fd.thickness?.replace('mm', '') ?? 70) || 70) / 1000;
  const studCount = Math.ceil(L / spacing) + 1;

  const maxDim = Math.max(L, H, thickness);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, -(H * scale) / 2, 0);

  // Top and bottom plates
  addBox(L, thickness, thickness, activeMat(0x8B6F47), 0, H, 0);
  addBox(L, thickness, thickness, activeMat(0x8B6F47), 0, 0, 0);

  // Studs
  for (let i = 0; i <= studCount; i++) {
    const x = -L / 2 + (i * spacing);
    if (x >= -L / 2 && x <= L / 2) {
      addBox(thickness, H, thickness, activeMat(0xA0826D), x, H / 2, 0);
    }
  }

  // Plasterboard (face)
  if (fd.facePlasterboard) {
    addBox(L, H, 0.01, activeMat(0xE8E8E0, 0.7), 0, H / 2, thickness / 2 + 0.01);
  }

  return [
    { label: 'Studs',        color: 0xA0826D, active: true },
    { label: 'Plates',       color: 0x8B6F47, active: true },
    { label: 'Plasterboard', color: 0xE8E8E0, active: !!fd.facePlasterboard },
  ];
};

// ─── Floor Slab Renderer ──────────────────────────────────────────────────────

const buildFloorSlab: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const L = (parseFloat(fd.length ?? 0) || 10000) / 1000;
  const W = (parseFloat(fd.width ?? 0) || 8000) / 1000;
  const thicknessMm = parseInt(fd.thickness ?? 150) || 150;
  const H = thicknessMm / 1000;

  const maxDim = Math.max(L, W, H);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, -H * scale / 2, 0);

  // Main slab
  addBox(L, H, W, activeMat(0x7B8FA3), 0, H / 2, 0);

  // Reinforcement grid visualization
  const gridSpacing = 0.3;
  for (let x = -L / 2; x <= L / 2; x += gridSpacing) {
    addBox(0.01, H * 0.1, W, activeMat(0xD4AF37, 0.3), x, H, 0);
  }
  for (let z = -W / 2; z <= W / 2; z += gridSpacing) {
    addBox(L, H * 0.1, 0.01, activeMat(0xD4AF37, 0.3), 0, H, z);
  }

  return [
    { label: 'Concrete', color: 0x7B8FA3, active: true },
    { label: 'Reinforcement', color: 0xD4AF37, active: true },
  ];
};

// ─── Beam Renderer ────────────────────────────────────────────────────────────

const buildBeam: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const qty = Math.max(1, Math.min(5, parseInt(fd.quantity ?? 1) || 1));
  const length = (parseFloat(fd.length ?? 0) || 6000) / 1000;
  const beamType = fd.beamType || 'I-Beam';
  
  // Different dimensions based on beam type
  let h = 0.3, w = 0.15; // Default I-Beam
  if (beamType === 'H-Beam') { h = 0.35; w = 0.35; }
  if (beamType === 'Channel') { h = 0.25; w = 0.1; }
  if (beamType === 'Box') { h = 0.3; w = 0.3; }

  const maxDim = Math.max(length, h, w * 2);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, 0, 0);

  const spacing = w + 0.3;
  const startZ = -(qty - 1) * spacing / 2;

  for (let i = 0; i < qty; i++) {
    const offsetZ = startZ + i * spacing;
    
    let color = 0x808080;
    if (fd.material === 'Concrete') color = 0x7B8FA3;
    if (fd.material === 'Timber') color = 0x8B6F47;
    
    addBox(length, h, w, activeMat(color), 0, 0, offsetZ);
  }

  return [
    { label: beamType, color: 0x808080, active: true },
    { label: 'Fire Protection', color: VIZ_COLORS.red, active: fd.fireProtection !== 'None' },
  ];
};

// ─── Tiling Renderer ──────────────────────────────────────────────────────────

const buildTiling: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const area = parseFloat(fd.area ?? 0) || 10;
  const tileSizeStr = fd.tileSize || '300x300';
  const tileMm = parseInt(tileSizeStr.split('x')[0]) || 300;
  const tileM = tileMm / 1000;

  const L = Math.sqrt(area);
  const W = area / L;
  const tilesPerRow = Math.ceil(L / tileM);
  const tilesPerCol = Math.ceil(W / tileM);

  const maxDim = Math.max(L, W, 0.05);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, 0, 0);

  let tileColor = 0xCEA882;
  if (fd.material === 'Porcelain') tileColor = 0xF5F5F5;
  if (fd.material === 'Glass') tileColor = 0xE0F6FF;
  if (fd.material === 'Natural Stone') tileColor = 0x8B7355;

  // Draw tile grid
  for (let x = 0; x < tilesPerRow; x++) {
    for (let y = 0; y < tilesPerCol; y++) {
      const posX = -L / 2 + (x + 0.5) * tileM;
      const posY = -W / 2 + (y + 0.5) * tileM;
      addBox(tileM * 0.95, 0.01, tileM * 0.95, activeMat(tileColor), posX, 0.005, posY);
    }
  }

  return [
    { label: fd.material || 'Tile', color: tileColor, active: true },
    { label: `${fd.tileSize}`, color: 0x888888, active: true },
  ];
};

// ─── Roof Renderer ────────────────────────────────────────────────────────────

const buildRoof: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const area = parseFloat(fd.roofArea ?? 100) || 100;
  const pitch = parseFloat(fd.roofPitch ?? 30) || 30;
  const pitchRad = (pitch * Math.PI) / 180;
  
  const L = Math.sqrt(area * 2);
  const W = area / (L / 2);
  const H = (W / 2) * Math.tan(pitchRad);

  const maxDim = Math.max(L, W, H * 2);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, 0, 0);

  // Rafters (frame structure)
  addBox(L, 0.1, 0.15, activeMat(0x8B6F47), 0, H / 2, 0);
  
  // Roof covering (sloped panels)
  const roofColor = fd.material === 'Slate' ? 0x4A4A4A : fd.material === 'Metal' ? 0x8B8B8B : fd.material === 'Asphalt' ? 0x333333 : 0x8B4513;
  addBox(L * 0.95, 0.02, W * 0.9, activeMat(roofColor), 0, H, 0);

  // Ridge board
  addBox(0.2, H, 0.2, activeMat(0xA0826D), 0, H / 2, 0);

  return [
    { label: 'Rafters',   color: 0x8B6F47, active: true },
    { label: 'Covering',  color: roofColor, active: true },
    { label: 'Insulation', color: VIZ_COLORS.blue, active: !!fd.insulation },
  ];
};

// ─── Ceiling Renderer ──────────────────────────────────────────────────────────

const buildCeiling: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const area = parseFloat(fd.area ?? 50) || 50;
  const L = Math.sqrt(area);
  const W = area / L;

  const maxDim = Math.max(L, W, 0.3);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, 0, 0);

  let ceilingColor = 0xF5F5F5;
  if (fd.material === 'Timber') ceilingColor = 0xD2B48C;
  if (fd.material === 'Metal') ceilingColor = 0xC0C0C0;
  if (fd.material === 'Plaster') ceilingColor = 0xEBEBEB;

  // Main ceiling slab
  addBox(L, 0.02, W, activeMat(ceilingColor), 0, 0, 0);

  // Support grid (if suspended)
  if (fd.type === 'Suspended') {
    const gridSpacing = 1.2;
    for (let x = -L / 2; x <= L / 2; x += gridSpacing) {
      addBox(0.04, 0.15, W, activeMat(0x8B8B8B, 0.6), x, -0.08, 0);
    }
    for (let z = -W / 2; z <= W / 2; z += gridSpacing) {
      addBox(L, 0.04, 0.15, activeMat(0x8B8B8B, 0.6), 0, -0.08, z);
    }
  }

  return [
    { label: fd.material || 'Ceiling', color: ceilingColor, active: true },
    { label: 'Support Structure', color: 0x8B8B8B, active: fd.type === 'Suspended' },
  ];
};

// ─── Staircase Renderer ────────────────────────────────────────────────────────

const buildStaircase: PresetRenderer = (group, fd, { activeMat, addBox }) => {
  const steps = parseInt(fd.steps ?? 12) || 12;
  const riserHeight = (parseFloat(fd.riserHeight ?? 200) || 200) / 1000;
  const treadsDepth = (parseFloat(fd.treadsDepth ?? 300) || 300) / 1000;
  const width = (parseFloat(fd.width ?? 900) || 900) / 1000;
  
  const totalHeight = steps * riserHeight;
  const totalLength = steps * treadsDepth;

  const maxDim = Math.max(totalLength, totalHeight, width);
  const scale = 0.85 / maxDim;
  group.scale.setScalar(scale);
  group.position.set(0, 0, 0);

  // Stringers (side supports)
  addBox(0.05, totalHeight, 0.3, activeMat(0x8B6F47), -width / 2, totalHeight / 2, 0);
  addBox(0.05, totalHeight, 0.3, activeMat(0x8B6F47), width / 2, totalHeight / 2, 0);

  // Steps
  const treadColor = fd.material === 'Metal' ? 0x8B8B8B : fd.material === 'Concrete' ? 0x7B8FA3 : 0xD2B48C;
  for (let i = 0; i < steps; i++) {
    const y = (i + 0.5) * riserHeight;
    const z = (i + 0.5) * treadsDepth - (totalLength / 2);
    addBox(width, 0.02, treadsDepth * 0.95, activeMat(treadColor), 0, y, z);
    
    // Riser
    const riserY = (i + 1) * riserHeight - riserHeight / 2;
    addBox(width, riserHeight * 0.98, 0.02, activeMat(0xA0826D), 0, riserY, z + treadsDepth * 0.5);
  }

  // Handrail
  addBox(0.03, 0.03, totalLength, activeMat(0xC0C0C0, 0.8), 0, totalHeight * 0.85, 0);

  return [
    { label: 'Treads',      color: treadColor,  active: true },
    { label: 'Stringers',   color: 0x8B6F47,    active: true },
    { label: 'Handrail',    color: 0xC0C0C0,    active: true },
  ];
};

// ─── Registry ──────────────────────────────────────────────────────────────────

export const PRESET_RENDERERS: Record<string, PresetRenderer> = {
  'carcass': buildCarcass,
  'door': buildDoor,
  'window': buildWindow,
  'stud-wall': buildStudWall,
  'floor-slab': buildFloorSlab,
  'beam': buildBeam,
  'tiling': buildTiling,
  'roof': buildRoof,
  'ceiling': buildCeiling,
  'staircase': buildStaircase,
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
