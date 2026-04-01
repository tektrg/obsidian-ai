import { App, ItemView, MarkdownRenderer, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsidianAiPlugin from "../main";
import type { AuthSession } from "../auth/types";
import type { ContextScope } from "../editor/ActiveFileContext";
import type { BridgeStreamEvent } from "./ClaudeSdkBridge";

export const CLAUDE_CHAT_VIEW_TYPE = "claude-chat-view";

class ConfirmReplaceModal extends Modal {
	private readonly onConfirm: () => void;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Replace whole note?" });
		contentEl.createEl("p", { text: "This will replace all content in the active note with the latest assistant response." });

		const actions = contentEl.createDiv({ cls: "claude-chat-confirm-actions" });
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = actions.createEl("button", { text: "Replace note" });
		confirmBtn.addClass("mod-warning");
		confirmBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}
}

export class ClaudeChatView extends ItemView {
	private plugin: ObsidianAiPlugin;
	private statusEl: HTMLElement | null = null;
	private threadEl: HTMLElement | null = null;
	private promptInputEl: HTMLTextAreaElement | null = null;
	private includeContextToggleEl: HTMLInputElement | null = null;
	private scopeEl: HTMLSelectElement | null = null;
	private contextChipEl: HTMLElement | null = null;
	private helperLineEl: HTMLElement | null = null;

	private sendBtn: HTMLButtonElement | null = null;
	private streamingAssistantBubbleEl: HTMLElement | null = null;
	private streamingAssistantTextEl: HTMLElement | null = null;
	private streamingThinkingTextEl: HTMLElement | null = null;
	private thinkingDetailsEl: HTMLDetailsElement | null = null;
	private streamingToolContainerEl: HTMLElement | null = null;
	private toolStepEls = new Map<string, HTMLElement>();
	private isSending = false;
	private lastAssistantText = "";

	// Streaming buffers - accumulate in memory, not DOM (prevents layout thrashing)
	private assistantTextBuffer = "";
	private thinkingTextBuffer = "";
	private pendingAnimationFrame: number | null = null;
	private lastScrollTime = 0;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianAiPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CLAUDE_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Claude chat";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	refreshActiveContext(): void {
		this.renderContextChip();
		this.updateEditButtons();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("claude-chat-view");

		const shellEl = contentEl.createDiv({ cls: "claude-chat-shell" });

		const headerEl = shellEl.createDiv({ cls: "claude-chat-header" });
		const titleWrap = headerEl.createDiv({ cls: "claude-chat-header-title-wrap" });
		titleWrap.createEl("h3", { text: "Claude chat", cls: "claude-chat-title" });
		this.statusEl = titleWrap.createEl("div", { cls: "claude-chat-status" });
		this.renderStatus(this.plugin.getChatAuthSession());

