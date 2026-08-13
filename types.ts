// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
