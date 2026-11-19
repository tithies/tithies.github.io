/**
 * OpenCV.js (sandbox only: its bindings build functions from strings). Typed loosely: the
 * prototype uses a handful of functions, and every Mat must be freed with .delete().
 */
import cvModule from '@techstark/opencv-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mat = any;

let ready: Promise<{ cv: CV }> | null = null;

/**
 * Waits until OpenCV's WebAssembly is running. Emscripten's Module has a `then` that resolves
 * with the Module itself, so resolving a promise with it (or awaiting it) loops forever: it is
 * handed out wrapped, with its `then` removed.
 */
export function loadOpenCv(): Promise<{ cv: CV }> {
  ready ??= new Promise((resolve, reject) => {
    const done = (cv: CV) => {
      if (typeof cv.then === 'function') delete cv.then;
      resolve({ cv });
    };
    const m: CV = cvModule;
    if (m instanceof Promise) m.then((cv: CV) => done(cv), reject);
    else if (m.Mat) done(m);
    else m.onRuntimeInitialized = () => done(m);
  });
  return ready;
}

/** Frees OpenCV objects (Mats, MatVectors) that may be undefined. */
export function free(...objs: (Mat | undefined | null)[]) {
  for (const o of objs) if (o && !o.isDeleted?.()) o.delete();
}
