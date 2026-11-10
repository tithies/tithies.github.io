import { browser } from 'wxt/browser';

/**
 * MV3 workers sleep after ~30 s without extension API activity, which would kill long jobs
 * (and their Retry-After / rate-limit waits). Each job holds the worker awake under its own name.
 */
const holds = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;

export function holdAwake(name: string, active: boolean): void {
  if (active) holds.add(name);
  else holds.delete(name);
  if (holds.size && !timer) timer = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
  if (!holds.size && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
