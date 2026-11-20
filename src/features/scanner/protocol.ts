/**
 * Messages between the Scanner page and its engine, a sandboxed page in a hidden iframe
 * (entrypoints/scanner.sandbox). OpenCV.js and onnxruntime-web both build functions from strings
 * (`new Function`), which extension pages forbid and sandboxed pages allow. The sandbox has no
 * storage and no network of its own: the page sends it the bytes it needs and keeps the results.
 */
import type { CleanupReason } from './cleanup';
import type { Quad, RejectReason } from './geometry';

export interface EngineInfo {
  opencv: string;
  ort: string;
  webgpu: boolean;
  /** Where the model runs: 'webgpu', or 'wasm' (CPU) when WebGPU isn't available. */
  backend: 'webgpu' | 'wasm' | null;
}

/** How cards are found: the classic passes (edges, threshold, lines, grid), the trained detector, or both. */
export type DetectMethod = 'classic' | 'model' | 'both';

export interface DetectOptions {
  /** The photo is shrunk to this many pixels on its long side for detection (corners are scaled back). */
  maxSide: number;
  /** Also send back the edge map and every rejected shape. */
  debug: boolean;
  method: DetectMethod;
  /** The trained detector's score above which a card counts. */
  modelThreshold: number;
}

export type CardSource = 'edges' | 'threshold' | 'lines' | 'grid' | 'model';

export interface DetectedCard {
  /** Corners in the photo's pixels (full resolution), card upright or upside down. */
  quad: Quad;
  score: number;
  source: CardSource;
}

export interface RejectedShape {
  quad: Quad;
  /** Not card-shaped (RejectReason), a duplicate outline, a group of touching cards, or a piece of a card. */
  /** …or, once named (cleanup.ts), an outline around neighbours or a second outline of one card. */
  reason: RejectReason | 'duplicate' | 'group' | 'fragment' | CleanupReason;
}

export interface DetectResult {
  width: number;
  height: number;
  cards: DetectedCard[];
  rejected: RejectedShape[];
  /** Edges found (debug), at detection size. */
  edges?: ImageBitmap;
  ms: number;
}

/** A card's vectors: one per variant (models.ts) and its pHash, for each way up. */
export interface Features {
  vectors: Record<string, Float32Array>;
  phash: Uint32Array;
}

export interface CardFeatures {
  /** The flattened card (488 × 680), upright as the corners say. */
  crop: ImageBitmap;
  /** Card height in the photo, in pixels. */
  heightPx: number;
  upright: Features;
  /** The same card turned 180°. */
  turned: Features;
}

export type EngineRequest =
  | { type: 'init'; ortWasm: ArrayBuffer }
  | { type: 'loadModel'; bytes: ArrayBuffer }
  /** The trained card detector (scanner-train/export.py). */
  | { type: 'loadDetector'; bytes: ArrayBuffer }
  | { type: 'loadPhoto'; photoId: string; bitmap: ImageBitmap }
  | { type: 'detect'; photoId: string; options: DetectOptions }
  | { type: 'cardFeatures'; photoId: string; quads: Quad[] }
  | { type: 'imageFeatures'; bitmaps: ImageBitmap[] }
  | { type: 'releasePhoto'; photoId: string }
  /** Prototype tuning, from the console: times the model with other session options. */
  | { type: 'bench'; ep: 'webgpu' | 'wasm'; opt: 'disabled' | 'basic' | 'extended' | 'all'; runs: number; gpuOutputs?: boolean; batch?: number };

export interface EngineResults {
  init: EngineInfo;
  loadModel: { backend: 'webgpu' | 'wasm'; ms: number };
  loadDetector: { size: number; backend: 'webgpu' | 'wasm'; ms: number };
  loadPhoto: { width: number; height: number };
  detect: DetectResult;
  cardFeatures: { cards: CardFeatures[]; ms: number };
  imageFeatures: { features: Features[]; ms: number };
  releasePhoto: null;
  bench: { create: number; runs: number[]; reads: number[] };
}

export interface EngineCall {
  channel: 'tithies-scanner';
  id: number;
  request: EngineRequest;
}

export interface EngineReply {
  channel: 'tithies-scanner';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Sent by the sandbox once its script runs (before init). */
export interface EngineHello {
  channel: 'tithies-scanner';
  hello: true;
}

export const CHANNEL = 'tithies-scanner';
