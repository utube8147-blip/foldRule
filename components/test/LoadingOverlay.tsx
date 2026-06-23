'use client';

import { useEffect, useState } from 'react';
import type { PdfLoadStage } from '@/hooks/usePdfDocument';

const STAGE_LABELS: Record<Exclude<PdfLoadStage, 'idle' | 'done' | 'error'>, string> = {
  'reading-file': 'Reading PDF file',
  'parsing-pdf': 'Parsing PDF structure',
  'rendering-page': 'Rendering page to canvas',
  'extracting-geometry': 'Extracting vector geometry',
  'computing-snaps': 'Computing snap points',
};

const STAGE_ORDER: PdfLoadStage[] = [
  'reading-file',
  'parsing-pdf',
  'rendering-page',
  'extracting-geometry',
  'computing-snaps',
];

export function LoadingOverlay({ stage, fileName }: { stage: PdfLoadStage; fileName: string }) {
  const [dots, setDots] = useState('');
  const active = stage !== 'idle' && stage !== 'done' && stage !== 'error';

  useEffect(() => {
    if (!active) {
      setDots('');
      return;
    }
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? '' : d + '.')), 380);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const currentIdx = STAGE_ORDER.indexOf(stage);

  return (
    <div className="absolute inset-0 z-[90] bg-[rgba(10,10,10,0.72)] flex flex-col items-center justify-center pointer-events-none">
      <style>{`@keyframes spin360{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div className="bg-[#0d0d0d] border border-[#2a2a2a] px-[32px] py-[20px] flex flex-col items-center gap-[14px] min-w-[260px]">
        <div className="relative w-[36px] h-[36px]">
          <div className="absolute inset-0 border-[1.5px] border-[#1c1c1c] rounded-full" />
          <div
            className="absolute inset-0 border-[1.5px] border-transparent rounded-full"
            style={{ borderTopColor: '#f59e0b', animation: 'spin360 .8s linear infinite' }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[#f59e0b]">⊕</div>
        </div>
        <div className="text-[9px] text-[#444] uppercase tracking-[.09em] max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">
          {fileName}
        </div>
        <div className="w-full">
          {STAGE_ORDER.map((s, i) => {
            const isActive = i === currentIdx;
            const isDone = i < currentIdx;
            return (
              <div
                key={s}
                className="flex items-center gap-[8px] py-[2px]"
                style={{ opacity: isActive ? 1 : isDone ? 0.3 : 0.1, transition: 'opacity .3s' }}
              >
                <span className="text-[10px] min-w-[10px]" style={{ color: isActive ? '#f59e0b' : isDone ? '#444' : '#222' }}>
                  {isActive ? '›' : isDone ? '✓' : '·'}
                </span>
                <span className="text-[8px] uppercase tracking-[.07em]" style={{ color: isActive ? '#bbb' : '#444' }}>
                  {STAGE_LABELS[s as Exclude<PdfLoadStage, 'idle' | 'done' | 'error'>]}
                  {isActive ? dots : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function IdleScreen({ errorMessage }: { errorMessage?: string | null }) {
  return (
    <div className="absolute inset-0 z-[80] bg-[#0c0c0c] flex flex-col items-center justify-center font-mono">
      <style>{`@keyframes gridmove{from{background-position:0 0}to{background-position:40px 40px}}`}</style>
      <div
        className="absolute inset-0 opacity-[.04] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)',
          backgroundSize: '40px 40px',
          animation: 'gridmove 6s linear infinite',
        }}
      />
      <div className="relative z-[1] text-center w-[340px]">
        <div className="text-[28px] text-[#f59e0b] mb-[18px]">⊕</div>
        <div className="text-[10px] font-bold text-[#f59e0b] uppercase tracking-[.18em] mb-[6px]">PDF Snap Engine</div>
        <p className="text-[8px] text-[#444] uppercase tracking-[.1em] my-[12px] leading-[2]">
          {errorMessage ? `Error: ${errorMessage}` : 'Load a PDF floor plan to begin'}
        </p>
        <p className="text-[8px] text-[#222] uppercase tracking-[.07em] mt-[20px] leading-[2]">
          Vector PDFs give exact snap points · scanned PDFs are not supported yet
        </p>
      </div>
    </div>
  );
}