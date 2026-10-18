/**
 * AuditStore — dedicated append-only audit trail (Phase 6 / Orbit §8).
 *
 * Format: JSONL at `<root>/audit-log.jsonl` (root = harness home, resolved
 * lazily). Every line passes through the hive `redactSecrets` battery BEFORE
 * it can reach disk — if redaction would break the JSON (a redaction
 * placeholder containing quotes, pathological input), the event is dropped
 * (fail-closed for audit content: better no line than a secret line).
 *
 * Capped: when the file exceeds MAX_AUDIT_BYTES we keep only the newest
 * MAX_AUDIT_EVENTS lines (rewrite temp+rename). Query is newest-first.
 *
 * The audit sink must never break the audited operation — every method swallows
 * and console.errors.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './hive';

export interface AuditEvent {
  at: string;
  kind: string;
  actor?: string;
  domain?: string;
  action?: string;
  target?: string;
  decision?: string;
  ruleId?: string;
  approvalId?: string;
  detail?: string;
}

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 5000;
const MAX_QUERY_LIMIT = 500;

export class AuditStore {
  constructor(private readonly root: () => string) {}

  private file(): string { return join(this.root(), 'audit-log.jsonl'); }

  record(evt: Omit<AuditEvent, 'at'> & { at?: string }): void {
    try {
      const line = JSON.stringify({ at: evt.at ?? new Date().toISOString(), ...evt });
      const redacted = redactSecrets(line);
      let parsed: AuditEvent;
      try {
        parsed = JSON.parse(redacted);
      } catch {
        console.error('[audit] event dropped — redaction broke JSON (fail-closed)');
        return;
      }
      const dir = this.root();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const f = this.file();
      // appendFileSync is atomic-enough for O_APPEND single-line appends on
      // POSIX; Windows small-line appends hold the same property in practice.
      appendFileSync(f, JSON.stringify(parsed) + '\n', 'utf8');
      this.trimIfNeeded(f);
    } catch (e) {
      console.error('[audit] record failed:', e);
    }
  }

  private trimIfNeeded(f: string): void {
    try {
      if (!existsSync(f) || statSync(f).size <= MAX_AUDIT_BYTES) return;
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-MAX_AUDIT_EVENTS);
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      renameSync(tmp, f);
    } catch (e) {
      console.error('[audit] trim failed:', e);
    }
  }

  /** Newest-first query. `kind` filters on event kind substring-free equality. */
  query(filter: { kind?: string; limit?: number } = {}): AuditEvent[] {
    try {
      const f = this.file();
      if (!existsSync(f)) return [];
      const limit = Math.min(Math.max(1, filter.limit ?? 200), MAX_QUERY_LIMIT);
      const out: AuditEvent[] = [];
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const raw = lines[i];
        if (!raw) continue;
        try {
          const evt = JSON.parse(raw) as AuditEvent;
          if (filter.kind && evt.kind !== filter.kind) continue;
          out.push(evt);
        } catch { /* skip corrupt line */ }
      }
      return out;
    } catch (e) {
      console.error('[audit] query failed:', e);
      return [];
    }
  }
}
