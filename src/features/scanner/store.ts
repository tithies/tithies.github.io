/**
 * The Scanner prototype's own IndexedDB database ("tithies-scanner"), apart from the main one so
 * its schema can change freely while it's a prototype. It holds the reference vectors of prints
 * (Scryfall prints: shared by every account, so forgetting an account leaves them). Model files
 * live in Cache Storage (model-cache.ts). Settings → Remove all data deletes both.
 */
import Dexie, { type EntityTable } from 'dexie';
import { clearModelCache } from './model-cache';
import { DINO_FILE, RUNS } from './models';

/** Vectors made with another model or other runs are not comparable: they're made again. */
export const MODEL_KEY = `${DINO_FILE.id}|${RUNS.map((r) => r.id).join(',')}|v1`;

export interface RefRow {
  scryfallId: string;
  modelKey: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  lang?: string;
  /** One normalized vector per variant (models.ts). */
  vectors: Record<string, Float32Array>;
  phash: Uint32Array;
  addedAt: number;
}

export class ScannerDB extends Dexie {
  refs!: EntityTable<RefRow, 'scryfallId'>;

  constructor(name = 'tithies-scanner') {
    super(name);
    this.version(1).stores({ refs: 'scryfallId, modelKey' });
  }
}

export const scannerDb = new ScannerDB();

/** Reference prints made with the current model. */
export const currentRefs = (): Promise<RefRow[]> => scannerDb.refs.where('modelKey').equals(MODEL_KEY).toArray();
export const currentRefIds = async (): Promise<Set<string>> => new Set(await scannerDb.refs.where('modelKey').equals(MODEL_KEY).primaryKeys());

/** Bytes the reference vectors take (vectors and hash), and how many prints. */
export async function measureScannerData(): Promise<{ prints: number; bytes: number }> {
  let prints = 0;
  let bytes = 0;
  await scannerDb.refs.each((r) => {
    prints++;
    bytes += Object.values(r.vectors).reduce((s, v) => s + v.byteLength, 0) + r.phash.byteLength + 120;
  });
  return { prints, bytes };
}

/** Deletes every reference vector and every cached model file. */
export async function clearScannerData(): Promise<void> {
  await scannerDb.refs.clear();
  if (typeof caches !== 'undefined') await clearModelCache();
}
