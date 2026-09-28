/**
 * Release a PDF.js document and its worker-side resources.
 * pdf.js v6 tears documents down through their loading task.
 */
export function destroyPdf(doc: unknown): void {
  const d = doc as { loadingTask?: { destroy?: () => Promise<void> }; destroy?: () => Promise<void> } | null;
  if (!d) return;
  try {
    const p = d.loadingTask?.destroy?.() ?? d.destroy?.();
    p?.catch?.(() => { /* already destroyed */ });
  } catch { /* ignore */ }
}
