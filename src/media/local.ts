// Local disk backend. Files live under <root>/<storageKey>. No public
// URLs — bytes always proxy through /api/v1/media/:id/raw.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaStorage } from './storage.js';

export class LocalStorage implements MediaStorage {
  readonly name = 'local' as const;

  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const abs = join(this.root, key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(join(this.root, key)));
  }

  async delete(key: string): Promise<void> {
    try { await unlink(join(this.root, key)); } catch { /* already gone */ }
  }

  publicUrl(): null { return null; }
}
