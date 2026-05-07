// hooks/usePresetTakeoff.ts
import { useCallback } from 'react';
import { TakeoffRow, Drawing } from '@/types';
import { PresetTemplate } from '@/components/presets/PresetTemplates';

interface UsePresetTakeoffProps {
  activeDrawing: Drawing | null;
  addMeasurement: (row: TakeoffRow) => void;
  batchCommitMeasurements: (rows: TakeoffRow[]) => void;
  showToast: (msg: string) => void;
}

interface AddGroupParams {
  headerId: string;
  headerFields: Omit<TakeoffRow, 'id' | 'childIds'>;
  parts: Partial<TakeoffRow>[];
}

export function usePresetTakeoff({
  activeDrawing,
  addMeasurement,
  batchCommitMeasurements,
  showToast,
}: UsePresetTakeoffProps) {
  
  const makeChildId = (groupId: string, index: number) => `${groupId}-child-${index}`;

  const addGroup = useCallback(({ headerId, headerFields, parts }: AddGroupParams) => {
    const childIds = parts.map((_, i) => makeChildId(headerId, i));

    const header: TakeoffRow = {
      ...headerFields,
      id: headerId,
      childIds,
      isGroupHeader: true,
      isExpanded: true,
    } as TakeoffRow;

    const children: TakeoffRow[] = parts.map((part, i) => ({
      unitRate: 0,
      points: [],
      isOverridden: true,
      isVisible: true,
      ...part,
      id: childIds[i],
      parentId: headerId,
      drawingId: headerFields.drawingId,
    } as TakeoffRow));

    batchCommitMeasurements([header, ...children]);
  }, [batchCommitMeasurements]);

  const withPresetData = useCallback((
    part: Partial<TakeoffRow>, 
    templateId: string, 
    fd: Record<string, any>
  ): Partial<TakeoffRow> => ({
    ...part,
    presetId: templateId,
    presetData: fd,
  }), []);

  const bool = (val: any, defaultVal = true): boolean =>
    val === undefined || val === null ? defaultVal : Boolean(val);

  const handleConfirm = useCallback((
    selectedTemplate: PresetTemplate,
    currentFormData: Record<string, any>,
    onSuccess?: () => void
  ) => {
    if (!selectedTemplate) {
      showToast('⚠ SELECT A TEMPLATE FIRST');
      return false;
    }

    if (!activeDrawing) {
      showToast('⚠ SELECT A DRAWING FIRST');
      return false;
    }

    const groupId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const headerId = `${groupId}-header`;
    const t = selectedTemplate;
    const fd = { ...currentFormData };

    // ── CARCASS ──────────────────────────────────────────────────────────────
    if (t.id === 'carcass') {
      const W = parseFloat(String(fd.width ?? 600)) / 1000;
      const H = parseFloat(String(fd.height ?? 720)) / 1000;
      const D = parseFloat(String(fd.depth ?? 550)) / 1000;
      const T = parseFloat(String(fd.panelThickness ?? 18)) / 1000;
      const shelves = parseInt(String(fd.shelfCount ?? 2));
      const doorCount = parseInt(String(fd.doorCount ?? 1));
      const iW = W - 2 * T;
      const iH = H - 2 * T;
      const groupName = `${fd.customName || 'Cabinet'} (${fd.width || 600}×${fd.height || 720}×${fd.depth || 550}mm)`;

      const hasBack = bool(fd.hasBack);
      const hasTop = bool(fd.hasTop);
      const hasBottom = bool(fd.hasBottom);
      const hasLeftSide = bool(fd.hasLeftSide);
      const hasRightSide = bool(fd.hasRightSide);
      const hasDoors = bool(fd.hasDoors, false);
      const hasDrawers = bool(fd.hasDrawers, false);
      const hasToeKick = bool(fd.hasToeKick, false);

      const parts: Partial<TakeoffRow>[] = [];
      if (hasBack) parts.push(withPresetData({ description: 'Back Panel', type: 'Area', quantity: +(iW * iH).toFixed(3), unit: 'm²', category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}`, color: '#85B7EB' }, t.id, fd));
      if (hasTop) parts.push(withPresetData({ description: 'Top Panel', type: 'Area', quantity: +(iW * D).toFixed(3), unit: 'm²', category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}`, color: '#85B7EB' }, t.id, fd));
      if (hasBottom) parts.push(withPresetData({ description: 'Bottom Panel', type: 'Area', quantity: +(iW * D).toFixed(3), unit: 'm²', category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}`, color: '#85B7EB' }, t.id, fd));
      if (hasLeftSide) parts.push(withPresetData({ description: 'Left Side Panel', type: 'Area', quantity: +(D * H).toFixed(3), unit: 'm²', category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}`, color: '#85B7EB' }, t.id, fd));
      if (hasRightSide) parts.push(withPresetData({ description: 'Right Side Panel', type: 'Area', quantity: +(D * H).toFixed(3), unit: 'm²', category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}`, color: '#85B7EB' }, t.id, fd));
      if (shelves > 0) parts.push(withPresetData({ description: `Shelves (${shelves} pcs)`, type: 'Area', quantity: +(iW * D * shelves).toFixed(3), unit: 'm²', category: 'Shelves', notes: `Material: ${fd.shelfMaterial || fd.boardMaterial || '18mm MDF'}`, color: '#85B7EB' }, t.id, fd));
      if (hasDoors) {
        parts.push(withPresetData({ description: `Doors (${doorCount} pcs)`, type: 'Area', quantity: +((W / doorCount) * H * doorCount).toFixed(3), unit: 'm²', category: 'Doors', notes: `Material: ${fd.doorMaterial || 'MDF Primed'}`, color: '#85B7EB' }, t.id, fd));
        parts.push(withPresetData({ description: 'Door Hardware', type: 'Count', quantity: doorCount, unit: 'sets', category: 'Hardware', notes: `Hinges & handles | Type: ${fd.hingeType || 'Concealed'}`, color: '#85B7EB' }, t.id, fd));
      }
      if (hasDrawers) {
        const dc = parseInt(String(fd.drawerCount ?? 2));
        parts.push(withPresetData({ description: `Drawer Fronts (${dc} pcs)`, type: 'Count', quantity: dc, unit: 'pcs', category: 'Drawers', notes: `Material: ${fd.drawerMaterial || 'Match doors'}`, color: '#85B7EB' }, t.id, fd));
        parts.push(withPresetData({ description: 'Drawer Hardware', type: 'Count', quantity: dc, unit: 'sets', category: 'Hardware', notes: 'Drawer slides, handles', color: '#85B7EB' }, t.id, fd));
      }
      let eb = 0;
      if (hasTop) eb += 2 * (iW + D);
      if (hasBottom) eb += 2 * (iW + D);
      if (hasLeftSide) eb += 2 * (D + H);
      if (hasRightSide) eb += 2 * (D + H);
      if (shelves > 0) eb += (2 * iW + D) * shelves;
      if (eb > 0) parts.push(withPresetData({ description: 'Edge Banding', type: 'Length', quantity: +(eb * 1.1).toFixed(2), unit: 'm', category: 'Finishing', notes: `Material: ${fd.edgeTape || 'PVC 0.4mm'} | +10% waste`, color: '#85B7EB' }, t.id, fd));
      parts.push(withPresetData({ description: 'Assembly & Installation', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Labor, cam locks, fixing brackets', color: '#85B7EB' }, t.id, fd));
      if (hasToeKick) parts.push(withPresetData({ description: 'Toe Kick / Plinth', type: 'Length', quantity: W, unit: 'm', category: 'Finishing', notes: `Height: ${fd.kickboardHeight || '100mm'}`, color: '#85B7EB' }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: 1,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete carcass assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#EF9F27',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── WINDOW ──────────────────────────────────────────────────────────────
    else if (t.id === 'window') {
      const qty = Math.max(1, Math.min(10, parseInt(String(fd.quantity ?? 1))));
      const widthMm = parseFloat(String(fd.width ?? 1200));
      const heightMm = parseFloat(String(fd.height ?? 900));
      const W = widthMm / 1000;
      const H = heightMm / 1000;
      
      const framePerimeter = 2 * (W + H);
      const glassArea = W * H;
      const groupName = `${fd.customName || 'Window'} (${fd.windowType || 'Casement'} · ${fd.glazing || 'Double'} · ${widthMm}×${heightMm}mm)`;

      const hasFrame = bool(fd.hasFrame, true);
      const hasGlass = bool(fd.hasGlass, true);
      const hasHardware = bool(fd.hasHardware, true);
      const hasInstallation = bool(fd.hasInstallation, true);
      const hasSill = bool(fd.hasSill, false);

      const parts: Partial<TakeoffRow>[] = [];
      
      if (hasFrame) parts.push(withPresetData({
        description: 'Window Frame',
        type: 'Length',
        quantity: +(framePerimeter * qty).toFixed(2),
        unit: 'm',
        category: 'Framework',
        notes: `Material: ${fd.frameType || 'UPVC'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasGlass) parts.push(withPresetData({
        description: `Glass Panels (${fd.glazing || 'Double'} glazing)`,
        type: 'Area',
        quantity: +(glassArea * qty).toFixed(3),
        unit: 'm²',
        category: 'Glazing',
        notes: `Type: ${fd.glassType || 'Clear'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasHardware) parts.push(withPresetData({
        description: 'Window Hardware',
        type: 'Count',
        quantity: qty,
        unit: 'sets',
        category: 'Hardware',
        notes: `Includes: ${fd.hardwareType || 'Standard handles, hinges'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasInstallation) parts.push(withPresetData({
        description: 'Installation & Sealing',
        type: 'Count',
        quantity: qty,
        unit: 'each',
        category: 'Labor',
        notes: 'Includes foam sealant, fixings, and labor',
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasSill) parts.push(withPresetData({
        description: 'Window Sill',
        type: 'Length',
        quantity: +(W * qty).toFixed(2),
        unit: 'm',
        category: 'Finishes',
        notes: `Material: ${fd.sillMaterial || 'Timber'}`,
        color: '#85B7EB'
      }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: qty,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete window assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#85B7EB',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── DOOR ────────────────────────────────────────────────────────────────
    else if (t.id === 'door') {
      const qty = Math.max(1, Math.min(10, parseInt(String(fd.quantity ?? 1))));
      const widthMm = parseFloat(String(fd.width ?? 900));
      const heightMm = parseFloat(String(fd.height ?? 2100));
      const W = widthMm / 1000;
      const H = heightMm / 1000;
      
      const groupName = `${fd.customName || 'Door'} (${fd.doorType || 'Swing'} · ${fd.material || 'Wood'} · ${widthMm}×${heightMm}mm)`;

      const hasFrame = bool(fd.hasFrame, true);
      const hasLeaf = bool(fd.hasLeaf, true);
      const hasHardware = bool(fd.hasHardware, true);
      const hasInstallation = bool(fd.hasInstallation, true);

      const parts: Partial<TakeoffRow>[] = [];
      
      if (hasFrame) parts.push(withPresetData({
        description: 'Door Frame',
        type: 'Length',
        quantity: +(2 * (W + H) * qty).toFixed(2),
        unit: 'm',
        category: 'Framework',
        notes: `Material: ${fd.frameType || 'Timber'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasLeaf) parts.push(withPresetData({
        description: 'Door Leaf',
        type: 'Area',
        quantity: +((W * H) * qty).toFixed(3),
        unit: 'm²',
        category: 'Doors',
        notes: `Material: ${fd.material || 'Wood'} | Type: ${fd.doorType || 'Swing'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasHardware) parts.push(withPresetData({
        description: 'Door Hardware',
        type: 'Count',
        quantity: qty,
        unit: 'sets',
        category: 'Hardware',
        notes: `Includes: ${fd.hardwareType || 'Hinges, handles, locks'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (hasInstallation) parts.push(withPresetData({
        description: 'Installation',
        type: 'Count',
        quantity: qty,
        unit: 'each',
        category: 'Labor',
        notes: 'Includes fitting, fixing, and sealing',
        color: '#85B7EB'
      }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: qty,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete door assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#85B7EB',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── STUD WALL ───────────────────────────────────────────────────────────
    else if (t.id === 'stud-wall') {
      const L = parseFloat(String(fd.length ?? 5000)) / 1000;
      const H = parseFloat(String(fd.height ?? 2700)) / 1000;
      const spacing = parseFloat(String(fd.spacing === '600mm' ? 600 : 450)) / 1000;
      const studCount = Math.ceil(L / spacing) + 1;
      const groupName = `Stud Wall (${L}m × ${H}m · ${fd.spacing || '450mm'} spacing)`;

      const parts: Partial<TakeoffRow>[] = [];
      parts.push(withPresetData({
        description: `Studs (${studCount} pcs)`,
        type: 'Length',
        quantity: +(studCount * H).toFixed(2),
        unit: 'm',
        category: 'Framework',
        notes: `Material: ${fd.material || 'Timber'} | Spacing: ${fd.spacing || '450mm'}`,
        color: '#85B7EB'
      }, t.id, fd));
      parts.push(withPresetData({
        description: 'Top & Bottom Plates',
        type: 'Length',
        quantity: +(L * 2).toFixed(2),
        unit: 'm',
        category: 'Framework',
        notes: `Material: ${fd.material || 'Timber'}`,
        color: '#85B7EB'
      }, t.id, fd));
      
      if (fd.hasPlasterboard) {
        parts.push(withPresetData({
          description: 'Plasterboard',
          type: 'Area',
          quantity: +((L * H) * 2).toFixed(2),
          unit: 'm²',
          category: 'Finishes',
          notes: `Thickness: ${fd.plasterboardThickness || '12.5mm'}`,
          color: '#85B7EB'
        }, t.id, fd));
      }

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: 1,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete stud wall assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#EF9F27',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── ROOF ─────────────────────────────────────────────────────────────────
    else if (t.id === 'roof') {
      const area = parseFloat(String(fd.roofArea ?? 100)) || 100;
      const pitch = parseFloat(String(fd.roofPitch ?? 22)) || 22;
      const pitchFactor = 1 / Math.cos((pitch * Math.PI) / 180);
      const adjustedArea = (area * pitchFactor).toFixed(1);
      const groupName = `Roof (${fd.roofType || 'Pitched'} · ${fd.material || 'Tile'} · ${area} M²)`;

      const hasDecking = bool(fd.hasDecking);
      const hasMembrane = bool(fd.hasMembrane);
      const hasInsulation = bool(fd.hasInsulation, false);
      const hasGuttering = bool(fd.hasGuttering);

      const parts: Partial<TakeoffRow>[] = [];
      if (hasDecking) parts.push(withPresetData({ description: 'Roof Covering', type: 'Area', quantity: +(parseFloat(adjustedArea) * 1.05).toFixed(2), unit: 'm²', category: 'Roofing', notes: `Material: ${fd.material || 'Tile'} | Pitch: ${pitch}° | +5% wastage`, color: '#97C459' }, t.id, fd));
      if (hasMembrane) parts.push(withPresetData({ description: 'Underlay / Membrane', type: 'Area', quantity: +(parseFloat(adjustedArea) * 1.1).toFixed(2), unit: 'm²', category: 'Roofing', notes: '+10% overlap | Type: Breathable membrane', color: '#97C459' }, t.id, fd));
      if (hasGuttering) parts.push(withPresetData({ description: 'Guttering & Downpipes', type: 'Length', quantity: +(Math.sqrt(area) * 4).toFixed(1), unit: 'm', category: 'Drainage', notes: `Material: ${fd.guttering || 'Aluminium'}`, color: '#97C459' }, t.id, fd));
      if (hasInsulation) parts.push(withPresetData({ description: 'Roof Insulation', type: 'Area', quantity: area, unit: 'm²', category: 'Insulation', notes: `Thickness: ${fd.insulationThickness || '100mm'}`, color: '#97C459' }, t.id, fd));
      parts.push(withPresetData({ description: 'Installation & Flashing', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Includes valleys, ridges, flashings, & sealing', color: '#97C459' }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: 1,
          unit: 'm²',
          unitRate: 0,
          notes: 'Complete roof assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#97C459',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── CEILING ─────────────────────────────────────────────────────────────
    else if (t.id === 'ceiling') {
      const area = parseFloat(String(fd.area ?? 20)) || 20;
      const ceilType = fd.type || 'Suspended';
      const groupName = `Ceiling (${ceilType} · ${fd.material || 'Plaster'} · ${area} M²)`;

      const hasBoard = bool(fd.hasBoard);
      const hasGrid = bool(fd.hasGrid, ceilType === 'Suspended');
      const hasAcoustic = bool(fd.acousticAbsorption, false);
      const hasInsul = bool(fd.hasInsulation, false);

      const parts: Partial<TakeoffRow>[] = [];
      if (hasBoard) parts.push(withPresetData({ description: 'Ceiling Board / Tiles', type: 'Area', quantity: +(area * 1.05).toFixed(2), unit: 'm²', category: 'Finishes', notes: `Material: ${fd.material || 'Plaster'} | Type: ${ceilType} | +5% wastage`, color: '#ED93B1' }, t.id, fd));
      if (hasGrid && ceilType === 'Suspended') {
        parts.push(withPresetData({ description: 'Primary Grid Sections', type: 'Length', quantity: +(area * 0.4).toFixed(1), unit: 'm', category: 'Framework', notes: 'Main tees @ 1200mm spacing', color: '#ED93B1' }, t.id, fd));
        parts.push(withPresetData({ description: 'Secondary Grid Sections', type: 'Length', quantity: +(area * 0.6).toFixed(1), unit: 'm', category: 'Framework', notes: 'Cross tees', color: '#ED93B1' }, t.id, fd));
        parts.push(withPresetData({ description: 'Perimeter Wall Angle', type: 'Length', quantity: +(Math.sqrt(area) * 4).toFixed(1), unit: 'm', category: 'Framework', notes: 'Perimeter trim', color: '#ED93B1' }, t.id, fd));
        parts.push(withPresetData({ description: 'Hanger Wire / Brackets', type: 'Count', quantity: Math.max(1, Math.ceil(area / 1.44)), unit: 'sets', category: 'Hardware', notes: '1 per 1.2m² | Threaded rod + clips', color: '#ED93B1' }, t.id, fd));
      }
      if (hasAcoustic) parts.push(withPresetData({ description: 'Acoustic Treatment', type: 'Area', quantity: area, unit: 'm²', category: 'Finishes', notes: 'Acoustic panels / mineral wool backing', color: '#ED93B1' }, t.id, fd));
      if (hasInsul) parts.push(withPresetData({ description: 'Insulation Above', type: 'Area', quantity: area, unit: 'm²', category: 'Insulation', notes: `Thickness: ${fd.insulationThickness || '100mm'}`, color: '#ED93B1' }, t.id, fd));
      parts.push(withPresetData({ description: 'Installation & Access', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Includes access panels, fire rating checks', color: '#ED93B1' }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: 1,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete ceiling assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#ED93B1',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── STAIRCASE ───────────────────────────────────────────────────────────
    else if (t.id === 'staircase') {
      const totalRise = parseFloat(String(fd.totalRise ?? 2800)) || 2800;
      const totalGoing = parseFloat(String(fd.totalGoing ?? 3600)) || 3600;
      const riserHeight = parseFloat(String(fd.riserHeight ?? 175)) || 175;
      const treadsDepth = parseFloat(String(fd.treadsDepth ?? 250)) || 250;
      const width = parseFloat(String(fd.width ?? 900)) || 900;

      const riserCount = Math.round(totalRise / riserHeight);
      const treadCount = riserCount - 1;
      const stringerLen = +(Math.sqrt(totalRise ** 2 + totalGoing ** 2) / 1000).toFixed(2);
      const groupName = `Staircase (${riserCount} Risers · ${fd.material || 'Timber'} · ${width}mm Wide)`;

      const hasRisers = bool(fd.hasRisers);
      const hasTreads = bool(fd.hasTreads);
      const hasStringers = bool(fd.hasStringers);
      const hasHandrail = bool(fd.handrail ?? fd.hasHandrail);
      const hasNosings = bool(fd.hasNosings, false);

      const parts: Partial<TakeoffRow>[] = [];
      if (hasTreads) parts.push(withPresetData({ description: `Treads (${treadCount} pcs)`, type: 'Count', quantity: treadCount, unit: 'pcs', category: 'Stair Components', notes: `Material: ${fd.material || 'Timber'} | Depth: ${treadsDepth}mm | Width: ${width}mm`, color: '#F0997B' }, t.id, fd));
      if (hasRisers) parts.push(withPresetData({ description: `Risers (${riserCount} pcs)`, type: 'Count', quantity: riserCount, unit: 'pcs', category: 'Stair Components', notes: `Height: ${riserHeight}mm | Material: ${fd.material || 'Timber'}`, color: '#F0997B' }, t.id, fd));
      if (hasStringers) parts.push(withPresetData({ description: 'Stringers / Carriages (×2)', type: 'Length', quantity: stringerLen, unit: 'm', category: 'Framework', notes: `Material: ${fd.stringerMaterial || fd.material || 'Timber'} | Each: ${stringerLen}m`, color: '#F0997B' }, t.id, fd));
      if (hasHandrail) {
        const railLen = +(stringerLen + 0.3).toFixed(2);
        const spindleSpacing = parseFloat(String(fd.spindleSpacing ?? 100)) || 100;
        parts.push(withPresetData({ description: 'Handrail', type: 'Length', quantity: railLen, unit: 'm', category: 'Safety', notes: `Material: ${fd.railMaterial || 'Timber'} | Height: ${fd.railHeight || '900mm'}`, color: '#F0997B' }, t.id, fd));
        parts.push(withPresetData({ description: 'Balustrade Posts', type: 'Count', quantity: Math.max(2, Math.ceil(treadCount / 3)), unit: 'pcs', category: 'Safety', notes: 'Newel posts at top, bottom & landing', color: '#F0997B' }, t.id, fd));
        parts.push(withPresetData({ description: 'Balusters / Spindles', type: 'Count', quantity: Math.floor(treadCount * (width / spindleSpacing)), unit: 'pcs', category: 'Safety', notes: `Spacing: ${spindleSpacing}mm max`, color: '#F0997B' }, t.id, fd));
      }
      if (hasNosings) parts.push(withPresetData({ description: 'Nosings', type: 'Length', quantity: +((width / 1000) * treadCount).toFixed(2), unit: 'm', category: 'Finishing', notes: `Material: ${fd.material || 'Timber'}`, color: '#F0997B' }, t.id, fd));
      parts.push(withPresetData({ description: 'Installation & Fixing', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Assembly, securing, finishing & sanding', color: '#F0997B' }, t.id, fd));
      if (fd.fireRating) parts.push(withPresetData({ description: 'Fire Rating Treatment', type: 'Count', quantity: 1, unit: 'each', category: 'Protection', notes: `Rating: ${fd.fireRating}`, color: '#F0997B' }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: 1,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete staircase assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#F0997B',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── FLOOR SLAB ──────────────────────────────────────────────────────────
    else if (t.id === 'floor-slab') {
      const L = parseFloat(String(fd.length ?? 10000)) / 1000;
      const W = parseFloat(String(fd.width ?? 8000)) / 1000;
      const thickness = parseFloat(String(fd.thickness ?? 150)) / 1000;
      const volume = L * W * thickness;
      const groupName = `Floor Slab (${L}m × ${W}m × ${thickness * 1000}mm)`;

      const parts: Partial<TakeoffRow>[] = [];
      parts.push(withPresetData({
        description: 'Concrete',
        type: 'Volume',
        quantity: +volume.toFixed(2),
        unit: 'm³',
        category: 'Concrete',
        notes: `Grade: ${fd.concreteGrade || 'C25/30'}`,
        color: '#85B7EB'
      }, t.id, fd));
      parts.push(withPresetData({
        description: 'Reinforcement Mesh',
        type: 'Area',
        quantity: +(L * W * 1.1).toFixed(2),
        unit: 'm²',
        category: 'Reinforcement',
        notes: `Type: ${fd.reinforcement || 'A252 Mesh'} | +10% overlap`,
        color: '#85B7EB'
      }, t.id, fd));
      parts.push(withPresetData({
        description: 'Formwork / Edging',
        type: 'Length',
        quantity: +(2 * (L + W)).toFixed(2),
        unit: 'm',
        category: 'Formwork',
        notes: 'Perimeter formwork',
        color: '#85B7EB'
      }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: 1,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete floor slab assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#7B8FA3',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── BEAM ────────────────────────────────────────────────────────────────
    else if (t.id === 'beam') {
      const qty = parseInt(String(fd.quantity ?? 1));
      const length = parseFloat(String(fd.length ?? 6000)) / 1000;
      const groupName = `Beam (${fd.beamType || 'I-Beam'} · ${length}m · ${qty} pcs)`;

      const parts: Partial<TakeoffRow>[] = [];
      parts.push(withPresetData({
        description: `Steel Beam (${fd.beamType || 'I-Beam'})`,
        type: 'Length',
        quantity: +(length * qty).toFixed(2),
        unit: 'm',
        category: 'Steelwork',
        notes: `Section: ${fd.sectionSize || '200×100×8'} | Material: ${fd.material || 'Steel'}`,
        color: '#85B7EB'
      }, t.id, fd));
      parts.push(withPresetData({
        description: 'Fire Protection',
        type: 'Area',
        quantity: +((length * 2) * qty).toFixed(2),
        unit: 'm²',
        category: 'Protection',
        notes: `Type: ${fd.fireProtection || 'Intumescent Paint'}`,
        color: '#85B7EB'
      }, t.id, fd));

      addGroup({
        headerId,
        headerFields: {
          drawingId: activeDrawing.id,
          groupName,
          groupType: t.id,
          description: groupName,
          label: groupName,
          type: 'Count',
          quantity: qty,
          unit: 'assembly',
          unitRate: 0,
          notes: 'Complete beam assembly',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          category: 'Group Header',
          color: '#808080',
          isVisible: true,
        },
        parts,
      });

      showToast(`✓ ${groupName} ADDED (${parts.length} parts)`);
      onSuccess?.();
      return true;
    }

    // ── GENERIC FALLBACK (single measurement) ───────────────────────────────
    else {
      let quantity = 0;
      let unit = 'm';
      switch (t.measurementType as string) {
        case 'linear': quantity = parseFloat(String(fd.length ?? fd.pipeLength ?? 0)) || 0; unit = 'm'; break;
        case 'area': quantity = parseFloat(String(fd.area ?? 0)) || (parseFloat(String(fd.width ?? 0)) * parseFloat(String(fd.height ?? 0))) / 1e6 || 0; unit = 'm²'; break;
        case 'count': quantity = parseInt(String(fd.quantity ?? fd.doorCount ?? fd.windowCount ?? 1)); unit = 'pcs'; break;
      }

      addMeasurement({
        id: headerId,
        drawingId: activeDrawing.id,
        description: t.name,
        label: t.name,
        type: t.measurementType === 'linear' ? 'Length' : t.measurementType === 'area' ? 'Area' : 'Count',
        quantity,
        unit,
        unitRate: 0,
        notes: `Preset: ${t.name} · ${t.category}`,
        points: [],
        childIds: [],
        isOverridden: true,
        presetData: fd,
        presetId: t.id,
        color: '#EF9F27',
        isVisible: true,
      } as TakeoffRow);

      showToast(`✓ ${t.name.toUpperCase()} ADDED`);
      onSuccess?.();
      return true;
    }
  }, [activeDrawing, addMeasurement, batchCommitMeasurements, showToast, addGroup, withPresetData, bool]);

  return { handleConfirm };
}