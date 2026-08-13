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
	// Deduplicate originalContent: keep first occurrence per filePath
	// (pending entries come first in the array, so they keep their content)
	const seen = new Map<string, number>();
	for (let i = 0; i < keep.length; i++) {
		const c = keep[i];
		if (seen.has(c.filePath)) {
			c.originalContent = "";
		} else {
			seen.set(c.filePath, i);
		}
	}

	const sp = statePath(cwd);
	const dir = dirname(sp);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${sp}.tmp`;
	writeFileSync(tmp, JSON.stringify(keep, null, 2));
	try {
		renameSync(tmp, sp);
	} catch {
		writeFileSync(sp, JSON.stringify(keep, null, 2));
	}
}

export function loadState(cwd: string): { changes: Change[]; nextId: number } {
	const changes: Change[] = [];
	let nextId = 1;

	// Migrate from old pi-review path if present
	const oldSp = join(cwd, ".pi", "pi-review", "state.json");
	const newSp = statePath(cwd);
	if (existsSync(oldSp) && !existsSync(newSp)) {
		try {
			const oldDir = dirname(newSp);
			if (!existsSync(oldDir)) mkdirSync(oldDir, { recursive: true });
			const oldRaw = readFileSync(oldSp, "utf8");
			writeFileSync(newSp, oldRaw);
		} catch {
			/* migration failed, start fresh */
		}
	}

	const sp = newSp;
	try {
		if (!existsSync(sp)) return { changes, nextId };
		const raw = JSON.parse(readFileSync(sp, "utf8"));
		if (!Array.isArray(raw)) return { changes, nextId };
		for (const c of raw) {
			if (!c || typeof c !== "object") continue;
			if (!existsSync(c.filePath) && c.status === "pending") continue;
			if (c.checked === undefined) c.checked = true;
			if (c.timestamp === undefined) c.timestamp = 0;
			if (c.batchId === undefined) c.batchId = 0;
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
						if (!existsSync(c.filePath) && c.status === "pending") continue;
						if (c.checked === undefined) c.checked = true;
						if (c.timestamp === undefined) c.timestamp = 0;
						if (c.batchId === undefined) c.batchId = 0;
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
