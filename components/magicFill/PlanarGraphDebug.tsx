'use client';
import { useEffect, useRef } from 'react';
import type { PlanarGraph } from '@/hooks/fill/magicFill/planarGraph';

interface Props {
  graphRef: React.MutableRefObject<PlanarGraph | null>;
  canvasW: number;
  canvasH: number;
  visible: boolean;
  graphReady: boolean;
}

export function PlanarGraphDebug({ graphRef, canvasW, canvasH, visible, graphReady }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    // Guard: graphRef itself might be undefined if hook hasn't initialised
    const graph = graphRef?.current ?? null;

    if (!graph || !visible || canvasW === 0 || canvasH === 0) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      return;
    }

    if (c.width !== canvasW || c.height !== canvasH) {
      c.width  = canvasW;
      c.height = canvasH;
    }

    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, canvasW, canvasH);

    ctx.lineWidth = 1;
    for (const edge of graph.edges) {
      const na = graph.nodes[edge.a];
      const nb = graph.nodes[edge.b];
      const len = Math.hypot(nb.x - na.x, nb.y - na.y);
      ctx.strokeStyle = `rgba(255,102,0,${len > 200 ? 0.25 : 0.75})`;
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.lineTo(nb.x, nb.y);
      ctx.stroke();
    }

    const DOT_R = 3;
    for (const node of graph.nodes) {
      const deg = node.edges.length;
      ctx.fillStyle =
        deg === 0 ? '#888888' :
        deg === 1 ? '#ff3366' :
        deg === 2 ? '#00ff88' :
                    '#ffcc00';
      ctx.beginPath();
      ctx.arc(node.x, node.y, DOT_R, 0, Math.PI * 2);
      ctx.fill();

      if (deg === 1) {
        ctx.strokeStyle = 'rgba(255,51,102,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, DOT_R * 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [graphRef, canvasW, canvasH, visible, graphReady]);

  return (
    <canvas
      ref={canvasRef}
      width={canvasW || 1}
      height={canvasH || 1}
      style={{
        position:      'absolute',
        top:           0,
        left:          0,
        pointerEvents: 'none',
        zIndex:        25,
        opacity:       visible ? 0.85 : 0,
        display:       'block',
      }}
    />
  );
}