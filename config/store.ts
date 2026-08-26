import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Change } from "../types";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function statePath(cwd: string): string {
	return join(cwd, ".pi", "pi-vet", "state.json");
}

export function configPath(cwd: string): string {
	return join(cwd, ".pi", "pi-vet", "config.json");
}

export function loadEnabled(cwd: string): boolean {
	try {
		const cp = configPath(cwd);
		if (!existsSync(cp)) return true;
		const raw = JSON.parse(readFileSync(cp, "utf8"));
		return raw.enabled !== false;
	} catch {
		return true;
	}
}

export function saveEnabled(enabled: boolean, cwd: string): void {
	const cp = configPath(cwd);
	const dir = dirname(cp);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(cp, JSON.stringify({ enabled }, null, 2));
}

export function saveState(changes: Change[], cwd: string): void {
	// Keep only pending + latest batch (for undo). Drop stale accepted/reverted.
	const latestBatch = changes
		.filter((c) => c.status === "accepted" || c.status === "reverted")
		.reduce((max, c) => Math.max(max, c.batchId), 0);
	const keep = changes.filter(
		(c) =>
			c.status === "pending" ||
			c.status === "partial" ||
			c.batchId === latestBatch,
	);
	// Deduplicate originalContent: keep first occurrence per filePath.
	// Build a clean copy for serialization — never mutate in-memory objects.
	const seen = new Map<string, number>();
	const serialized = keep.map((c, i) => {
		if (seen.has(c.filePath)) {
			return { ...c, originalContent: "" };
		}
		seen.set(c.filePath, i);
		return c;
	});

	const sp = statePath(cwd);
	const dir = dirname(sp);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${sp}.tmp`;
	writeFileSync(tmp, JSON.stringify(serialized, null, 2));
	try {
		renameSync(tmp, sp);
	} catch {
		writeFileSync(sp, JSON.stringify(serialized, null, 2));
	}
}

export function loadState(cwd: string): { changes: Change[]; nextId: number } {
	const changes: Change[] = [];
	let nextId = 1;

  const sp = statePath(cwd);
  try {
    if (!existsSync(sp)) return { changes, nextId };
    const raw = JSON.parse(readFileSync(sp, "utf8"));
    if (!Array.isArray(raw)) return { changes, nextId };
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      if (!existsSync(c.filePath) && (c.status === "pending" || c.status === "partial") && !c.existed) continue;
      if (c.checked === undefined) c.checked = true;
      if (c.timestamp === undefined) c.timestamp = 0;
      if (c.batchId === undefined) c.batchId = 0;
      if (c.sessionId === undefined) c.sessionId = "";
      changes.push(c);
      const num = parseInt(String(c.id).slice(1));
      if (num >= nextId) nextId = num + 1;
    }
  } catch {
    try {
      const bak = `${sp}.bak`;
      if (existsSync(bak)) {
        const raw = JSON.parse(readFileSync(bak, "utf8"));
        if (Array.isArray(raw)) {
          for (const c of raw) {
            if (!c || typeof c !== "object") continue;
            if (!existsSync(c.filePath) && (c.status === "pending" || c.status === "partial")) continue;
            if (c.checked === undefined) c.checked = true;
            if (c.timestamp === undefined) c.timestamp = 0;
            if (c.batchId === undefined) c.batchId = 0;
            if (c.sessionId === undefined) c.sessionId = "";
            changes.push(c);
            const num = parseInt(String(c.id).slice(1));
            if (num >= nextId) nextId = num + 1;
          }
        }
      }
    } catch {
      /* both corrupted, start fresh */
    }
  }
  return { changes, nextId };
}

