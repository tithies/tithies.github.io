import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSearch, type F2FDoc, type SearchResponse } from '@/lib/f2f/api';

export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;
export const docs = (name: string): F2FDoc[] => parseSearch(fixture<SearchResponse>(name)).docs;
