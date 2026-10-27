import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { VetData } from "./types";
import { loadEnabled, loadSession, saveEnabled, saveSession } from "./config/store";
import { createTracker } from "./feature/tracker";
import { showReview } from "./renderer/review-list";
import { showRewind } from "./renderer/rewind";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	let enabled = loadEnabled(cwd);
	let sessionId = "";
	let data: VetData = { bases: [], steps: [] };
	let hydrated = false;
	let reviewActive = false;

	const save = () => saveSession(cwd, sessionId, data);
	const tracker = createTracker(cwd, () => data, save);

	function hydrate(ctx: { sessionManager: { getSessionId(): string } }): void {
		sessionId = ctx.sessionManager.getSessionId();
		if (hydrated) return;
		hydrated = true;
		data = loadSession(cwd, sessionId);
	}

	const pendingSteps = () => data.steps.filter((s) => s.status === "pending");
	const settledSteps = () => data.steps.filter((s) => s.status !== "pending");

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		hydrate(ctx);
		await tracker.onToolCall(event);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		hydrate(ctx);
		await tracker.onToolResult(event, sessionId);
	});

	pi.on("agent_end", async (_event, ctx) => {
		hydrate(ctx);
		tracker.clear();
		if (!tracker.takeTouched() || !enabled || !ctx.hasUI || reviewActive) return;
		reviewActive = true;
		showReview(ctx, data, pendingSteps(), "pi-vet: review agent changes", save)
			.catch((e: Error) => ctx.ui.notify(`pi-vet: ${e.message}`, "error"))
			.finally(() => {
				reviewActive = false;
			});
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit" || !sessionId) return;
		saveSession(cwd, sessionId, { bases: [], steps: [] });
	});

	pi.registerCommand("vet", {
		description: "Review pending agent changes, or history. /vet history | rewind | off | on.",
		handler: async (args, ctx) => {
			const sub = (Array.isArray(args) ? (args[0] ?? "") : typeof args === "string" ? args : "").trim();
			if (sub === "off" || sub === "on") {
				enabled = sub === "on";
				saveEnabled(enabled, cwd);
				ctx.ui.notify(`pi-vet tracking ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			hydrate(ctx);
			if (reviewActive) return;
			reviewActive = true;
			try {
				if (sub === "rewind") {
					await showRewind(ctx, data, save);
					return;
				}
				const steps = sub === "history" ? settledSteps() : pendingSteps();
				const fallback = sub === "history" ? [] : settledSteps();
				const shown = steps.length > 0 ? steps : fallback;
				if (shown.length === 0) {
					ctx.ui.notify("No changes to review", "info");
					return;
				}
				const title = shown === steps && sub !== "history" ? "pi-vet: review agent changes" : "pi-vet: history";
				await showReview(ctx, data, shown, title, save);
			} finally {
				reviewActive = false;
			}
		},
	});
}

