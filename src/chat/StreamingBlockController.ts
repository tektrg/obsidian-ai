import { IncrementalDomRenderer } from "incremark-renderer";
import type { BridgeStreamEvent } from "./types";
import { ActivityGroup } from "./ActivityGroup";

export interface StreamEventCallbacks {
	onToolFinished(toolName: string, detail: string | undefined, ok: boolean): void;
	appendStatusMessage(text: string): void;
}

export interface StreamFinishCallbacks {
	onBubbleReady(bubbleEl: HTMLElement): void;
}

/** Turn a raw tool name (`read_file`, `str-replace`) into a readable row label. */
function toolLabel(toolName: string): string {
	if (!toolName) return "Tool";
	const words = toolName.replace(/[_-]+/g, " ").trim().split(/\s+/);
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export class StreamingBlockController {
	private threadEl: HTMLElement;

	private assistantBubbleEl: HTMLElement | null = null;
	private assistantTextEl: HTMLElement | null = null;

	private activityGroup: ActivityGroup | null = null;

	private assistantTextBuffer = "";
	private pendingAnimationFrame: number | null = null;
	private lastScrollTime = 0;

	private incrementalRenderer: IncrementalDomRenderer | null = null;

	constructor(threadEl: HTMLElement) {
		this.threadEl = threadEl;
	}

	begin(): void {
		this.activityGroup = new ActivityGroup(this.threadEl, this.assistantBubbleEl, true);

		const bubble = this.threadEl.createDiv({ cls: "claude-chat-bubble claude-chat-bubble--assistant" });
		bubble.createEl("div", { text: "Claude", cls: "claude-chat-bubble-label" });
		this.assistantBubbleEl = bubble;

		const markdownContainer = bubble.createDiv({ cls: "claude-chat-bubble-markdown" });
		this.incrementalRenderer = new IncrementalDomRenderer(markdownContainer, {
			highlight: { showLineNumbers: true },
			math: { katex: { throwOnError: false } },
		});

		this.assistantTextEl = bubble.createDiv({ cls: "claude-chat-bubble-text" });
		this.assistantTextEl.style.display = "none";

		this.scrollToBottom();
	}

	finish(finalText: string, callbacks: StreamFinishCallbacks): void {
		if (this.pendingAnimationFrame) {
			cancelAnimationFrame(this.pendingAnimationFrame);
			this.pendingAnimationFrame = null;
		}

		this.assistantTextBuffer = finalText;
		const bubbleEl = this.assistantBubbleEl;

		if (this.incrementalRenderer) {
			this.incrementalRenderer.finalize();
		}

		if (this.assistantTextEl) {
			this.assistantTextEl.remove();
			this.assistantTextEl = null;
		}

		this.activityGroup?.endStreaming();

		this.scrollToBottom();
		this.end();

		if (bubbleEl) {
			callbacks.onBubbleReady(bubbleEl);
		}
	}

	end(): void {
		this.assistantBubbleEl = null;
		this.assistantTextEl = null;
		this.incrementalRenderer = null;
		// The finished group stays in the thread as conversation history; we only
		// drop our reference so the next response starts a fresh one.
		this.activityGroup = null;
		this.assistantTextBuffer = "";
		if (this.pendingAnimationFrame) {
			cancelAnimationFrame(this.pendingAnimationFrame);
			this.pendingAnimationFrame = null;
		}
	}

	handleEvent(event: BridgeStreamEvent, callbacks: StreamEventCallbacks): void {
		switch (event.type) {
			case "assistant_delta": {
				if (!this.assistantBubbleEl) this.begin();
				this.assistantTextBuffer += event.text;
				this.incrementalRenderer?.append(event.text);
				this.throttledScroll();
				return;
			}
			case "thinking_delta": {
				if (!this.assistantBubbleEl) this.begin();
				this.activityGroup?.appendReasoning(event.text);
				this.throttledScroll();
				return;
			}
			case "tool_started": {
				if (!this.assistantBubbleEl) this.begin();
				// Fall back to the tool name as the correlation key when no stepId is
				// provided, so the matching tool_finished resolves the same row.
				this.activityGroup?.startTool(
					event.stepId ?? event.toolName,
					event.toolName,
					event.displayName ?? toolLabel(event.toolName),
					event.detail
				);
				this.scrollToBottom();
				return;
			}
			case "tool_finished": {
				this.activityGroup?.finishTool(
					event.stepId ?? event.toolName,
					event.ok !== false
				);
				callbacks.onToolFinished(event.toolName, event.detail, event.ok !== false);
				this.scrollToBottom();
				return;
			}
			case "status": {
				callbacks.appendStatusMessage(event.text);
				return;
			}
		}
	}

	clearAll(): void {
		if (this.incrementalRenderer) {
			this.incrementalRenderer.finalize();
			this.incrementalRenderer = null;
		}
		this.activityGroup?.endStreaming();
		this.end();
	}

	scrollToBottom(): void {
		this.threadEl.scrollTop = this.threadEl.scrollHeight;
	}

	private throttledScroll(): void {
		const now = Date.now();
		if (now - this.lastScrollTime > 100) {
			this.lastScrollTime = now;
			this.scrollToBottom();
		}
	}
}