		const headerActionsEl = headerEl.createDiv({ cls: "claude-chat-header-actions" });
		const loginBtn = headerActionsEl.createEl("button", { cls: "clickable-icon claude-chat-icon-btn", attr: { "aria-label": "Sign in" } });
		setIcon(loginBtn, "log-in");
		loginBtn.addEventListener("click", async () => {
			try {
				const session = await this.plugin.startChatLogin();
				this.renderStatus(session);
				this.appendSystemMessage(`Auth result: ${this.describeSession(session)}`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendSystemMessage(`Sign in failed: ${msg}`, "error");
			}
		});

		const testBtn = headerActionsEl.createEl("button", { cls: "clickable-icon claude-chat-icon-btn", attr: { "aria-label": "Test Connection" } });
		setIcon(testBtn, "activity");
		testBtn.addEventListener("click", async () => {
			try {
				await this.plugin.testChatConnection();
				this.appendSystemMessage("Connection test succeeded.", "success");
				this.renderStatus(this.plugin.getChatAuthSession());
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendSystemMessage(`Connection test failed: ${msg}`, "error");
			}
		});

		const signOutBtn = headerActionsEl.createEl("button", { cls: "clickable-icon claude-chat-icon-btn", attr: { "aria-label": "Sign out" } });
		setIcon(signOutBtn, "log-out");
		signOutBtn.addEventListener("click", async () => {
			const session = await this.plugin.signOutChat();
			this.renderStatus(session);
			this.appendSystemMessage("Signed out.");
		});

		this.threadEl = shellEl.createDiv({ cls: "claude-chat-thread" });
		this.appendSystemMessage("Ready. Ask Claude about your active note.");

		const composerEl = shellEl.createDiv({ cls: "claude-chat-composer" });
		const pillRow = composerEl.createDiv({ cls: "claude-chat-pill-row" });

		const contextToggleWrap = pillRow.createDiv({ cls: "claude-chat-context-toggle-wrap" });
		const includeLabel = contextToggleWrap.createEl("label", { cls: "claude-chat-toggle-label" });
		this.includeContextToggleEl = includeLabel.createEl("input", { type: "checkbox" });
		this.includeContextToggleEl.checked = this.plugin.isActiveContextEnabledByDefault();
		includeLabel.appendText(" Context");
		this.includeContextToggleEl.addEventListener("change", () => this.renderContextChip());

		this.scopeEl = contextToggleWrap.createEl("select", { cls: "claude-chat-scope-select" });
		this.scopeEl.createEl("option", { text: "Selection", value: "selection" });
		this.scopeEl.createEl("option", { text: "Whole note", value: "note" });
		this.scopeEl.value = this.plugin.getDefaultContextScope();
		this.scopeEl.addEventListener("change", () => this.renderContextChip());

		this.contextChipEl = pillRow.createDiv({ cls: "claude-chat-chip-container" });
		this.helperLineEl = composerEl.createDiv({ cls: "claude-chat-helper-line" });
		this.renderContextChip();

		const promptContainer = composerEl.createDiv({ cls: "claude-chat-prompt-container" });
		this.promptInputEl = promptContainer.createEl("textarea", { cls: "claude-chat-prompt" });
		this.promptInputEl.placeholder = "Ask Claude to improve, summarize, or edit your current note...";
		this.promptInputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				void this.handleSend();
			}
		});

		this.sendBtn = promptContainer.createEl("button", { cls: "claude-chat-send-btn clickable-icon", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "send");
		this.sendBtn.addEventListener("click", () => void this.handleSend());

		this.updateEditButtons();
	}

	private async handleSend(): Promise<void> {
		if (!this.promptInputEl || this.isSending) return;
		const prompt = this.promptInputEl.value.trim();
		if (!prompt) {
			new Notice("Enter a prompt first.");
			return;
		}

		this.appendUserMessage(prompt);
		this.promptInputEl.value = "";
		this.setSendingState(true);
		this.beginStreamingAssistantBlocks();

		try {
			const response = await this.plugin.sendChatPromptStream(prompt, {
				includeActiveContext: this.includeContextToggleEl?.checked ?? false,
				scope: this.getSelectedScope(),
			}, {
				onEvent: (event) => this.handleStreamEvent(event),
			});
			this.lastAssistantText = response.text;
			this.finishStreamingAssistantText(response.text);
			this.updateEditButtons();
			this.renderContextChip();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendSystemMessage(`Claude error: ${msg}`, "error");
			this.endStreamingBlocks();
		} finally {
			this.setSendingState(false);
		}
	}

	private handleStreamEvent(event: BridgeStreamEvent): void {
		if (!this.threadEl) return;

		switch (event.type) {
			case "assistant_delta": {
				if (!this.streamingAssistantTextEl) {
					this.beginStreamingAssistantBlocks();
				}
				// Accumulate in memory buffer, NOT DOM (prevents layout thrashing)
				this.assistantTextBuffer += event.text;
				this.scheduleUpdate();
				return;
			}
			case "thinking_delta": {
				if (!this.streamingThinkingTextEl || !this.thinkingDetailsEl) {
					this.createThinkingBlock();
				}
				// Accumulate in memory buffer, NOT DOM
				this.thinkingTextBuffer += event.text;
				this.scheduleUpdate();
				return;
			}
			case "tool_started": {
				this.appendOrUpdateToolStep(
					event.stepId ?? `${event.toolName}-${Date.now()}`,
					event.toolName,
					"running",
					event.detail
				);
				return;
			}
			case "tool_finished": {
				this.appendOrUpdateToolStep(
					event.stepId ?? `${event.toolName}-${Date.now()}`,
					event.toolName,
					event.ok === false ? "error" : "done",
					event.detail
				);
				return;
			}
			case "status": {
				if (event.text.trim()) {
					this.appendSystemMessage(event.text);
				}
				return;
			}
		}
	}

	/**
	 * Schedule a batched DOM update using requestAnimationFrame.
	 * This prevents layout thrashing by batching multiple tokens into a single render.
	 */
	private scheduleUpdate(): void {
		if (this.pendingAnimationFrame) return; // Already scheduled

		this.pendingAnimationFrame = window.requestAnimationFrame(() => {
			this.pendingAnimationFrame = null;

			// Flush assistant text buffer to DOM
			if (this.streamingAssistantTextEl && this.assistantTextBuffer) {
				this.streamingAssistantTextEl.setText(this.assistantTextBuffer);
			}

			// Flush thinking text buffer to DOM
			if (this.streamingThinkingTextEl && this.thinkingTextBuffer) {
				this.streamingThinkingTextEl.setText(this.thinkingTextBuffer);
			}

			this.throttledScroll();
		});
	}

	/**
	 * Throttle scrolling to prevent janky behavior during rapid updates.
	 * Only scroll every 100ms max.
	 */
	private throttledScroll(): void {
		const now = Date.now();
		if (now - this.lastScrollTime > 100) {
			this.lastScrollTime = now;
			this.scrollThreadToBottom();
		}
	}

	private beginStreamingAssistantBlocks(): void {
		if (!this.threadEl) return;
		const assistantBubble = this.threadEl.createDiv({ cls: "claude-chat-bubble claude-chat-bubble--assistant" });
		assistantBubble.createEl("div", { text: "Claude", cls: "claude-chat-bubble-label" });
		this.streamingAssistantBubbleEl = assistantBubble;
		this.streamingAssistantTextEl = assistantBubble.createDiv({ cls: "claude-chat-bubble-text" });

		this.streamingToolContainerEl = this.threadEl.createDiv({ cls: "claude-chat-steps" });
		this.toolStepEls.clear();
		this.scrollThreadToBottom();
	}

	private finishStreamingAssistantText(finalText: string): void {
		// Cancel any pending frame and flush immediately
		if (this.pendingAnimationFrame) {
			cancelAnimationFrame(this.pendingAnimationFrame);
			this.pendingAnimationFrame = null;
		}

		// Update buffer
		this.assistantTextBuffer = finalText;

		const bubbleEl = this.streamingAssistantBubbleEl; // Capture before ending blocks

		// Render final markdown content
		void this.renderMarkdownContent(finalText).then(() => {
			if (bubbleEl && finalText.trim().length > 0) {
				this.appendActionBar(bubbleEl, finalText);
			}
		});

		// Also flush thinking buffer if any
		if (this.streamingThinkingTextEl && this.thinkingTextBuffer) {
			this.streamingThinkingTextEl.setText(this.thinkingTextBuffer);
		}

		this.scrollThreadToBottom();
		this.endStreamingBlocks();
	}

	private appendActionBar(container: HTMLElement, text: string): void {
		const actionBar = container.createDiv({ cls: "claude-chat-action-bar" });

		const replaceSelBtn = actionBar.createEl("button", { text: "Replace selection", cls: "claude-chat-action-btn" });
		setIcon(replaceSelBtn, "replace");
		replaceSelBtn.addEventListener("click", () => this.handleActionReplaceSelection(text));

		const appendBtn = actionBar.createEl("button", { text: "Append", cls: "claude-chat-action-btn" });
		setIcon(appendBtn, "plus-square");
		appendBtn.addEventListener("click", () => this.handleActionAppendToNote(text));

		const replaceNoteBtn = actionBar.createEl("button", { text: "Replace note", cls: "claude-chat-action-btn mod-warning" });
		setIcon(replaceNoteBtn, "file-warning");
		replaceNoteBtn.addEventListener("click", () => this.handleActionReplaceWholeNote(text));
	}

	/**
	 * Render markdown content to the assistant bubble.
	 * Replaces the plain text element with rendered markdown.
	 */
	private async renderMarkdownContent(markdown: string): Promise<void> {
		if (!this.streamingAssistantBubbleEl) return;

		// Remove the plain text element
		if (this.streamingAssistantTextEl) {
			this.streamingAssistantTextEl.remove();
			this.streamingAssistantTextEl = null;
		}

		// Create a container for the rendered markdown
		const markdownContainer = this.streamingAssistantBubbleEl.createDiv({ cls: "claude-chat-bubble-markdown" });

		// Get the active file path for context (or use empty string)
		const activeFile = this.app.workspace.getActiveFile();
		const sourcePath = activeFile?.path ?? "";

		// Render markdown using Obsidian's renderer
		try {
			await MarkdownRenderer.render(
				this.app,
				markdown,
				markdownContainer,
				sourcePath,
				this
			);
		} catch (error) {
			// Fallback to plain text if rendering fails
			markdownContainer.setText(markdown);
		}

		this.scrollThreadToBottom();
	}

	private endStreamingBlocks(): void {
		this.streamingAssistantBubbleEl = null;
		this.streamingAssistantTextEl = null;
		this.streamingThinkingTextEl = null;
		this.thinkingDetailsEl = null;
		this.streamingToolContainerEl = null;
		this.toolStepEls.clear();

		// Clear buffers and pending frame
		this.assistantTextBuffer = "";
		this.thinkingTextBuffer = "";
		if (this.pendingAnimationFrame) {
			cancelAnimationFrame(this.pendingAnimationFrame);
			this.pendingAnimationFrame = null;
		}
	}

	private createThinkingBlock(): void {
		if (!this.threadEl) return;
		const wrap = this.threadEl.createDiv({ cls: "claude-chat-step claude-chat-step--thinking" });
		const details = wrap.createEl("details") as HTMLDetailsElement;
		details.addClass("claude-chat-thinking-details");
		const summary = details.createEl("summary", { text: "Thinking" });
		summary.addClass("claude-chat-thinking-summary");
		this.streamingThinkingTextEl = details.createDiv({ cls: "claude-chat-step-detail" });
		this.thinkingDetailsEl = details;
	}

	private appendOrUpdateToolStep(
		stepId: string,
		toolName: string,
		status: "running" | "done" | "error",
		detail?: string
	): void {
		const container = this.streamingToolContainerEl ?? this.threadEl;
		if (!container) return;

		let el = this.toolStepEls.get(stepId);
		if (!el) {
			el = container.createDiv({ cls: "claude-chat-step claude-chat-step--tool" });
			this.toolStepEls.set(stepId, el);
		}

		el.empty();
		const titleRow = el.createDiv({ cls: "claude-chat-step-title" });
		titleRow.createSpan({ text: toolName || "Tool" });
		titleRow.createSpan({ text: status === "running" ? "Running" : status === "done" ? "Done" : "Error", cls: `claude-chat-step-badge claude-chat-step-badge--${status}` });
		if (detail?.trim()) {
			el.createDiv({ text: detail, cls: "claude-chat-step-detail" });
		}
		this.scrollThreadToBottom();
	}

	private appendUserMessage(text: string): void {
		if (!this.threadEl) return;
		const bubble = this.threadEl.createDiv({ cls: "claude-chat-bubble claude-chat-bubble--user" });
		bubble.createEl("div", { text: "You", cls: "claude-chat-bubble-label" });
		bubble.createDiv({ text, cls: "claude-chat-bubble-text" });
		this.scrollThreadToBottom();
	}

	private appendSystemMessage(text: string, tone: "muted" | "error" | "success" = "muted"): void {
		if (!this.threadEl) return;
		const item = this.threadEl.createDiv({ cls: `claude-chat-system claude-chat-system--${tone}` });
		item.setText(text);
		this.scrollThreadToBottom();
	}

	private scrollThreadToBottom(): void {
		if (!this.threadEl) return;
		this.threadEl.scrollTop = this.threadEl.scrollHeight;
	}

	private renderContextChip(): void {
		if (!this.contextChipEl || !this.helperLineEl) return;
		const includeContext = this.includeContextToggleEl?.checked ?? false;
		const scope = this.getSelectedScope();
		const context = this.plugin.getActiveContext(scope);

		this.contextChipEl.empty();

		if (!includeContext) {
			this.helperLineEl.setText("Context disabled. Claude will only use your typed prompt.");
			this.updateEditButtons();
			return;
		}

		if (!context) {
			const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip claude-chat-chip--warning" });
			chip.setText("No active markdown note");
			this.helperLineEl.setText("Open a markdown note to attach context.");
			this.updateEditButtons();
			return;
		}

		const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip" });
		chip.createSpan({ text: "Current note" });
		chip.createSpan({ text: `· ${context.fileName}` });
		chip.createSpan({ text: `· ${context.scopeUsed === "selection" ? "Selection" : "Whole note"}` });
		const removeBtn = chip.createEl("button", { text: "×", cls: "claude-chat-chip-remove" });
		removeBtn.addEventListener("click", () => {
			if (this.includeContextToggleEl) {
				this.includeContextToggleEl.checked = false;
			}
			this.renderContextChip();
		});

		const truncationLabel = context.wasTruncated ? "truncated" : "full";
		this.helperLineEl.setText(`Attached ${context.content.length} chars (${truncationLabel}) from ${context.filePath}`);
		this.updateEditButtons();
	}

	private handleActionReplaceSelection(text: string): void {
		try {
			const result = this.plugin.replaceSelectionWithAssistantText(text);
			new Notice("Selection replaced from chat response.");
			this.appendSystemMessage(`Applied edit: replaced selection in ${result.filePath}`, "success");
			this.renderContextChip();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendSystemMessage(`Edit failed: ${msg}`, "error");
		}
	}

	private handleActionAppendToNote(text: string): void {
		try {
			const result = this.plugin.appendAssistantTextToActiveNote(text);
			new Notice("Assistant response appended to active note.");
			this.appendSystemMessage(`Applied edit: appended to ${result.filePath}`, "success");
			this.renderContextChip();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendSystemMessage(`Edit failed: ${msg}`, "error");
		}
	}

	private handleActionReplaceWholeNote(text: string): void {
		const applyChange = () => {
			try {
				const result = this.plugin.replaceWholeActiveNote(text);
				new Notice("Whole note replaced from chat response.");
				this.appendSystemMessage(`Applied edit: replaced whole note ${result.filePath}`, "success");
				this.renderContextChip();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendSystemMessage(`Edit failed: ${msg}`, "error");
			}
		};

		if (this.plugin.shouldConfirmWholeNoteReplace()) {
			new ConfirmReplaceModal(this.app, applyChange).open();
			return;
		}
		applyChange();
	}

	private updateEditButtons(): void {
		// Buttons are now dynamically rendered per message in appendActionBar
	}

	private setSendingState(isSending: boolean): void {
		this.isSending = isSending;
		if (this.sendBtn) {
			this.sendBtn.disabled = isSending;
			this.sendBtn.empty();
			setIcon(this.sendBtn, isSending ? "hourglass" : "send");
		}
		if (this.promptInputEl) {
			this.promptInputEl.disabled = isSending;
		}
	}

	private getSelectedScope(): ContextScope {
		if (this.scopeEl?.value === "note") {
			return "note";
		}
		return "selection";
	}

	private renderStatus(session: AuthSession): void {
		if (!this.statusEl) return;
		this.statusEl.empty();
		this.statusEl.setText(this.describeSession(session));
	}

	private describeSession(session: AuthSession): string {
		if (session.status === "signed-in") {
			return `Signed in (${session.accountLabel ?? session.mode}).`;
		}
		if (session.status === "unsupported") {
			return "Selected auth mode is unsupported.";
		}
		if (session.status === "pending") {
			return "Auth pending. Paste callback URL/code in settings, then click Sign in again.";
		}
		return "Signed out.";
	}
}
