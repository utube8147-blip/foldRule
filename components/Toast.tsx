import React from 'react';
import { AnimatePresence } from 'motion/react';
import * as motion from 'motion/react-m';
import { CheckCircle2, Info } from 'lucide-react';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'info';
}

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

export function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return (
    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
            className="bg-industrial-panel border border-amber-accent/50 p-3 flex items-center gap-3 shadow-2xl pointer-events-auto min-w-[300px]"
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            ) : (
              <Info className="w-4 h-4 text-amber-accent" />
            )}
            <span className="text-xs font-mono font-bold text-zinc-100 uppercase tracking-widest">
              {toast.message}
            </span>
            <button 
              onClick={() => onRemove(toast.id)}
              className="ml-auto text-zinc-600 hover:text-zinc-400"
            >
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
