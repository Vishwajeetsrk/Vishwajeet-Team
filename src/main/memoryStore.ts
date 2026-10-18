/**
 * MemoryRepo seam for the Phase 5 scoped-memory store.
 *
 * Mirrors `computerStore.ts`: a pure interface + an in-memory test double, so
 * node tests never transitively import better-sqlite3/electron (the production
 * adapter `SqliteMemoryRepo` lives in db.ts). The double's `serialize()` /
 * `static from()` model an app restart — the same proven pattern the computer
 * persistence tests use.
 */

import type { MemoryRecord, MemoryScope, MemoryStatus } from '../shared/memoryRecord';

export interface MemoryFilter {
  scope?: MemoryScope;
  status?: MemoryStatus | 'all';
  projectId?: string;
  agentId?: string;
  taskId?: string;
  ownerId?: string;
}

export interface MemoryRepo {
  /** Equality-filtered listing (fresh copies), oldest-first. */
  list(filter?: MemoryFilter): MemoryRecord[];
  get(id: string): MemoryRecord | null;
  insert(rec: MemoryRecord): void;
  update(rec: MemoryRecord): void;
  /** Hard delete — the service soft-deletes (status='deleted'); reserved for
   *  retention cleanup of long-expired rows. */
  delete(id: string): void;
}

function matches(rec: MemoryRecord, f?: MemoryFilter): boolean {
  if (!f) return true;
  if (f.scope !== undefined && rec.scope !== f.scope) return false;
  if (f.status !== undefined && f.status !== 'all' && rec.status !== f.status) return false;
  if (f.projectId !== undefined && rec.projectId !== f.projectId) return false;
  if (f.agentId !== undefined && rec.agentId !== f.agentId) return false;
  if (f.taskId !== undefined && rec.taskId !== f.taskId) return false;
  if (f.ownerId !== undefined && rec.ownerId !== f.ownerId) return false;
  return true;
}

function clone(rec: MemoryRecord): MemoryRecord {
  return { ...rec, accessList: [...rec.accessList] };
}

/** In-memory MemoryRepo for tests (name mirrors `MemoryComputerRepo`). */
export class MemoryMemoryRepo implements MemoryRepo {
  private rows = new Map<string, MemoryRecord>();

  list(filter?: MemoryFilter): MemoryRecord[] {
    return [...this.rows.values()]
      .filter((r) => matches(r, filter))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  get(id: string): MemoryRecord | null {
    const rec = this.rows.get(id);
    return rec ? clone(rec) : null;
  }

  insert(rec: MemoryRecord): void {
    if (this.rows.has(rec.id)) throw new Error(`memory already exists: ${rec.id}`);
    this.rows.set(rec.id, clone(rec));
  }

  update(rec: MemoryRecord): void {
    if (!this.rows.has(rec.id)) throw new Error(`memory not found: ${rec.id}`);
    this.rows.set(rec.id, clone(rec));
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  /** Snapshot for restart simulation (deep copy — later writes don't alias). */
  serialize(): string {
    return JSON.stringify([...this.rows.values()].map(clone));
  }

  static from(json: string): MemoryMemoryRepo {
    const repo = new MemoryMemoryRepo();
    const parsed = JSON.parse(json) as MemoryRecord[];
    for (const rec of parsed) repo.rows.set(rec.id, clone(rec));
    return repo;
  }
}
