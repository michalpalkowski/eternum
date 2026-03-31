/**
 * Performance diagnostics for Torii/frontend bottleneck hunting.
 *
 * Tracks async operation timing, maintains running statistics, and prints
 * periodic summaries to the console.  Operations also emit `performance.mark`
 * / `performance.measure` entries so they show up in the Chrome Performance
 * tab flamechart.
 *
 * Enable/disable at runtime:
 *   localStorage.setItem("PERF_DIAG", "1")   // enable (default: enabled)
 *   localStorage.setItem("PERF_DIAG", "0")   // disable
 *
 * On-demand dump:
 *   (window as any).__perfDump()
 *
 * Reset stats:
 *   (window as any).__perfReset()
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const isEnabled = (): boolean => {
  try {
    const flag = localStorage.getItem("PERF_DIAG");
    // Enabled by default unless explicitly turned off.
    return flag !== "0";
  } catch {
    return true;
  }
};

const SLOW_THRESHOLD_MS = 500;
const SUMMARY_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Stats store
// ---------------------------------------------------------------------------

interface PerfEntry {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  errors: number;
  /** Timestamp (ms) of the most recent call */
  lastCalledAt: number;
}

const stats = new Map<string, PerfEntry>();
let markCounter = 0;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function track(label: string, durationMs: number, error = false): void {
  let entry = stats.get(label);
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, errors: 0, lastCalledAt: 0 };
    stats.set(label, entry);
  }
  entry.count += 1;
  entry.totalMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);
  entry.lastMs = durationMs;
  entry.lastCalledAt = Date.now();
  if (error) entry.errors += 1;

  if (durationMs > SLOW_THRESHOLD_MS) {
    console.warn(`[perf] SLOW ${label}: ${durationMs.toFixed(0)}ms`);
  }
}

/**
 * Wrap an async operation with timing + performance marks.
 *
 * Usage:
 *   const result = await timedAsync("getConfig", () => getConfigFromTorii(client, components));
 */
export async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isEnabled()) return fn();

  const id = ++markCounter;
  const startMark = `perf:${label}:${id}:start`;
  const endMark = `perf:${label}:${id}:end`;

  performance.mark(startMark);
  const t0 = performance.now();

  try {
    const result = await fn();
    const duration = performance.now() - t0;
    performance.mark(endMark);
    try {
      performance.measure(`[perf] ${label}`, startMark, endMark);
    } catch {
      // measure can throw if marks were cleared
    }
    track(label, duration);
    return result;
  } catch (err) {
    const duration = performance.now() - t0;
    track(label, duration, true);
    throw err;
  }
}

/**
 * Synchronous timing helper for blocking work (e.g. RECS setEntities).
 */
export function timedSync<T>(label: string, fn: () => T): T {
  if (!isEnabled()) return fn();

  const t0 = performance.now();
  try {
    const result = fn();
    track(label, performance.now() - t0);
    return result;
  } catch (err) {
    track(label, performance.now() - t0, true);
    throw err;
  }
}

/**
 * Log a one-off event with optional payload (shows in console, no stats).
 */
export function perfEvent(label: string, payload?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  if (payload) {
    console.log(`[perf:event] ${label}`, payload);
  } else {
    console.log(`[perf:event] ${label}`);
  }
  performance.mark(`[perf:event] ${label}`);
}

// ---------------------------------------------------------------------------
// Queue depth tracker (for debounced-queries)
// ---------------------------------------------------------------------------

const queueDepths = new Map<string, number>();

export function setQueueDepth(queueName: string, depth: number): void {
  queueDepths.set(queueName, depth);
}

// ---------------------------------------------------------------------------
// Summary / dump
// ---------------------------------------------------------------------------

function formatStats(): string[] {
  const lines: string[] = [];
  const sorted = [...stats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [label, entry] of sorted) {
    const avg = entry.count > 0 ? entry.totalMs / entry.count : 0;
    let line = `  ${label}: calls=${entry.count} avg=${avg.toFixed(0)}ms max=${entry.maxMs.toFixed(0)}ms total=${entry.totalMs.toFixed(0)}ms`;
    if (entry.errors > 0) line += ` errors=${entry.errors}`;
    lines.push(line);
  }
  return lines;
}

function dumpStats(): void {
  if (stats.size === 0) {
    console.log("[perf] No stats collected yet");
    return;
  }
  const lines = formatStats();
  console.group(`[perf] Stats dump (${stats.size} operations)`);
  lines.forEach((l) => console.log(l));

  if (queueDepths.size > 0) {
    console.log("  --- queue depths ---");
    queueDepths.forEach((depth, name) => {
      console.log(`  ${name}: ${depth}`);
    });
  }
  console.groupEnd();
}

function resetStats(): void {
  stats.clear();
  queueDepths.clear();
  console.log("[perf] Stats reset");
}

// ---------------------------------------------------------------------------
// Periodic summary (auto-started on import)
// ---------------------------------------------------------------------------

let summaryIntervalId: ReturnType<typeof setInterval> | null = null;

function startSummary(): void {
  if (summaryIntervalId !== null) return;
  summaryIntervalId = setInterval(() => {
    if (!isEnabled() || stats.size === 0) return;
    dumpStats();
  }, SUMMARY_INTERVAL_MS);
}

function stopSummary(): void {
  if (summaryIntervalId !== null) {
    clearInterval(summaryIntervalId);
    summaryIntervalId = null;
  }
}

// ---------------------------------------------------------------------------
// Global access (for console debugging)
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  (window as any).__perfDump = dumpStats;
  (window as any).__perfReset = resetStats;
  (window as any).__perfStop = stopSummary;
  startSummary();
}

export { dumpStats, resetStats, startSummary, stopSummary };
