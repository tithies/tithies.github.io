// Copies the built extension to a Windows folder so Windows Chrome can "Load unpacked" it from WSL builds.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dirname, '..', '.output', 'chrome-mv3');
// Default: C:\Users\<your login>\tithies-ext (WSL and Windows user names usually match); set TITHIES_WIN_DIR otherwise.
const user = process.env.USER ?? process.env.USERNAME;
if (!process.env.TITHIES_WIN_DIR && !user) throw new Error('Set TITHIES_WIN_DIR to the Windows folder to copy the extension to.');
const dest = process.env.TITHIES_WIN_DIR ?? join('/mnt/c/Users', user, 'tithies-ext');
if (!existsSync(src)) throw new Error(`Build output not found: ${src}`);
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} -> ${dest}`);
