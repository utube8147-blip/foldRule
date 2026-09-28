// ─── lib/pdf/pdfClient.ts ────────────────────────────────────────────────────
//  The single PDF.js instance used by the production viewer.
//
//  • Loaded synchronously and only in the browser (the Viewer is rendered with
//    ssr:false), hence `require` rather than a top-level ESM import.
//  • The worker is served from /public/pdf.worker.min.js. It MUST be the same
//    version as the `pdfjs-dist` package — package.json pins the exact version.
//    After upgrading pdfjs-dist, copy the new worker:
//      cp node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs public/pdf.worker.min.js
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let pdfjsLib: any = null;

if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
}

export const PDFJS_WORKER_VERSION = '6.0.227';

export default pdfjsLib;
