export interface Hunk {
	id: string;
	header: string;
	lines: string[];
	accepted: boolean;
}

export type StepEffect = "new" | "del" | "mod";

export interface Base {
	filePath: string;
	relPath: string;
	sessionId: string;
	content: string;
	existed: boolean;
}

export interface Step {
	id: string;
	seq: number;
	filePath: string;
	relPath: string;
	sessionId: string;
	toolName: string;
	origin: "agent" | "external";
	effect: StepEffect;
	status: "pending" | "accepted" | "reverted";
	hunks: Hunk[];
	checked: boolean;
	timestamp: number;
}

export interface VetData {
	bases: Base[];
	steps: Step[];
}

