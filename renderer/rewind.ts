import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diskView, driftedFiles, materialize, viewUpTo } from "../feature/replay";
import type { VetData } from "../types";

const ORIGINAL_LABEL = "#0 original state (before any agent step)";

function labelFor(data: VetData, seq: number): string {
	const group = data.steps.filter((s) => s.seq === seq);
	const files = group.map((s) => s.relPath);
	const shown = files.length > 3 ? `${files.slice(0, 3).join(", ")} +${files.length - 3}` : files.join(", ");
	return `#${seq} ${group[0].toolName} ${shown}`;
}

export async function showRewind(ctx: ExtensionContext, data: VetData, save: () => void): Promise<void> {
	const seqs = [...new Set(data.steps.map((s) => s.seq))].sort((a, b) => b - a);
	if (seqs.length === 0) {
		ctx.ui.notify("No steps to rewind", "info");
		return;
	}
	const labels = new Map(seqs.map((seq) => [labelFor(data, seq), seq]));
	labels.set(ORIGINAL_LABEL, 0);
	const picked = await ctx.ui.select("Rewind to after step", [...labels.keys()]);
	if (picked === undefined) return;
	const target = labels.get(picked) ?? 0;

	const files = new Set(data.bases.map((b) => b.filePath));
	const drifted = driftedFiles(data, diskView, files);
	if (drifted.length > 0) {
		const proceed = await ctx.ui.confirm(
			"Files changed outside pi-vet",
			`Rewind overwrites manual edits in:\n${drifted.join("\n")}\n\nContinue?`,
		);
		if (!proceed) return;
	}

	const { errors } = materialize(data, viewUpTo(target), files);
	if (errors.length > 0) {
		ctx.ui.notify(`pi-vet failed to rewind:\n${errors.join("\n")}`, "error");
		return;
	}
	data.steps = data.steps.filter((s) => s.seq <= target);
	data.bases = data.bases.filter((b) => data.steps.some((s) => s.filePath === b.filePath));
	save();
	ctx.ui.notify(`Rewound to ${picked}`, "info");
}
