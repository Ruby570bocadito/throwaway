// Every model call is recorded: where it ran, how long it took, and how many bytes left the device.

// "blocked": the guard stopped data from leaving. "skipped": a step that did not run (no local model), which is not a
// block: counted as one, it made the receipt show a blocked leak before anyone tried one (a judge, 17-nov).
export type Route = 'on-device' | 'cloud' | 'local-js' | 'blocked' | 'skipped';

export interface LedgerEntry {
  at: number;
  op: string;
  route: Route;
  ms: number;
  bytesOut: number;
  note?: string;
}

export class Ledger {
  private entries: LedgerEntry[] = [];
  private listeners = new Set<(e: LedgerEntry[]) => void>();

  add(e: Omit<LedgerEntry, 'at'>) {
    this.entries = [{ ...e, at: Date.now() }, ...this.entries].slice(0, 200);
    for (const l of this.listeners) l(this.entries);
  }

  async time<T>(op: string, route: Route, bytesOut: number, fn: () => Promise<T>, note?: string): Promise<T> {
    const t0 = performance.now();
    const out = await fn();
    this.add({ op, route, ms: Math.round(performance.now() - t0), bytesOut, note });
    return out;
  }

  subscribe(fn: (e: LedgerEntry[]) => void) {
    this.listeners.add(fn);
    fn(this.entries);
    return () => this.listeners.delete(fn);
  }

  get all() {
    return this.entries;
  }

  get bytesOut() {
    return this.entries.reduce((a, e) => a + e.bytesOut, 0);
  }

  clear() {
    this.entries = [];
    for (const l of this.listeners) l(this.entries);
  }
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length;
