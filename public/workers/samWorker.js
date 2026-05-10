"use strict";
var __samWorker = (() => {
  // public/workers/samWorker.ts
  var SAM_SIZE = 1024;
  var encoderSession = null;
  var decoderSession = null;
  var imageEmbedding = null;
  var modelsLoaded = false;
  var isEncoding = false;
  async function loadModels() {
    if (modelsLoaded) return;
    self.postMessage({ type: "progress", step: "loading onnxruntime-web\u2026" });
    importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js");
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/";
    self.postMessage({ type: "progress", step: "loading encoder\u2026" });
    encoderSession = await ort.InferenceSession.create("/models/sam/mobile_sam_encoder.onnx", {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    self.postMessage({ type: "progress", step: "loading decoder\u2026" });
    decoderSession = await ort.InferenceSession.create("/models/sam/mobilesam.decoder.quant.onnx", {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    modelsLoaded = true;
    self.postMessage({ type: "progress", step: "models ready" });
  }
  function preprocessImage(imageData, srcW, srcH) {
    const srcPixels = imageData.data;
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const out = new Float32Array(3 * SAM_SIZE * SAM_SIZE);
    for (let y = 0; y < SAM_SIZE; y++) {
      for (let x = 0; x < SAM_SIZE; x++) {
        const srcX = Math.min(Math.floor(x * srcW / SAM_SIZE), srcW - 1);
        const srcY = Math.min(Math.floor(y * srcH / SAM_SIZE), srcH - 1);
        const srcIdx = (srcY * srcW + srcX) * 4;
        const r = srcPixels[srcIdx] / 255;
        const g = srcPixels[srcIdx + 1] / 255;
        const b = srcPixels[srcIdx + 2] / 255;
        const dstIdx = y * SAM_SIZE + x;
        out[0 * SAM_SIZE * SAM_SIZE + dstIdx] = (r - mean[0]) / std[0];
        out[1 * SAM_SIZE * SAM_SIZE + dstIdx] = (g - mean[1]) / std[1];
        out[2 * SAM_SIZE * SAM_SIZE + dstIdx] = (b - mean[2]) / std[2];
      }
    }
    return out;
  }
  async function encodeImage(imageData, width, height) {
    if (!modelsLoaded) await loadModels();
    if (isEncoding) return;
    isEncoding = true;
    try {
      self.postMessage({ type: "progress", step: "preprocessing image\u2026" });
      const pixels = preprocessImage(imageData, width, height);
      const inputTensor = new ort.Tensor("float32", pixels, [1, 3, SAM_SIZE, SAM_SIZE]);
      self.postMessage({ type: "progress", step: "encoding (this takes ~5s first time)\u2026" });
      const results = await encoderSession.run({ image: inputTensor });
      imageEmbedding = results["image_embeddings"];
      self.postMessage({ type: "encoded" });
    } catch (err) {
      self.postMessage({ type: "error", message: `Encode failed: ${err?.message ?? err}` });
    } finally {
      isEncoding = false;
    }
  }
  async function segment(clickX, clickY, canvasW, canvasH) {
    if (!imageEmbedding) {
      self.postMessage({ type: "error", message: "No embedding \u2014 call encode first" });
      return;
    }
    try {
      const samX = clickX / canvasW * SAM_SIZE;
      const samY = clickY / canvasH * SAM_SIZE;
      const pointCoords = new ort.Tensor("float32", new Float32Array([samX, samY, 0, 0]), [1, 2, 2]);
      const pointLabels = new ort.Tensor("float32", new Float32Array([1, -1]), [1, 2]);
      const maskInput = new ort.Tensor("float32", new Float32Array(1 * 1 * 256 * 256), [1, 1, 256, 256]);
      const hasMask = new ort.Tensor("float32", new Float32Array([0]), [1]);
      const origSize = new ort.Tensor("float32", new Float32Array([canvasH, canvasW]), [2]);
      const feeds = {
        image_embeddings: imageEmbedding,
        point_coords: pointCoords,
        point_labels: pointLabels,
        mask_input: maskInput,
        has_mask_input: hasMask,
        orig_im_size: origSize
      };
      const results = await decoderSession.run(feeds);
      const masks = results["masks"];
      const scores = results["iou_predictions"];
      const maskData = masks.data;
      const scoreData = scores.data;
      let bestIdx = 0;
      for (let i = 1; i < 3; i++) {
        if (scoreData[i] > scoreData[bestIdx]) bestIdx = i;
      }
      const maskH = masks.dims[2];
      const maskW = masks.dims[3];
      const pixelCount = maskH * maskW;
      const offset = bestIdx * pixelCount;
      const binaryMask = new Uint8Array(pixelCount);
      for (let i = 0; i < pixelCount; i++) {
        binaryMask[i] = maskData[offset + i] > 0 ? 1 : 0;
      }
      self.postMessage(
        { type: "mask", mask: binaryMask, maskW, maskH },
        [binaryMask.buffer]
      );
    } catch (err) {
      self.postMessage({ type: "error", message: `Segment failed: ${err?.message ?? err}` });
    }
  }
  self.onmessage = async (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "encode":
        await encodeImage(msg.imageData, msg.width, msg.height);
        break;
      case "segment":
        await segment(msg.x, msg.y, msg.width, msg.height);
        break;
      default:
        self.postMessage({ type: "error", message: `Unknown message type: ${msg.type}` });
    }
  };
})();
