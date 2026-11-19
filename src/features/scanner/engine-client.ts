/**
 * The Scanner page's side of the engine (see protocol.ts): opens the sandboxed engine page in a
 * hidden iframe, starts it with onnxruntime's WebAssembly (fetched from the extension itself),
 * and turns requests into promises.
 */
import { browser } from 'wxt/browser';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { CHANNEL, type EngineCall, type EngineInfo, type EngineReply, type EngineRequest, type EngineResults } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class ScannerEngine {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly onMessage = (e: MessageEvent) => {
    if (e.source !== this.iframe.contentWindow) return;
    const msg = e.data as EngineReply;
    if (msg?.channel !== CHANNEL || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'Engine error'));
  };

  private constructor(private readonly iframe: HTMLIFrameElement) {
    window.addEventListener('message', this.onMessage);
  }

  /** Opens the engine and starts OpenCV and onnxruntime in it. */
  static async start(): Promise<{ engine: ScannerEngine; info: EngineInfo }> {
    const iframe = document.createElement('iframe');
    iframe.src = browser.runtime.getURL('/scanner.html');
    iframe.title = 'Scanner engine';
    Object.assign(iframe.style, { position: 'absolute', width: '0', height: '0', border: '0', visibility: 'hidden' });
    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The scanner engine page did not start')), 30_000);
      const listener = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && e.data?.channel === CHANNEL && e.data.hello) {
          clearTimeout(timer);
          window.removeEventListener('message', listener);
          resolve();
        }
      };
      window.addEventListener('message', listener);
    });
    document.body.appendChild(iframe);
    const engine = new ScannerEngine(iframe);
    try {
      await hello;
      const wasm = await (await fetch(ortWasmUrl)).arrayBuffer();
      const info = await engine.call({ type: 'init', ortWasm: wasm }, [wasm]);
      return { engine, info };
    } catch (e) {
      engine.dispose();
      throw e;
    }
  }

  call<T extends EngineRequest['type']>(request: Extract<EngineRequest, { type: T }>, transfer: Transferable[] = []): Promise<EngineResults[T]> {
    const id = this.nextId++;
    const msg: EngineCall = { channel: CHANNEL, id, request };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // The engine's origin is opaque (sandboxed), so it can't be named as the target.
      this.iframe.contentWindow!.postMessage(msg, '*', transfer);
    });
  }

  dispose() {
    window.removeEventListener('message', this.onMessage);
    for (const p of this.pending.values()) p.reject(new Error('The scanner engine was closed'));
    this.pending.clear();
    this.iframe.remove();
  }
}
