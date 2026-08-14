// ---------------------------------------------------------------------------
// Types
// pi-vet: file change review for Pi coding agent

// SMOKE-TEST: 2026-08-14
// pi-vet: file change review for Pi coding agent
/** Hunk represents one diff hunk with accept/reject state. */
export interface Hunk {
	id: string;
	header: string;
	lines: string[];
	accepted: boolean;
}

export interface Change {
	id: string;
	filePath: string;
	relPath: string;
	toolName: string;
	originalContent: string;
	existed: boolean;
	status: "pending" | "accepted" | "reverted" | "partial";
	hunks: Hunk[];
	checked: boolean;
	timestamp: number;
	batchId: number;
}


