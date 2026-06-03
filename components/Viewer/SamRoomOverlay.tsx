'use client';

// ─── SamRoomOverlay.tsx ───────────────────────────────────────────────────────

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Check, X, Loader2, Wand2 } from 'lucide-react';
import { UseSamSegmentationReturn } from '@/hooks/detection/useSamSegmentation';

export interface Point { x: number; y: number }

interface SamRoomOverlayProps {
  isActive:  boolean;
  pdfCanvas: HTMLCanvasElement | null;
  canvasW:   number;
  canvasH:   number;
  sam:       UseSamSegmentationReturn;
  onPolygon: (points: Point[]) => void;
  onError:   (msg: string) => void;
}

export function SamRoomOverlay({
  isActive, pdfCanvas, canvasW, canvasH,
  sam, onPolygon, onError,
}: SamRoomOverlayProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [clickPos,    setClickPos]    = useState<Point | null>(null);
  const [ripple,      setRipple]      = useState<Point | null>(null);
  const [pendingPoly, setPendingPoly] = useState<Point[] | null>(null);

  // Track which canvas instance we've already encoded
  const encodedCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ✅ Store the in-flight encode promise so handleClick can await it
  //    instead of checking sam.status synchronously and bailing early.
  const encodePromiseRef = useRef<Promise<void> | null>(null);

  // ── Kick off encode when tool becomes active ───────────────────────────────
  useEffect(() => {
    if (!isActive || !pdfCanvas) return;
    if (encodedCanvasRef.current === pdfCanvas) return;

    // ✅ Probe the canvas before encoding — PDF.js renders asynchronously and
    //    the canvas can still be blank when isActive first becomes true.
    const ctx = pdfCanvas.getContext('2d');
    if (!ctx) return;
    const probe   = ctx.getImageData(0, 0, 4, 4);
    const isEmpty = probe.data.every(v => v === 0);
    if (isEmpty) {
      console.warn('[SamRoomOverlay] Canvas is blank — deferring encode until PDF renders');
      return; // the Viewer.tsx renderPage effect will change pdfCanvas ref, re-triggering this
    }

    encodedCanvasRef.current = pdfCanvas; // mark optimistically to prevent double-fire
    encodePromiseRef.current = sam.encodePage(pdfCanvas).catch((err) => {
      encodedCanvasRef.current = null;
      encodePromiseRef.current = null;
      onError(`Encoding failed: ${err?.message ?? err}`);
    });
  }, [isActive, pdfCanvas]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Re-encode when the canvas instance changes (page turn / new render) ────
  useEffect(() => {
    if (!isActive || !pdfCanvas) return;
    if (encodedCanvasRef.current === pdfCanvas) return;

    encodedCanvasRef.current = null;
    encodePromiseRef.current = null;
    sam.resetEmbedding();
  }, [pdfCanvas]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync preview canvas size ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.width        = canvasW;
    canvas.height       = canvasH;
    canvas.style.width  = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
  }, [canvasW, canvasH]);

  // ── Draw polygon preview ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!pendingPoly || pendingPoly.length < 3) return;

    ctx.beginPath();
    ctx.moveTo(pendingPoly[0].x, pendingPoly[0].y);
    pendingPoly.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle   = 'rgba(99, 202, 255, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(99, 202, 255, 0.9)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    pendingPoly.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(99, 202, 255, 0.9)';
      ctx.fill();
    });
  }, [pendingPoly]);

  // ── Handle click ──────────────────────────────────────────────────────────
  const handleClick = useCallback(async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isActive) return;
    if (sam.isBusy) return;

    // If encode hasn't started yet (pdfCanvas was null or blank on activation), kick it off now
    if (pdfCanvas && encodedCanvasRef.current !== pdfCanvas) {
      const ctx = pdfCanvas.getContext('2d');
      const probe = ctx?.getImageData(0, 0, 4, 4);
      const isEmpty = probe?.data.every(v => v === 0) ?? true;

      if (isEmpty) {
        onError('PDF is still rendering — please wait a moment and try again.');
        return;
      }

      encodedCanvasRef.current = pdfCanvas;
      encodePromiseRef.current = sam.encodePage(pdfCanvas).catch((err) => {
        encodedCanvasRef.current = null;
        encodePromiseRef.current = null;
        onError(`Encoding failed: ${err?.message ?? err}`);
      });
    }

    // ✅ Await the encode promise rather than checking sam.status synchronously.
    //    The old code bailed with "still encoding" because the async encode
    //    hadn't resolved yet at the moment of the click.
    if (encodePromiseRef.current) {
      await encodePromiseRef.current;
    }

    // Hard-bail only on actual error
    if (sam.status === 'error') {
      onError(`Encoding failed: ${sam.statusMsg}`);
      return;
    }

    // Guard against double-clicks while a segment is running
    if (sam.isBusy) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x    = (e.clientX - rect.left) * (canvasW / rect.width);
    const y    = (e.clientY - rect.top)  * (canvasH / rect.height);

    setRipple({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setTimeout(() => setRipple(null), 600);
    setClickPos({ x, y });
    setPendingPoly(null);

    try {
      const polygon = await sam.segmentPoint(x, y, canvasW, canvasH);
      if (!polygon) {
        onError('No region detected — try clicking closer to the centre of a room.');
        return;
      }
      setPendingPoly(polygon);
    } catch (err: any) {
      onError(`Segment failed: ${err?.message ?? err}`);
    }
  }, [isActive, sam, canvasW, canvasH, pdfCanvas, onError]);

  // ── Confirm / Discard ─────────────────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    if (!pendingPoly) return;
    onPolygon(pendingPoly);
    setPendingPoly(null);
    setClickPos(null);
  }, [pendingPoly, onPolygon]);

  const handleDiscard = useCallback(() => {
    setPendingPoly(null);
    setClickPos(null);
    const canvas = previewCanvasRef.current;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  if (!isActive) return null;

  const btnX = clickPos ? Math.min(clickPos.x + 12, canvasW - 160) : 0;
  const btnY = clickPos ? Math.min(clickPos.y + 12, canvasH - 60)  : 0;

  const badgeText = (() => {
    if (sam.isBusy)             return sam.statusMsg || 'Processing…';
    if (sam.status === 'ready') return 'Click inside a room to segment';
    if (sam.status === 'error') return `Error: ${sam.statusMsg}`;
    return sam.statusMsg || 'Preparing…';
  })();

  return (
    <>
      {/* Polygon preview canvas */}
      <canvas
        ref={previewCanvasRef}
        style={{
          position:      'absolute',
          top:           0,
          left:          0,
          zIndex:        25,
          pointerEvents: 'none',
        }}
      />

      {/* Click-capture overlay */}
      <div
        style={{
          position: 'absolute',
          top:      0,
          left:     0,
          width:    canvasW,
          height:   canvasH,
          zIndex:   30,
          cursor:   sam.isBusy ? 'wait' : 'crosshair',
        }}
        onPointerDown={handleClick}
      >
        {/* Ripple */}
        {ripple && (
          <div style={{
            position:      'absolute',
            left:          ripple.x,
            top:           ripple.y,
            transform:     'translate(-50%, -50%)',
            pointerEvents: 'none',
          }}>
            <div style={{
              width:        32,
              height:       32,
              borderRadius: '50%',
              border:       '2px solid rgba(99,202,255,0.8)',
              animation:    'samRipple 0.6s ease-out forwards',
            }} />
          </div>
        )}

        {/* Busy spinner */}
        {sam.isBusy && (
          <div style={{
            position:      'absolute',
            top:           '50%',
            left:          '50%',
            transform:     'translate(-50%, -50%)',
            display:       'flex',
            flexDirection: 'column',
            alignItems:    'center',
            gap:           8,
            background:    'rgba(0,0,0,0.75)',
            borderRadius:  8,
            padding:       '16px 24px',
            border:        '1px solid rgba(99,202,255,0.3)',
          }}>
            <Loader2 style={{
              width:     24,
              height:    24,
              color:     'rgb(99,202,255)',
              animation: 'spin 1s linear infinite',
            }} />
            <span style={{
              fontSize:      10,
              fontFamily:    'ui-monospace, monospace',
              color:         'rgb(99,202,255)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontWeight:    700,
            }}>
              {sam.statusMsg || 'Processing…'}
            </span>
          </div>
        )}

        {/* Confirm / Discard */}
        {pendingPoly && !sam.isBusy && (
          <div style={{ position: 'absolute', left: btnX, top: btnY, display: 'flex', gap: 6, zIndex: 35 }}>
            <button
              onPointerDown={e => { e.stopPropagation(); handleConfirm(); }}
              style={{
                display:       'flex',
                alignItems:    'center',
                gap:           6,
                background:    '#22c55e',
                color:         '#000',
                border:        'none',
                padding:       '6px 12px',
                fontFamily:    'ui-monospace, monospace',
                fontSize:      10,
                fontWeight:    800,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                cursor:        'pointer',
              }}
            >
              <Check style={{ width: 12, height: 12 }} />
              Add room ({pendingPoly.length} pts)
            </button>
            <button
              onPointerDown={e => { e.stopPropagation(); handleDiscard(); }}
              style={{
                display:       'flex',
                alignItems:    'center',
                gap:           6,
                background:    '#3f3f46',
                color:         '#a1a1aa',
                border:        '1px solid #52525b',
                padding:       '6px 12px',
                fontFamily:    'ui-monospace, monospace',
                fontSize:      10,
                fontWeight:    800,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                cursor:        'pointer',
              }}
            >
              <X style={{ width: 12, height: 12 }} />
              Discard
            </button>
          </div>
        )}

        {/* Status badge */}
        <div style={{
          position:      'absolute',
          top:           8,
          left:          8,
          display:       'flex',
          alignItems:    'center',
          gap:           6,
          background:    'rgba(0,0,0,0.7)',
          border:        `1px solid ${sam.status === 'error' ? 'rgba(239,68,68,0.4)' : 'rgba(99,202,255,0.4)'}`,
          padding:       '4px 10px',
          pointerEvents: 'none',
        }}>
          {sam.isBusy
            ? <Loader2 style={{ width: 10, height: 10, color: 'rgb(99,202,255)', animation: 'spin 1s linear infinite' }} />
            : <Wand2   style={{ width: 10, height: 10, color: sam.status === 'error' ? 'rgb(239,68,68)' : 'rgb(99,202,255)' }} />
          }
          <span style={{
            fontSize:      9,
            fontFamily:    'ui-monospace, monospace',
            color:         sam.status === 'error' ? 'rgb(239,68,68)' : 'rgb(99,202,255)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight:    700,
          }}>
            {badgeText}
          </span>
        </div>
      </div>

      <style>{`
        @keyframes samRipple {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(3);   opacity: 0; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
