import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { diskView, driftedFiles, keeps, materialize } from "../feature/replay";
import type { Step, VetData } from "../types";
import { countStats, kindLabel, renderDiffOverlay } from "./shared";

type Action = "apply" | "cancel" | "diff";

const sortSteps = (steps: Step[]): Step[] =>
	[...steps].sort((a, b) => a.relPath.localeCompare(b.relPath) || a.seq - b.seq);

function fileTotals(steps: Step[], filePath: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const step of steps) {
		if (step.filePath !== filePath || !keeps(step)) continue;
		const stats = countStats(step.hunks);
		added += stats.added;
		removed += stats.removed;
	}
	return { added, removed };
}

function pickAction(
	ctx: ExtensionContext,
	title: string,
	sorted: Step[],
	cursor: { index: number; top: number },
): Promise<Action> {
	return ctx.ui.custom<Action>((tui, theme: Theme, _kb, done) => {
		const stepLine = (step: Step, selected: boolean): string => {
			const pointer = selected ? theme.fg("accent", "›") : " ";
			const box = step.origin === "external" ? theme.fg("dim", "[=]") : step.checked ? theme.fg("success", "[x]") : "[ ]";
			const stats = countStats(step.hunks);
			const origin = step.origin === "external" ? theme.fg("dim", " manual edit") : "";
			return `${pointer} ${box} #${step.seq} ${step.toolName} ${kindLabel(step.effect, theme)} ${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${origin}`;
		};

		return {
			render(width: number): string[] {
				const rows: string[] = [];
				const rowOfStep: number[] = [];
				const headerAbove: boolean[] = [];
				let lastFile = "";
				sorted.forEach((step, i) => {
					headerAbove[i] = step.filePath !== lastFile;
					if (headerAbove[i]) {
						lastFile = step.filePath;
						const totals = fileTotals(sorted, step.filePath);
						rows.push(
							`${theme.bold(step.relPath)} ${theme.fg("success", `+${totals.added}`)} ${theme.fg("error", `-${totals.removed}`)}`,
						);
					}
					rowOfStep[i] = rows.length;
					rows.push(stepLine(step, i === cursor.index));
				});

				const height = Math.max(5, (process.stdout.rows ?? 30) - 6);
				const cursorRow = rowOfStep[cursor.index] - (headerAbove[cursor.index] ? 1 : 0);
				if (cursorRow < cursor.top) cursor.top = cursorRow;
				if (rowOfStep[cursor.index] >= cursor.top + height)
					cursor.top = rowOfStep[cursor.index] - height + 1;

				const lines = [theme.fg("accent", theme.bold(` ${title}`)), ""];
				lines.push(...rows.slice(cursor.top, cursor.top + height));
				lines.push("");
				lines.push(
					theme.fg("dim", " ↑↓ move  ␣ toggle  enter diff  a all  n none  y apply  esc cancel"),
				);
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
			handleInput(data: string): void {
				const step = sorted[cursor.index];
				if (matchesKey(data, "up") || data === "k") cursor.index = Math.max(0, cursor.index - 1);
				else if (matchesKey(data, "down") || data === "j")
					cursor.index = Math.min(sorted.length - 1, cursor.index + 1);
				else if (data === " ") {
					if (step.origin !== "external") step.checked = !step.checked;
				} else if (data === "a" || data === "n") {
					for (const s of sorted) if (s.origin !== "external") s.checked = data === "a";
				} else if (matchesKey(data, "enter")) {
					done("diff");
					return;
				} else if (data === "y") {
					done("apply");
					return;
				} else if (matchesKey(data, "escape")) {
					done("cancel");
					return;
				}
				tui.requestRender();
			},
		};
	});
}

async function applyChoices(
	ctx: ExtensionContext,
	data: VetData,
	steps: Step[],
	save: () => void,
): Promise<void> {
	const files = new Set(steps.map((s) => s.filePath));
	const drifted = driftedFiles(data, diskView, files);
	if (drifted.length > 0) {
		const proceed = await ctx.ui.confirm(
			"Files changed outside pi-vet",
			`Applying overwrites manual edits in:\n${drifted.join("\n")}\n\nContinue?`,
		);
		if (!proceed) return;
	}

	const previous = new Map(steps.map((s) => [s, s.status]));
	for (const step of steps) step.status = keeps(step) ? "accepted" : "reverted";

	const { failed, errors } = materialize(data, diskView, files);
	for (const step of steps) if (failed.has(step.filePath)) step.status = previous.get(step) ?? "pending";
	save();
	if (errors.length > 0) ctx.ui.notify(`pi-vet failed to apply:\n${errors.join("\n")}`, "error");
}

export async function showReview(
	ctx: ExtensionContext,
	data: VetData,
	steps: Step[],
	title: string,
	save: () => void,
): Promise<void> {
	if (steps.length === 0) return;
	for (const step of steps) if (step.status !== "pending") step.checked = step.status !== "reverted";
	const sorted = sortSteps(steps);
	const cursor = { index: 0, top: 0 };

	while (true) {
		const action = await pickAction(ctx, title, sorted, cursor);
		if (action === "cancel") {
			save();
			return;
		}
		if (action === "apply") {
			await applyChoices(ctx, data, sorted, save);
			return;
		}
		const step = sorted[cursor.index];
		await renderDiffOverlay(ctx, step.hunks, `${step.relPath} #${step.seq}`, save);
	}
}

