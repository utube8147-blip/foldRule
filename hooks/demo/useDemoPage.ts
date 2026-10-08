'use client';

// EXPERIMENTS: one PDF page rendered to a picture, with its text and a black-and-white
// copy for symbol matching. Self-contained so the experiments never touch the workspace viewer.

import { useEffect, useState } from 'react';
import pdfjsLib from '@/lib/pdf/pdfClient';
import type { Drawing } from '@/types';
import { toInk, type Ink } from '@/lib/demo/symbolCount';
import type { TextItem } from '@/lib/demo/rooms';

const LONG_EDGE = 1800;

export interface DemoPage {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  /** Picture of the page. */
  url?: string;
  width: number; height: number;
  pages: number;
  ink?: Ink;
  /** Text on the page, positioned in picture pixels. */
  texts: TextItem[];
}

export function useDemoPage(drawing: Drawing | undefined, pageNumber: number): DemoPage {
  const [state, setState] = useState<DemoPage>({ status: 'idle', width: 0, height: 0, pages: 0, texts: [] });
  useEffect(() => {
    if (!drawing) { setState({ status: 'idle', width: 0, height: 0, pages: 0, texts: [] }); return; }
    let cancelled = false;
    let doc: { destroy?: () => void } | null = null;
    setState(s => ({ ...s, status: 'loading', error: undefined }));
    (async () => {
      try {
        const src = drawing.file ? { data: new Uint8Array(await drawing.file.arrayBuffer()) } : drawing.fileUrl;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdf = await (pdfjsLib as any).getDocument(src).promise;
        doc = pdf;
        const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));
        const base = page.getViewport({ scale: 1 });
        const scale = LONG_EDGE / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        const text = await page.getTextContent();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const texts: TextItem[] = text.items.filter((i: any) => typeof i.str === 'string' && i.str.trim()).map((i: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (pdfjsLib as any).Util.transform(vp.transform, i.transform);
          const h = Math.hypot(t[2], t[3]) || 10;
          return { str: i.str, x: t[4], y: t[5] - h, w: (i.width ?? 0) * scale, h };
        });
        const ink = toInk(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (!cancelled) setState({ status: 'ready', url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, pages: pdf.numPages, ink, texts });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', error: e instanceof Error ? e.message : 'The page could not be opened.', width: 0, height: 0, pages: 0, texts: [] });
      }
    })();
    return () => { cancelled = true; try { doc?.destroy?.(); } catch { /* already gone */ } };
  }, [drawing, pageNumber]);
  return state;
}
