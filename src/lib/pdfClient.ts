// pdfClient.ts
let pdfjsLib: typeof import("pdfjs-dist/legacy/build/pdf") | null = null;

if (typeof window !== "undefined") {
  pdfjsLib = require("pdfjs-dist/legacy/build/pdf");
  pdfjsLib!.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
}

export default pdfjsLib;