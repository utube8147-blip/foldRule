import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Lock, Unlock, Crosshair } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PdfDimensions } from '@/types/viewerTypes';

const MINIMAP_W = 192;
const MINIMAP_H = 140;

interface MinimapProps {
  pdf: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  containerRef: React.RefObject<HTMLDivElement>;
  pdfDimensions: PdfDimensions;
  canvasPadding: number;
}

export function Minimap({ pdf, pageNumber, containerRef, pdfDimensions, canvasPadding }: MinimapProps) {
  const thumbCanvasRef   = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const isDraggingRef    = useRef(false);
  const hoverTimeoutRef  = useRef<NodeJS.Timeout>();

  // Lock state: false = hover mode, true = always visible
  const [isLocked, setIsLocked] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  
  // Ref mirrors lock state for handlers
  const isLockedRef = useRef(false);
  
  // Determine if minimap should be visible
  const isVisible = isLocked || isHovering;

  // Update ref when lock state changes
  useEffect(() => {
    isLockedRef.current = isLocked;
  }, [isLocked]);

  // Handle mouse enter - only in unlocked mode
  const handleMouseEnter = useCallback(() => {
    if (!isLockedRef.current) {
      // Clear any pending hide timeout
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = undefined;
      }
      setIsHovering(true);
    }
  }, []);

  // Handle mouse leave - only in unlocked mode
  const handleMouseLeave = useCallback(() => {
    if (!isLockedRef.current) {
      // Small delay before hiding to prevent flicker when moving to minimap
      hoverTimeoutRef.current = setTimeout(() => {
        setIsHovering(false);
      }, 100);
    }
  }, []);

  // Toggle lock state
  const handleToggleLock = useCallback(() => {
    const newLockState = !isLockedRef.current;
    setIsLocked(newLockState);
    isLockedRef.current = newLockState;
    
    if (newLockState) {
      // Locking: clear any pending hide timeout and ensure visible
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = undefined;
      }
      setIsHovering(false);
    } else {
      // Unlocking: hide immediately, will reappear on next hover
      setIsHovering(false);
    }
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // ── Thumbnail render ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf || !thumbCanvasRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        const page    = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const vp1     = page.getViewport({ scale: 1 });
        const thumbSc = Math.min(MINIMAP_W / vp1.width, MINIMAP_H / vp1.height);
        const vp      = page.getViewport({ scale: thumbSc });
        const cvs     = thumbCanvasRef.current!;
        cvs.width  = Math.round(vp.width);
        cvs.height = Math.round(vp.height);
        const ctx = cvs.getContext('2d');
        if (!ctx || cancelled) return;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [pdf, pageNumber]);

  // ── Overlay draw loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isVisible) return;
    let rafId: number;

    const draw = () => {
      const oc        = overlayCanvasRef.current;
      const container = containerRef.current;
      if (!oc || !container) { 
        rafId = requestAnimationFrame(draw); 
        return; 
      }

      oc.width  = MINIMAP_W;
      oc.height = MINIMAP_H;

      const ctx = oc.getContext('2d');
      if (!ctx) { 
        rafId = requestAnimationFrame(draw); 
        return; 
      }
      ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);

      const scrollW = container.scrollWidth;
      const scrollH = container.scrollHeight;
      const vw      = container.clientWidth;
      const vh      = container.clientHeight;
      const docW    = pdfDimensions.w;
      const docH    = pdfDimensions.h;
      const wrapW   = Math.max(docW + canvasPadding * 2, vw * 3);
      const wrapH   = Math.max(docH + canvasPadding * 2, vh * 3);

      const sheetLeft = Math.round((wrapW - docW) / 2);
      const sheetTop  = Math.round((wrapH - docH) / 2);
      const mx = MINIMAP_W / scrollW;
      const my = MINIMAP_H / scrollH;

      const sheetMX = sheetLeft * mx;
      const sheetMY = sheetTop  * my;
      const sheetMW = Math.max(1, docW * mx);
      const sheetMH = Math.max(1, docH * my);

      // Dark background
      ctx.fillStyle = 'rgba(9,9,11,0.92)';
      ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

      // Thumbnail inside sheet rect
      const thumb = thumbCanvasRef.current;
      if (thumb && thumb.width > 0) {
        ctx.drawImage(thumb, sheetMX, sheetMY, sheetMW, sheetMH);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(sheetMX, sheetMY, sheetMW, sheetMH);
      }

      // Sheet border
      ctx.strokeStyle = 'rgba(63,63,70,0.6)';
      ctx.lineWidth   = 0.5;
      ctx.strokeRect(sheetMX + 0.5, sheetMY + 0.5, sheetMW - 1, sheetMH - 1);

      // Viewport rect
      const vpLeft   = container.scrollLeft * mx;
      const vpTop    = container.scrollTop  * my;
      const vpWidth  = Math.max(2, vw * mx);
      const vpHeight = Math.max(2, vh * my);

      ctx.fillStyle = 'rgba(245,158,11,0.12)';
      ctx.fillRect(vpLeft, vpTop, vpWidth, vpHeight);
      ctx.strokeStyle = 'rgba(245,158,11,0.9)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(vpLeft + 0.5, vpTop + 0.5, vpWidth - 1, vpHeight - 1);

      const tick = 3.5;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth   = 1.5;
      [[vpLeft, vpTop], [vpLeft + vpWidth, vpTop],
       [vpLeft, vpTop + vpHeight], [vpLeft + vpWidth, vpTop + vpHeight]
      ].forEach(([cx, cy]) => {
        ctx.beginPath();
        ctx.moveTo(cx - tick, cy); ctx.lineTo(cx + tick, cy);
        ctx.moveTo(cx, cy - tick); ctx.lineTo(cx, cy + tick);
        ctx.stroke();
      });

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [isVisible, containerRef, pdfDimensions, canvasPadding]);

  // ── Seek on drag ──────────────────────────────────────────────────────────
  const seekToPoint = useCallback((clientX: number, clientY: number) => {
    const oc = overlayCanvasRef.current;
    const c  = containerRef.current;
    if (!oc || !c) return;
    const rect = oc.getBoundingClientRect();
    c.scrollLeft = Math.max(0, ((clientX - rect.left) / rect.width)  * c.scrollWidth  - c.clientWidth  / 2);
    c.scrollTop  = Math.max(0, ((clientY - rect.top)  / rect.height) * c.scrollHeight - c.clientHeight / 2);
  }, [containerRef]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault(); 
    e.stopPropagation();
    isDraggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekToPoint(e.clientX, e.clientY);
  };
  
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    e.preventDefault();
    seekToPoint(e.clientX, e.clientY);
  };
  
  const handlePointerUp = () => { 
    isDraggingRef.current = false; 
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="absolute bottom-2 left-2 z-40 select-none"
      style={{ width: MINIMAP_W }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Panel */}
      <div
        style={{
          opacity:       isVisible ? 1 : 0,
          transform:     isVisible ? 'scale(1) translateY(0)' : 'scale(0.94) translateY(5px)',
          pointerEvents: isVisible ? 'auto' : 'none',
          transition:    'opacity 0.18s ease-out, transform 0.18s ease-out',
        }}
      >
        <div
          className="relative overflow-hidden"
          style={{
            width: MINIMAP_W,
            border: '1px solid',
            borderColor: isLocked ? 'rgba(245,158,11,0.55)' : 'rgba(63,63,70,0.85)',
            background: '#09090b',
            boxShadow: isLocked
              ? '0 0 0 1px rgba(245,158,11,0.12), 0 8px 32px rgba(0,0,0,0.75)'
              : '0 8px 32px rgba(0,0,0,0.65)',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-2 py-1"
            style={{ borderBottom: '1px solid rgba(63,63,70,0.6)', background: 'rgba(24,24,27,0.95)' }}>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full transition-colors duration-200"
                style={{ background: isLocked ? '#f59e0b' : '#3f3f46' }} />
              <span className="font-mono font-bold uppercase tracking-[0.18em] transition-colors duration-200"
                style={{ fontSize: 8, color: isLocked ? '#d97706' : '#52525b' }}>
                MINIMAP
              </span>
            </div>
            <button
              onClick={handleToggleLock}
              className={cn(
                'flex items-center gap-1 font-mono font-bold uppercase tracking-widest px-1.5 py-0.5 transition-colors duration-150',
                isLocked ? 'text-amber-400 hover:text-amber-300' : 'text-zinc-600 hover:text-zinc-400',
              )}
              style={{ fontSize: 7 }}
              title={isLocked ? 'Unlock — hover only' : 'Lock minimap open'}
            >
              {isLocked ? <Lock className="w-2.5 h-2.5" /> : <Unlock className="w-2.5 h-2.5" />}
              {isLocked ? 'LOCKED' : 'LOCK'}
            </button>
          </div>

          {/* Canvas area */}
          <div className="relative overflow-hidden" style={{ width: MINIMAP_W, height: MINIMAP_H }}>
            <div className="absolute top-0 left-0 right-0 h-px pointer-events-none z-10 transition-all duration-300"
              style={{
                background: isLocked
                  ? 'linear-gradient(90deg,transparent 0%,rgba(245,158,11,0.5) 50%,transparent 100%)'
                  : 'linear-gradient(90deg,transparent 0%,rgba(63,63,70,0.4) 50%,transparent 100%)',
              }} />
            <canvas ref={thumbCanvasRef} className="hidden" />
            <canvas
              ref={overlayCanvasRef}
              width={MINIMAP_W} height={MINIMAP_H}
              className="absolute inset-0 cursor-crosshair"
              style={{ width: MINIMAP_W, height: MINIMAP_H, display: 'block' }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            />
            {(['tl','tr','bl','br'] as const).map(pos => (
              <CornerTick key={pos} position={pos} active={isLocked} />
            ))}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-2 py-0.5"
            style={{ borderTop: '1px solid rgba(63,63,70,0.45)', background: 'rgba(9,9,11,0.95)' }}>
            <span className="font-mono uppercase tracking-widest" style={{ fontSize: 7, color: '#3f3f46' }}>
              DRAG TO NAVIGATE
            </span>
            <div className="flex items-center gap-1">
              <Crosshair className="w-2 h-2 transition-colors duration-200"
                style={{ color: isLocked ? '#d97706' : '#3f3f46' }} />
              <span className="font-mono uppercase tracking-widest transition-colors duration-200"
                style={{ fontSize: 7, color: isLocked ? '#d97706' : '#3f3f46' }}>
                {isLocked ? 'PINNED' : 'HOVER'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Hover trigger strip - thin line visible when unlocked and hidden */}
      {!isLocked && !isVisible && (
        <div
          className="absolute bottom-0 left-0 transition-opacity duration-200"
          style={{
            width: MINIMAP_W,
            height: 3,
            opacity: 0.6,
            background: 'linear-gradient(90deg, rgba(245,158,11,0.6) 0%, rgba(245,158,11,0.15) 100%)',
            borderRadius: '0 0 2px 2px',
          }}
        />
      )}
      
      {/* Glow effect when locked */}
      {isLocked && (
        <div
          className="absolute -inset-0.5 pointer-events-none transition-opacity duration-300"
          style={{
            opacity: 0.15,
            background: 'radial-gradient(circle at 30% 40%, rgba(245,158,11,0.4), transparent 70%)',
            borderRadius: '4px',
          }}
        />
      )}
    </div>
  );
}

// ─── CornerTick ───────────────────────────────────────────────────────────────

interface CornerTickProps {
  position: 'tl' | 'tr' | 'bl' | 'br';
  active: boolean;
}

function CornerTick({ position, active }: CornerTickProps) {
  const size  = 6;
  const color = active ? 'rgba(245,158,11,0.65)' : 'rgba(63,63,70,0.5)';
  const style: React.CSSProperties = {
    position: 'absolute', 
    width: size, 
    height: size,
    pointerEvents: 'none', 
    zIndex: 20, 
    transition: 'border-color 0.2s',
    ...(position === 'tl' ? { top: 0,    left:  0, borderTop:    `1px solid ${color}`, borderLeft:   `1px solid ${color}` }
      : position === 'tr' ? { top: 0,    right: 0, borderTop:    `1px solid ${color}`, borderRight:  `1px solid ${color}` }
      : position === 'bl' ? { bottom: 0, left:  0, borderBottom: `1px solid ${color}`, borderLeft:   `1px solid ${color}` }
      :                       { bottom: 0, right: 0, borderBottom: `1px solid ${color}`, borderRight:  `1px solid ${color}` }),
  };
  return <div style={style} />;
}