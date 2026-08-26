/**
 * pi-vet — TUI terminal file change review: accept, revert, undo.
 *
 * Tracks file changes made by the agent (edit/write/bash), then after each
 * agent turn shows a review UI: file list with +N/-N stats, checkboxes,
 * diff preview on enter, esc to apply.
 *
 * Model: agent applies directly (like Zed), review happens after.
 * Revert = recompute file from original + only accepted hunks.
 * State persists to .pi/pi-vet/state.json across restarts.
 *
 * /vet when no pending changes → shows most recent batch with Undo option.
 * /vet off → disable tracking. /vet on → re-enable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadState, loadEnabled, saveEnabled } from "./config/store";
import { createTracker } from "./feature/tracker";
import { showReview } from "./renderer/review-list";
import { showHistory } from "./renderer/history-list";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const { changes, nextId: startId } = loadState(cwd);
	const nextId = { val: startId };
	const reviewActive = { val: false };
	let enabled = loadEnabled(cwd);

	const tracker = createTracker(cwd, changes, nextId);

	// ---- tool tracking ----
	pi.on("tool_call", async (event) => {
		if (!enabled) return;
		tracker.onToolCall(event);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		tracker.onToolResult(event, ctx.sessionManager.getSessionId());
	});

	pi.on("agent_end", async (_event, ctx) => {
		const turnIds = tracker.takeTurnIds();
		tracker.clear();
		if (!enabled || !ctx.hasUI) return;
		await showReview(
			ctx,
			changes,
			cwd,
			reviewActive,
			tracker.writeChangeToDisk,
			turnIds,
			ctx.sessionManager.getSessionId(),
		);
	});

	pi.registerCommand("vet", {
		description:
			"Review pending agent changes (or undo last batch). /vet off to disable.",
		handler: async (args, ctx) => {
			const sub: string = Array.isArray(args)
				? (args[0] ?? "")
				: typeof args === "string"
					? args
					: "";
			if (sub === "off") {
				enabled = false;
				saveEnabled(false, cwd);
				ctx.ui.notify("pi-vet tracking disabled", "info");
				return;
			}
			if (sub === "on") {
				enabled = true;
				saveEnabled(true, cwd);
				ctx.ui.notify("pi-vet tracking enabled", "info");
				return;
			}

			const pending = changes.filter(
				(c) => c.status === "pending" || c.status === "partial",
			);
			if (pending.length > 0) {
				await showReview(
					ctx,
					changes,
					cwd,
					reviewActive,
					tracker.writeChangeToDisk,
				);
			} else {
				const history = changes.filter(
					(c) => c.status === "accepted" || c.status === "reverted",
				);
				if (history.length === 0) {
					ctx.ui.notify("No changes to review", "info");
					return;
				}
				const latestBatch = Math.max(...history.map((c) => c.batchId));
				const batch = history.filter((c) => c.batchId === latestBatch);
				await showHistory(ctx, changes, batch, cwd, tracker.writeChangeToDisk);
			}
		},
	});
}


