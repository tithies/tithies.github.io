/**
 * The image models the prototype compares. One ONNX file (DINOv2-small, pinned revision) runs at
 * two input sizes; each run gives two vectors (the CLS token, and the mean of the patch tokens),
 * so each card gets four vectors. Padded · CLS names cards best and is the one kept; the others stay for the dev page.
 */

export interface ModelFile {
  id: string;
  label: string;
  url: string;
  /** Size in bytes, for the download progress bar. */
  bytes: number;
}

/** Xenova/dinov2-small (Apache-2.0) at a fixed revision, fp32. */
export const DINO_FILE: ModelFile = {
  id: 'dinov2-small-fp32',
  label: 'DINOv2-small (fp32)',
  url: 'https://huggingface.co/Xenova/dinov2-small/resolve/c2bb04a51fab207c420665f1946016107bffc701/onnx/model.onnx',
  bytes: 88_500_000,
};

/** The model's input: 224 × 224 (this ONNX export has fixed position embeddings: 16 × 16 patches). */
export const INPUT = 224;

/**
 * One model run. 'squash': the card resized to 224 × 224 (proportions lost, every pixel used).
 * 'pad': the card resized to 161 × 224 (its proportions) and centred, the sides filled with the
 * normalization mean (zeros).
 */
export interface ModelRun {
  id: string;
  mode: 'squash' | 'pad';
}

export const RUNS: ModelRun[] = [
  { id: 'squash', mode: 'squash' },
  { id: 'pad', mode: 'pad' },
];

export type Pooling = 'cls' | 'mean';

/** A way to turn a card into a vector: which run, which pooling. Its id names the reference vectors. */
export interface Variant {
  id: string;
  label: string;
  run: string;
  pooling: Pooling;
}

export const VARIANTS: Variant[] = [
  { id: 'dino-squash-cls', label: 'DINOv2 squashed · CLS', run: 'squash', pooling: 'cls' },
  { id: 'dino-squash-mean', label: 'DINOv2 squashed · mean', run: 'squash', pooling: 'mean' },
  { id: 'dino-pad-cls', label: 'DINOv2 padded · CLS', run: 'pad', pooling: 'cls' },
  { id: 'dino-pad-mean', label: 'DINOv2 padded · mean', run: 'pad', pooling: 'mean' },
];

/** Every searched method: the variants. */
export const ALL_METHODS: { id: string; label: string }[] = VARIANTS.map(({ id, label }) => ({ id, label }));

/** Phase 3: padded · CLS, then the print among same-art reprints checked (scanner-check.ts). */
export const CHECK_METHOD = 'dino-pad-cls+check';
/** The methods the tables show: the searched ones and the checked one. */
export const SHOWN_METHODS: { id: string; label: string }[] = [...ALL_METHODS, { id: CHECK_METHOD, label: 'Padded · CLS + print check' }];

/** DINOv2's expected pixel normalization (ImageNet). */
export const MEAN = [0.485, 0.456, 0.406] as const;
export const STD = [0.229, 0.224, 0.225] as const;

/** DINOv2-small's vector size. */
export const DIM = 384;

/** The size every card picture is flattened to (Scryfall's "normal" image size). */
export const CARD_W = 488;
export const CARD_H = 680;
