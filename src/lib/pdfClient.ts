// pdfClient.ts
"use client";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf";

GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

export default pdfjsLib;