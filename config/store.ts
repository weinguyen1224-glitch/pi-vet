import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Change, VetState } from "../types";

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

export function saveState(
	changes: Change[],
	cwd: string,
	lastTurnIds?: string[],
): void {
	const latestBatch = changes
		.filter((c) => c.status === "accepted" || c.status === "reverted")
		.reduce((max, c) => Math.max(max, c.batchId), 0);
	const keep = changes.filter(
		(c) =>
			c.status === "pending" ||
			c.status === "partial" ||
			c.batchId === latestBatch,
	);
	const sp = statePath(cwd);
	// Omitted lastTurnIds means "keep what is on disk" — renderers persist
	// checkbox/status edits without knowing the last agent turn.
	const previous =
		lastTurnIds === undefined ? (readStateFile(sp)?.lastTurnIds ?? []) : lastTurnIds;
	const survived = new Set(keep.map((c) => c.id));
	const state: VetState = {
		changes: dedupeOriginals(keep),
		lastTurnIds: previous.filter((id) => survived.has(id)),
	};

	const dir = dirname(sp);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const body = JSON.stringify(state, null, 2);
	const tmp = `${sp}.tmp`;
	writeFileSync(tmp, body);
	try {
		renameSync(tmp, sp);
	} catch {
		writeFileSync(sp, body);
	}
}

function dedupeOriginals(changes: Change[]): Change[] {
	const seen = new Set<string>();
	return changes.map((c) => {
		if (seen.has(c.filePath)) return { ...c, originalContent: "" };
		seen.add(c.filePath);
		return c;
	});
}

export function loadState(
	cwd: string,
	sessionId = "",
): { changes: Change[]; lastTurnIds: string[]; nextId: number } {
	const sp = statePath(cwd);
	const parsed = readStateFile(sp) ?? readStateFile(`${sp}.bak`);
	if (!parsed) return { changes: [], lastTurnIds: [], nextId: 1 };

	const changes: Change[] = [];
	let nextId = 1;
	for (const c of parsed.changes) {
		if (!c || typeof c !== "object" || typeof c.filePath !== "string") continue;
		const num = parseInt(String(c.id).slice(1));
		if (Number.isFinite(num) && num >= nextId) nextId = num + 1;
		if (!isReachable(c, sessionId)) continue;

		if (c.checked === undefined) c.checked = true;
		if (c.timestamp === undefined) c.timestamp = 0;
		if (c.batchId === undefined) c.batchId = 0;
		if (c.sessionId === undefined) c.sessionId = "";
		changes.push(c);
	}

	const kept = new Set(changes.map((c) => c.id));
	return {
		changes,
		lastTurnIds: parsed.lastTurnIds.filter((id) => kept.has(id)),
		nextId,
	};
}

function readStateFile(path: string): VetState | null {
	try {
		if (!existsSync(path)) return null;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const list = Array.isArray(raw) ? raw : raw?.changes;
		if (!Array.isArray(list)) return null;
		const ids = Array.isArray(raw?.lastTurnIds) ? raw.lastTurnIds : [];
		return {
			changes: list.map(normalizeChange),
			lastTurnIds: ids.filter((id: unknown) => typeof id === "string"),
		};
	} catch {
		return null;
	}
}

function normalizeChange(c: unknown): Change {
	const record = (c ?? {}) as Change & { accepted?: boolean };
	if (record.checked === undefined) {
		record.checked = record.accepted !== false;
	}
	return record;
}

function isReachable(c: Change, sessionId: string): boolean {
	const stale = c.status !== "pending" && c.status !== "partial";
	if (stale) return true;
	if (sessionId && c.sessionId && c.sessionId !== sessionId) return false;
	return existsSync(c.filePath) || c.existed;
}


