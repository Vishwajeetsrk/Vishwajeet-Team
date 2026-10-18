/**
 * Computer registry persistence seam.
 *
 * `ComputerManager` depends on this interface only. Production wiring passes
 * `PersistStore` (SQLite, migration 2 — src/main/db.ts), which structurally
 * implements `ComputerRepo`. Unit tests pass `MemoryComputerRepo`, because
 * better-sqlite3 is built for the Electron ABI (upstream postinstall runs
 * `electron-rebuild -f`) and plain node cannot load it — the same reason no
 * upstream test imports db.ts.
 */

import type { ComputerRecord } from '../shared/computer';

export interface ComputerRepo {
  list(): ComputerRecord[];
  get(id: string): ComputerRecord | null;
  getByAgent(agentId: string): ComputerRecord | null;
  insert(rec: ComputerRecord): void;
  update(rec: ComputerRecord): void;
  delete(id: string): void;
}

/**
 * In-memory repo for tests. `serialize()`/`static from()` model an app
 * restart: a fresh manager over data reloaded from storage.
 */
export class MemoryComputerRepo implements ComputerRepo {
  private rows = new Map<string, ComputerRecord>();

  constructor(initial?: Iterable<ComputerRecord>) {
    for (const rec of initial ?? []) this.rows.set(rec.id, { ...rec });
  }

  list(): ComputerRecord[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  get(id: string): ComputerRecord | null {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  getByAgent(agentId: string): ComputerRecord | null {
    for (const r of this.rows.values()) {
      if (r.agentId === agentId) return { ...r };
    }
    return null;
  }

  insert(rec: ComputerRecord): void {
    if (this.rows.has(rec.id)) throw new Error(`computer already exists: ${rec.id}`);
    this.rows.set(rec.id, { ...rec });
  }

  update(rec: ComputerRecord): void {
    if (!this.rows.has(rec.id)) throw new Error(`computer not found: ${rec.id}`);
    this.rows.set(rec.id, { ...rec });
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  /** Snapshot for restart simulation (deep copy via JSON-safe records). */
  serialize(): string {
    return JSON.stringify(this.list());
  }

  static from(json: string): MemoryComputerRepo {
    const rows = JSON.parse(json) as ComputerRecord[];
    return new MemoryComputerRepo(rows);
  }
}
