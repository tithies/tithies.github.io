/**
 * Messages between the Scanner page and its engine, a sandboxed page in a hidden iframe
 * (entrypoints/scanner.sandbox). OpenCV.js and onnxruntime-web both build functions from strings
 * (`new Function`), which extension pages forbid and sandboxed pages allow. The sandbox has no
 * storage and no network of its own: the page sends it the bytes it needs and keeps the results.
 */
import type { CleanupReason } from './cleanup';
import type { Quad } from './geometry';

/** A call to the engine or the search worker after it was closed (the page left, or the index was replaced). */
export class ClosedError extends Error {
  constructor(what: string) {
    super(`${what} was closed`);
    this.name = 'ClosedError';
  }
}

export interface EngineInfo {
  opencv: string;
  ort: string;
  webgpu: boolean;
  /** Where the model runs: 'webgpu', or 'wasm' (CPU) when WebGPU isn't available. */
  backend: 'webgpu' | 'wasm' | null;
}

export interface DetectOptions {
  /** The trained detector's score above which a card counts. */
  modelThreshold: number;
}

/** Found by the trained detector, or outlined by the user (4 corners). */
export type CardSource = 'model' | 'user';

export interface DetectedCard {
  /** Corners in the photo's pixels (full resolution), card upright or upside down. */
  quad: Quad;
  score: number;
  source: CardSource;
}

export interface RejectedShape {
  quad: Quad;
  /** Once named (cleanup.ts): an outline around neighbours, or a second outline of one card. */
  reason: CleanupReason;
}

export interface DetectResult {
  width: number;
  height: number;
  cards: DetectedCard[];
  ms: number;
}

/** A card's vectors: one per variant (models.ts), for each way up. */
export interface Features {
  vectors: Record<string, Float32Array>;
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

/** The OCR models (engine/text.ts): the text detector and the recognizers. */
export type TextModelName = 'det' | 'latin' | 'main' | 'korean' | 'cyrillic';

/** Where a text box is on a card cut-out: its centre height, left edge and height as shares of the card. */
export interface TextBoxGeo {
  y: number;
  x: number;
  h: number;
}

/** A text box read. */
export interface TextLineRead extends TextBoxGeo {
  text: string;
  conf: number;
}

export type EngineRequest =
  | { type: 'init'; ortWasm: ArrayBuffer }
  | { type: 'loadModel'; bytes: ArrayBuffer }
  /** The trained card detector (export.py in the tithies-scanner-trainer repo). */
  | { type: 'loadDetector'; bytes: ArrayBuffer }
  | { type: 'loadPhoto'; photoId: string; bitmap: ImageBitmap }
  | { type: 'detect'; photoId: string; options: DetectOptions }
  | { type: 'cardFeatures'; photoId: string; quads: Quad[] }
  | { type: 'imageFeatures'; bitmaps: ImageBitmap[] }
  | { type: 'releasePhoto'; photoId: string }
  /** An OCR model; a recognizer comes with its characters (its inference.yml's). */
  | { type: 'loadTextModel'; name: TextModelName; bytes: ArrayBuffer; chars?: string[]; prefer?: 'webgpu' | 'wasm' }
  /** A card's 672 × 936 cut-out from a loaded photo, kept in the engine for readText and checkPrint. */
  | { type: 'cardDetail'; photoId: string; detailId: string; quad: Quad }
  /** The cut-out's text boxes (the detector): where each line is, not read yet. */
  | { type: 'findText'; detailId: string }
  /** Reads boxes `lines` (indices into findText's boxes) with a recognizer. */
  | { type: 'readText'; detailId: string; model: Exclude<TextModelName, 'det'>; lines: number[] }
  /** Which of the candidates' pictures (same art) the cut-out is (engine/print-visual.ts). */
  | { type: 'checkPrint'; detailId: string; pictures: ImageBitmap[] }
  /** Runs the detector and a recognizer once on blank input (WebGPU compiles their shaders now). */
  | { type: 'warmText'; model: Exclude<TextModelName, 'det'>; widths?: number[] }
  /** Frees a cut-out (all of them without an id). */
  | { type: 'releaseDetail'; detailId?: string }
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
  loadTextModel: { backend: 'webgpu' | 'wasm'; ms: number };
  cardDetail: { ms: number };
  findText: { boxes: TextBoxGeo[]; ms: number };
  readText: { lines: TextLineRead[]; ms: number };
  checkPrint: { winner: number | null; margin: number; pairs: number[][]; ms: number };
  releaseDetail: null;
  warmText: { ms: number };
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
