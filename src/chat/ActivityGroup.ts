import { setIcon } from "obsidian";
import { IncrementalDomRenderer } from "incremark-renderer";

/** Status of a single tool step within the activity group. */
type ToolStatus = "running" | "done" | "error";

/** Max number of distinct tool labels surfaced in the collapsed summary line. */
const SUMMARY_ACTION_LIMIT = 3;
/** Max characters of the live preview / tool detail shown on a single row. */
const PREVIEW_MAX_CHARS = 80;

/** Lucide icon chosen for a tool row, by coarse intent inferred from its name. */
function toolIcon(toolName: string): string {
	const name = toolName.toLowerCase();
	if (/(write|edit|replace|append|apply|create|insert)/.test(name)) return "pencil";
	if (/(search|grep|glob|find|list)/.test(name)) return "search";
	if (/(run|exec|bash|shell|command|terminal)/.test(name)) return "terminal";
	if (/(read|get|fetch|open|view|cat)/.test(name)) return "file-text";
	return "wrench";
}

/** Collapse repeated whitespace and clip to a single short preview line. */
function toPreviewLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS - 1)}…` : flat;
}

/** A reasoning step: a collapsible row owning its own markdown renderer. */
interface ReasoningStep {
	readonly kind: "reasoning";
	readonly bodyEl: HTMLElement;
	readonly renderer: IncrementalDomRenderer;
	text: string;
}

/** A tool step: a single row whose status icon updates in place. */
interface ToolStep {
	readonly kind: "tool";
	readonly statusEl: HTMLElement;
	readonly label: string;
	status: ToolStatus;
}

/**
 * A single assistant turn's activity, rendered as one compact collapsible group:
 * an ordered list of small rows (reasoning blocks and tool calls, interleaved)
 * under a one-line summary header. Replaces the old per-block full-width thinking
 * panels and the separate tool-steps container, which together took far too much
 * vertical space.
 *
 * While streaming the group is expanded and a live preview line tracks the active
 * step; on completion it collapses to the summary header (primary actions · step
 * count · duration) unless the user expanded it manually.
 */
export class ActivityGroup {
	readonly rootEl: HTMLElement;

	private readonly headerEl: HTMLElement;
	private readonly summaryEl: HTMLElement;
	private readonly chevronEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly liveEl: HTMLElement;

	private readonly startedAtMs: number;
	private streaming = true;
	private expanded = true;
	private userToggled = false;

	private stepCount = 0;
	private toolSeenSinceReasoning = false;
	private activeReasoning: ReasoningStep | null = null;
	private readonly toolSteps = new Map<string, ToolStep>();
	/** Distinct tool labels in first-seen order, for the summary line. */
	private readonly toolLabels: string[] = [];

	constructor(threadEl: HTMLElement, anchorEl: HTMLElement | null, isLoading: boolean) {
		this.startedAtMs = Date.now();

		const root = document.createElement("div");
		root.className = "claude-chat-activity";
		root.dataset.state = "streaming";
		root.dataset.expanded = "true";
		this.rootEl = root;

		const header = root.createDiv({
			cls: "claude-chat-activity-header",
			attr: { role: "button", tabindex: "0", "aria-label": "Toggle activity", "aria-expanded": "true" },
		});
		this.headerEl = header;

		const chevron = header.createDiv({ cls: "claude-chat-activity-chevron" });
		setIcon(chevron, "chevron-down");
		this.chevronEl = chevron;

		this.summaryEl = header.createDiv({ cls: "claude-chat-activity-summary" });
		header.createDiv({ cls: "claude-chat-activity-spinner" });

		this.bodyEl = root.createDiv({ cls: "claude-chat-activity-body" });
		this.liveEl = this.bodyEl.createDiv({ cls: "claude-chat-activity-live" });

		this.setSummary(isLoading ? "Analyzing your request" : "Thinking");
		this.setLivePreview(isLoading ? "Analyzing your request…" : "");

		header.addEventListener("click", () => this.toggle());
		header.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				this.toggle();
			}
		});

		if (anchorEl) {
			threadEl.insertBefore(root, anchorEl);
		} else {
			threadEl.appendChild(root);
		}
	}

	/** Whether this group has recorded any reasoning or tool step. */
	get hasContent(): boolean {
		return this.stepCount > 0;
	}

	/**
	 * Append a streamed reasoning delta. Reasoning that resumes after a tool call
	 * starts a fresh row, so the list reads as an interleaved timeline.
	 */
	appendReasoning(text: string): void {
		if (!this.activeReasoning || this.toolSeenSinceReasoning) {
			// Flush the prior reasoning block before starting a fresh one, so its
			// trailing markdown isn't left unrendered when reasoning is interleaved
			// with tool calls.
			this.activeReasoning?.renderer.finalize();
			this.activeReasoning = this.createReasoningStep();
			this.toolSeenSinceReasoning = false;
		}
		this.activeReasoning.text += text;
		this.activeReasoning.renderer.append(text);
		this.setLivePreview(toPreviewLine(this.activeReasoning.text.slice(-PREVIEW_MAX_CHARS * 2)));
		this.refreshStreamingSummary();
	}

	/** Begin (or re-render) a running tool step, keyed by its step id. */
	startTool(stepId: string, toolName: string, label: string, detail?: string): void {
		this.toolSeenSinceReasoning = true;
		if (!this.toolSteps.has(stepId)) {
			this.stepCount += 1;
			if (label && !this.toolLabels.includes(label)) this.toolLabels.push(label);
			this.toolSteps.set(stepId, this.createToolStep(toolName, label, detail));
		}
		this.setLivePreview(detail?.trim() ? toPreviewLine(detail) : label);
		this.refreshStreamingSummary();
	}

	/** Resolve a tool step to its terminal status. */
	finishTool(stepId: string, ok: boolean): void {
		const step = this.toolSteps.get(stepId);
		if (!step) return;
		step.status = ok ? "done" : "error";
		this.applyToolStatus(step);
		this.refreshStreamingSummary();
	}

	/**
	 * Mark the turn finished. Drops an empty group, finalizes reasoning markdown,
	 * removes the live preview, writes the final summary, and collapses unless the
	 * user expanded the group manually while it streamed.
	 */
	endStreaming(): void {
		if (!this.streaming) return;
		this.streaming = false;
		this.activeReasoning?.renderer.finalize();
		this.liveEl.remove();

		if (!this.hasContent) {
			this.rootEl.remove();
			return;
		}

		// Resolve any tool that never reported completion so no row is left
		// spinning forever (e.g. a finish event arrived without a matching id).
		for (const step of this.toolSteps.values()) {
			if (step.status === "running") {
				step.status = "done";
				this.applyToolStatus(step);
			}
		}

		this.rootEl.dataset.state = "done";
		this.setSummary(this.buildFinalSummary());
		if (!this.userToggled) this.setExpanded(false);
	}

	private createReasoningStep(): ReasoningStep {
		this.stepCount += 1;
		const row = this.bodyEl.createDiv({ cls: "claude-chat-activity-row claude-chat-activity-row--reasoning" });

		const head = row.createDiv({
			cls: "claude-chat-activity-row-head",
			attr: { role: "button", tabindex: "0", "aria-expanded": "false" },
		});
		const icon = head.createDiv({ cls: "claude-chat-activity-row-icon" });
		setIcon(icon, "brain");
		head.createSpan({ cls: "claude-chat-activity-row-label", text: "Reasoning" });
		const caret = head.createDiv({ cls: "claude-chat-activity-row-caret" });
		setIcon(caret, "chevron-down");

		const body = row.createDiv({ cls: "claude-chat-activity-row-body claude-chat-thinking-markdown" });
		const renderer = new IncrementalDomRenderer(body, {
			highlight: { showLineNumbers: true },
			math: { katex: { throwOnError: false } },
		});

		const toggleRow = (evt: Event) => {
			evt.stopPropagation();
			const next = row.dataset.expanded !== "true";
			row.dataset.expanded = next ? "true" : "false";
			head.setAttribute("aria-expanded", next ? "true" : "false");
		};
		head.addEventListener("click", toggleRow);
		head.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				toggleRow(evt);
			}
		});

		// New reasoning always lands above the live preview line.
		this.bodyEl.insertBefore(row, this.liveEl);
		return { kind: "reasoning", bodyEl: body, renderer, text: "" };
	}

	private createToolStep(toolName: string, label: string, detail?: string): ToolStep {
		const row = this.bodyEl.createDiv({ cls: "claude-chat-activity-row claude-chat-activity-row--tool" });

		const icon = row.createDiv({ cls: "claude-chat-activity-row-icon" });
		setIcon(icon, toolIcon(toolName));
		row.createSpan({ cls: "claude-chat-activity-row-label", text: label || toolName || "Tool" });
		if (detail?.trim()) {
			row.createSpan({ cls: "claude-chat-activity-row-detail", text: toPreviewLine(detail) });
		}
		const statusEl = row.createDiv({ cls: "claude-chat-activity-row-status" });

		this.bodyEl.insertBefore(row, this.liveEl);
		const step: ToolStep = { kind: "tool", statusEl, label: label || toolName, status: "running" };
		this.applyToolStatus(step);
		return step;
	}

	private applyToolStatus(step: ToolStep): void {
		const el = step.statusEl;
		el.empty();
		el.dataset.status = step.status;
		if (step.status === "running") {
			el.createDiv({ cls: "claude-chat-activity-spinner" });
		} else {
			setIcon(el, step.status === "done" ? "check" : "x");
		}
	}

	private toggle(): void {
		this.userToggled = true;
		this.setExpanded(!this.expanded);
	}

	private setExpanded(next: boolean): void {
		if (next === this.expanded) return;
		this.expanded = next;
		this.rootEl.dataset.expanded = next ? "true" : "false";
		this.headerEl.setAttribute("aria-expanded", next ? "true" : "false");
		// The chevron itself never changes glyph — CSS rotates it by data-expanded.
	}

	private setLivePreview(text: string): void {
		this.liveEl.setText(text);
		this.liveEl.toggleClass("is-empty", text.length === 0);
	}

	private setSummary(text: string): void {
		this.summaryEl.setText(text);
	}

	/** Live header text while streaming: the work so far at a glance. */
	private refreshStreamingSummary(): void {
		if (!this.streaming) return;
		const steps = this.stepCount === 1 ? "1 step" : `${this.stepCount} steps`;
		this.setSummary(this.toolLabels.length ? `Working… · ${steps}` : `Thinking… · ${steps}`);
	}

	/** Final header text: primary actions · step count · elapsed seconds. */
	private buildFinalSummary(): string {
		const parts: string[] = [];
		if (this.toolLabels.length) {
			const shown = this.toolLabels.slice(0, SUMMARY_ACTION_LIMIT).join(", ");
			const extra = this.toolLabels.length - SUMMARY_ACTION_LIMIT;
			parts.push(extra > 0 ? `${shown} +${extra}` : shown);
		} else {
			parts.push("Reasoning");
		}
		parts.push(this.stepCount === 1 ? "1 step" : `${this.stepCount} steps`);
		const elapsedSec = Math.max(1, Math.round((Date.now() - this.startedAtMs) / 1000));
		parts.push(`${elapsedSec}s`);
		return parts.join(" · ");
	}
}
