'use client';

// ─── components/common/ConfirmDialog.tsx ─────────────────────────────────────
//
//  One in-app replacement for window.confirm / window.alert, styled like the
//  rest of Foldrule. Usage:
//
//    const { confirm, alert } = useConfirm();
//    if (await confirm({ title: 'Remove drawing', message: '…', confirmText: 'Remove' })) { … }
//
//  • Focus goes to the safe choice (Cancel) for destructive actions.
//  • Esc cancels, Enter confirms, Tab stays inside the dialog.
//  • Nothing is rendered until a dialog is requested.
// ─────────────────────────────────────────────────────────────────────────────

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ConfirmTone = 'danger' | 'warning' | 'info';

export interface ConfirmOptions {
  title:        string;
  message:      React.ReactNode;
  /** Optional smaller line under the message (e.g. consequences). */
  detail?:      React.ReactNode;
  confirmText?: string;
  cancelText?:  string;
  tone?:        ConfirmTone;
}

interface Request extends ConfirmOptions {
  alertOnly: boolean;
  resolve:   (ok: boolean) => void;
}

interface ConfirmApi {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  alert:   (o: Omit<ConfirmOptions, 'cancelText'>) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (ctx) return ctx;
  // Outside the provider (shouldn't happen): fall back to the browser dialogs.
  return {
    confirm: async o => window.confirm(`${o.title}\n\n${typeof o.message === 'string' ? o.message : ''}`),
    alert:   async o => { window.alert(`${o.title}\n\n${typeof o.message === 'string' ? o.message : ''}`); },
  };
}

const TONE: Record<ConfirmTone, { icon: React.ReactNode; button: string; ring: string }> = {
  danger:  { icon: <AlertTriangle className="w-4 h-4 text-red-400" />,   button: 'bg-red-600 hover:bg-red-500 text-white',             ring: 'border-red-500/40' },
  warning: { icon: <AlertTriangle className="w-4 h-4 text-amber-400" />, button: 'bg-amber-accent hover:bg-amber-400 text-black',     ring: 'border-amber-400/40' },
  info:    { icon: <Info className="w-4 h-4 text-zinc-300" />,           button: 'bg-amber-accent hover:bg-amber-400 text-black',     ring: 'border-industrial-border' },
};

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<Request | null>(null);
  // The open request and the queue live in refs; state is only used to render.
  const currentRef = useRef<Request | null>(null);
  const queue      = useRef<Request[]>([]);

  const push = useCallback((r: Request) => {
    if (currentRef.current) { queue.current.push(r); return; }
    currentRef.current = r;
    setReq(r);
  }, []);

  const confirm = useCallback((o: ConfirmOptions) =>
    new Promise<boolean>(resolve => push({ ...o, alertOnly: false, resolve })), [push]);
  const alert = useCallback((o: Omit<ConfirmOptions, 'cancelText'>) =>
    new Promise<void>(resolve => push({ ...o, alertOnly: true, resolve: () => resolve() })), [push]);

  const close = useCallback((ok: boolean) => {
    const cur = currentRef.current;
    if (!cur) return;
    const next = queue.current.shift() ?? null;
    currentRef.current = next;
    setReq(next);
    cur.resolve(ok);
  }, []);

  const api = React.useMemo(() => ({ confirm, alert }), [confirm, alert]);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {req && <Dialog req={req} onClose={close} />}
    </ConfirmContext.Provider>
  );
}

function Dialog({ req, onClose }: { req: Request; onClose: (ok: boolean) => void }) {
  const tone = TONE[req.tone ?? (req.alertOnly ? 'info' : 'danger')];
  const boxRef     = useRef<HTMLDivElement>(null);
  const cancelRef  = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Destructive: focus Cancel so Enter/Space can't delete by accident.
    (req.alertOnly || req.tone === 'info' ? confirmRef : cancelRef).current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(false); return; }
      if (e.key === 'Tab') {
        const nodes = boxRef.current?.querySelectorAll<HTMLElement>('button');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus?.(); };
  }, [req, onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 animate-in fade-in duration-150"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(false); }}
    >
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className={cn('w-full max-w-sm bg-industrial-panel border shadow-2xl font-mono animate-in zoom-in-95 fade-in duration-150', tone.ring)}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-industrial-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="p-1.5 bg-industrial-black/60">{tone.icon}</span>
            <h2 id="confirm-title" className="text-xs font-bold uppercase tracking-widest text-zinc-100 truncate">{req.title}</h2>
          </div>
          <button type="button" onClick={() => onClose(false)} aria-label="Close" className="p-1 text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div id="confirm-message" className="px-4 py-4 space-y-2">
          <div className="text-xs text-zinc-300 leading-relaxed break-words">{req.message}</div>
          {req.detail && <div className="text-xs text-zinc-500 leading-relaxed">{req.detail}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-industrial-border bg-industrial-black/40">
          {!req.alertOnly && (
            <button
              ref={cancelRef}
              type="button"
              onClick={() => onClose(false)}
              className="px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-zinc-100 border border-transparent hover:border-industrial-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
            >
              {req.cancelText ?? 'Cancel'}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onClose(true)}
            className={cn('px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300', tone.button)}
          >
            {req.confirmText ?? (req.alertOnly ? 'OK' : 'Delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
