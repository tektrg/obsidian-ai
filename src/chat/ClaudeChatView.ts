import { App, ItemView, MarkdownRenderer, Menu, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsidianAiPlugin from "../main";
import type { AuthSession } from "../auth/types";
import type { BridgeStreamEvent } from "./ClaudeSdkBridge";
import { DiffViewerModal } from "../components/DiffViewerModal";
import { generateInlineDiff, getDiffStats } from "../utils/DiffGenerator";

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
	private contextChipEl: HTMLElement | null = null;
	private settingsPanelEl: HTMLElement | null = null;
	private contextEnabled = true;

	private sendBtn: HTMLButtonElement | null = null;
	private streamingAssistantBubbleEl: HTMLElement | null = null;
	private streamingAssistantTextEl: HTMLElement | null = null;
	private streamingThinkingTextEl: HTMLElement | null = null;
	private thinkingPanelEl: HTMLElement | null = null;
	private thinkingExpandBtnEl: HTMLElement | null = null;
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
		const menuBtn = headerActionsEl.createEl("button", {
			cls: "clickable-icon claude-chat-icon-btn claude-chat-burger-btn",
			attr: { "aria-label": "Menu" }
		});
		setIcon(menuBtn, "menu");
		menuBtn.addEventListener("click", () => this.toggleSettingsPanel());

		// Internal Settings Panel (initially hidden)
		this.settingsPanelEl = shellEl.createDiv({ cls: "claude-chat-settings-panel" });
		this.settingsPanelEl.style.display = "none";
		this.renderSettingsPanel();

		this.threadEl = shellEl.createDiv({ cls: "claude-chat-thread" });
		this.appendSystemMessage("Ready. Ask Claude about your active note.");

		const composerEl = shellEl.createDiv({ cls: "claude-chat-composer" });
		const pillRow = composerEl.createDiv({ cls: "claude-chat-pill-row" });

		const contextInfoWrap = pillRow.createDiv({ cls: "claude-chat-context-info-wrap" });

		this.contextChipEl = contextInfoWrap.createDiv({ cls: "claude-chat-chip-container" });

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

		// Check auth before sending
		const authCheck = await this.plugin.validateAuth();
		if (!authCheck.valid) {
			this.appendSystemMessage(authCheck.message, "error");
			return;
		}

		// Clear undo state when sending a new message.
		// Turn snapshot capture is handled in plugin send flow to keep one source of truth.
		this.plugin.clearUndoState();

		this.appendUserMessage(prompt);
		this.promptInputEl.value = "";
		this.setSendingState(true);
		this.beginStreamingAssistantBlocks();

		try {
			const response = await this.plugin.sendChatPromptStream(prompt, {
				includeActiveContext: this.contextEnabled,
			}, {
				onEvent: (event) => this.handleStreamEvent(event),
			});
			this.lastAssistantText = response.text;
			this.finishStreamingAssistantText(response.text);
			this.updateEditButtons();
			this.renderContextChip();
		} catch (error) {
			this.handleAuthError(error);
			this.endStreamingBlocks();
		} finally {
			this.setSendingState(false);
		}
	}

	/**
	 * Handle errors with specific messages for auth failures.
	 * Provides actionable guidance to users.
	 */
	private handleAuthError(error: unknown): void {
		const msg = error instanceof Error ? error.message : String(error);

		// Authentication errors
		if (msg.includes("401") || msg.includes("authentication_error") || msg.includes("Invalid bearer token")) {
			new Notice("Authentication failed. Please sign in again.");
			this.appendSystemMessage(
				'Authentication failed. Your session has expired or been revoked. Click "Sign out" then "Sign in" to re-authenticate.',
				"error"
			);
			return;
		}

		if (msg.includes("refresh") || msg.includes("refresh_token")) {
			new Notice("Session expired. Please sign in again.");
			this.appendSystemMessage(
				'Session expired and could not be refreshed. Click "Sign out" then "Sign in" to re-authenticate.',
				"error"
			);
			return;
		}

		// Configuration errors
		if (msg.includes("No auth token available") || msg.includes("No Claude Max OAuth token")) {
			new Notice("Not authenticated. Please sign in first.");
			this.appendSystemMessage(
				'Not authenticated. Click "Sign in" to authenticate with Claude, or configure an API key in settings.',
				"error"
			);
			return;
		}

		// Network/timeout errors
		if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
			new Notice("Connection timed out. Please try again.");
			this.appendSystemMessage("Connection timed out. Please check your internet connection and try again.", "error");
			return;
		}

		// Rate limiting
		if (msg.includes("429") || msg.includes("rate limit") || msg.includes("Rate limit")) {
			new Notice("Rate limited. Please wait a moment.");
			this.appendSystemMessage("Rate limit hit. Please wait a moment before trying again.", "error");
			return;
		}

		// Generic error
		new Notice(msg);
		this.appendSystemMessage(`Claude error: ${msg}`, "error");
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
				if (!this.streamingThinkingTextEl) {
					this.createThinkingBlock();
				}
				// Clear loading placeholder on first thinking delta
				if (this.thinkingTextBuffer === "" && this.streamingThinkingTextEl) {
					this.streamingThinkingTextEl.empty();
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
				// Track if this was an edit tool
				if (this.isEditTool(event.toolName)) {
					this.plugin.turnHasEdits = true;
				}
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
				this.streamingThinkingTextEl.scrollTop = this.streamingThinkingTextEl.scrollHeight;
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

		// Create thinking block first (will show loading placeholder)
		this.createThinkingBlock(true);

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

		// Collapse the thinking panel when response is complete
		this.collapseThinkingPanel();

		this.endStreamingBlocks();
	}

	private appendActionBar(container: HTMLElement, text: string): void {
		// Clear any existing action bar first
		const existingBar = container.querySelector(".claude-chat-action-bar");
		if (existingBar) {
			existingBar.remove();
		}

		const actionBar = container.createDiv({ cls: "claude-chat-action-bar" });

		const replaceSelBtn = actionBar.createEl("button", { text: "Replace selection", cls: "claude-chat-action-btn" });
		setIcon(replaceSelBtn, "replace");
		replaceSelBtn.addEventListener("click", () => this.handleActionReplaceSelection(text, actionBar));

		const appendBtn = actionBar.createEl("button", { text: "Append", cls: "claude-chat-action-btn" });
		setIcon(appendBtn, "plus-square");
		appendBtn.addEventListener("click", () => this.handleActionAppendToNote(text, actionBar));

		const replaceNoteBtn = actionBar.createEl("button", { text: "Replace note", cls: "claude-chat-action-btn mod-warning" });
		setIcon(replaceNoteBtn, "file-warning");
		replaceNoteBtn.addEventListener("click", () => this.handleActionReplaceWholeNote(text, actionBar));

		// Show Changes panel if there are edits (instead of View diff button)
		if (this.plugin.turnHasEdits && this.plugin.turnSnapshot) {
			void this.appendChangesPanel(actionBar);
		}
	}

	/**
	 * Append a Changes panel showing diff stats (+X -Y)
	 */
	private async appendChangesPanel(actionBar: HTMLElement): Promise<void> {
		const stats = await this.calculateDiffStats();
		if (!stats) return;

		const changesPanel = actionBar.createDiv({ cls: "claude-chat-changes-panel" });
		changesPanel.createSpan({ text: "Changes", cls: "claude-chat-changes-title" });
		
		const statsEl = changesPanel.createDiv({ cls: "claude-chat-changes-stats" });
		if (stats.added > 0) {
			statsEl.createSpan({ 
				text: `+${stats.added}`, 
				cls: "claude-chat-changes-added" 
			});
		}
		if (stats.removed > 0) {
			statsEl.createSpan({ 
				text: `-${stats.removed}`, 
				cls: "claude-chat-changes-removed" 
			});
		}

		changesPanel.addEventListener("click", () => {
			void this.showTurnDiff();
		});
	}

	/**
	 * Calculate diff stats for the current turn
	 */
	private async calculateDiffStats(): Promise<{ added: number; removed: number } | null> {
		try {
			const snapshot = this.plugin?.turnSnapshot;
			if (!snapshot || snapshot.files.length === 0) {
				return null;
			}

			const firstSnapshotFile = snapshot.files[0];
			if (!firstSnapshotFile) {
				return null;
			}

			const primaryFilePath = snapshot.primaryFilePath ?? firstSnapshotFile.filePath;
			const original = snapshot.files.find((f) => f.filePath === primaryFilePath) ?? firstSnapshotFile;

			const current = await this.plugin.getCurrentFileContent(original.filePath);
			if (!current) {
				return null;
			}

			// No changes
			if (current.fullContent === original.fullContent) {
				return { added: 0, removed: 0 };
			}

			const diff = generateInlineDiff(original.fullContent, current.fullContent);
			const stats = getDiffStats(diff);
			
			return { added: stats.added, removed: stats.removed };
		} catch (error) {
			return null;
		}
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
		this.thinkingPanelEl = null;
		this.thinkingExpandBtnEl = null;
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

	private createThinkingBlock(isLoading = false): void {
		if (!this.threadEl || this.streamingThinkingTextEl) return;

		// Insert thinking panel before the assistant bubble if it exists
		const panel = this.threadEl.createDiv({ cls: "claude-chat-thinking-panel" });
		panel.style.animation = "slideInUp 0.15s ease-out forwards";
		if (this.streamingAssistantBubbleEl) {
			this.threadEl.insertBefore(panel, this.streamingAssistantBubbleEl);
		}

		// Store references for later collapse
		this.thinkingPanelEl = panel;

		const header = panel.createDiv({ cls: "claude-chat-thinking-header" });
		const titleWrap = header.createDiv({ cls: "claude-chat-thinking-title-wrap" });
		titleWrap.createDiv({ cls: "claude-chat-thinking-status", text: "Thinking..." });
		titleWrap.createDiv({ cls: "claude-chat-thinking-title", text: "Claude's reasoning" });

		const expandBtn = header.createEl("button", {
			cls: "claude-chat-thinking-expand-btn clickable-icon",
			attr: { "aria-label": "Toggle thinking expansion" }
		});
		setIcon(expandBtn, "chevron-up");
		this.thinkingExpandBtnEl = expandBtn;

		const content = panel.createDiv({ cls: "claude-chat-thinking-content" });

		// Show loading placeholder if in loading state
		if (isLoading) {
			const loadingEl = content.createDiv({ cls: "claude-chat-thinking-loading" });
			loadingEl.createSpan({ cls: "claude-chat-thinking-loading-dots", text: "" });
			loadingEl.createSpan({ text: "Analyzing your request" });
		}

		this.streamingThinkingTextEl = content;

		// Click handler for expand button
		expandBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleThinkingPanel();
		});

		// Click handler for entire header (when collapsed)
		header.addEventListener("click", (evt) => {
			// Only handle click if panel is collapsed (don't interfere when expanded)
			if (panel.classList.contains("is-collapsed")) {
				evt.preventDefault();
				evt.stopPropagation();
				this.toggleThinkingPanel();
			}
		});

		this.scrollThreadToBottom();
	}

	private toggleThinkingPanel(): void {
		if (!this.thinkingPanelEl || !this.thinkingExpandBtnEl) return;
		const isCollapsedNow = this.thinkingPanelEl.classList.contains("is-collapsed");
		if (isCollapsedNow) {
			this.thinkingPanelEl.removeClass("is-collapsed");
			setIcon(this.thinkingExpandBtnEl, "chevron-up");
		} else {
			this.thinkingPanelEl.addClass("is-collapsed");
			setIcon(this.thinkingExpandBtnEl, "chevron-down");
		}
	}

	private collapseThinkingPanel(): void {
		if (!this.thinkingPanelEl || !this.thinkingExpandBtnEl) return;
		this.thinkingPanelEl.addClass("is-collapsed");
		setIcon(this.thinkingExpandBtnEl, "chevron-down");
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
		if (!this.contextChipEl) return;

		this.contextChipEl.empty();

		if (!this.contextEnabled) {
			const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip claude-chat-chip--disabled" });
			chip.createSpan({ text: "Context disabled" });
			const addBtn = chip.createEl("button", { text: "+", cls: "claude-chat-chip-add" });
			addBtn.addEventListener("click", () => {
				this.contextEnabled = true;
				this.renderContextChip();
			});
			this.updateEditButtons();
			return;
		}

		const context = this.plugin.getActiveContextSnapshot();

		if (!context || context.files.length === 0) {
			const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip claude-chat-chip--warning" });
			chip.setText("No active markdown note");
			this.updateEditButtons();
			return;
		}

		const primary = context.primaryFilePath
			? context.files.find((f) => f.filePath === context.primaryFilePath) ?? context.files[0]
			: context.files[0];
		if (!primary) {
			const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip claude-chat-chip--warning" });
			chip.setText("No active markdown note");
			this.updateEditButtons();
			return;
		}

		const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip" });
		chip.createSpan({ text: "Current note" });
		chip.createSpan({ text: `· ${primary.fileName}` });
		if (primary.hasSelection) {
			chip.createSpan({ text: "· Selection + Full file", cls: "claude-chat-chip-selection" });
		} else {
			chip.createSpan({ text: "· Full file" });
		}
		const removeBtn = chip.createEl("button", { text: "×", cls: "claude-chat-chip-remove" });
		removeBtn.addEventListener("click", () => {
			this.contextEnabled = false;
			this.renderContextChip();
		});

		this.updateEditButtons();
	}

	private handleActionReplaceSelection(text: string, actionBar: HTMLElement): void {
		try {
			// Clear any existing undo state before applying new edit
			this.plugin.clearUndoState();
			
			const result = this.plugin.replaceSelectionWithAssistantText(text);
			new Notice("Selection replaced from chat response.");
			this.appendSystemMessage(`Applied edit: replaced selection in ${result.filePath}`, "success");
			this.renderContextChip();
			
			// Replace action bar with undo button
			this.showUndoButton(actionBar, "replace-selection");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendSystemMessage(`Edit failed: ${msg}`, "error");
		}
	}

	private handleActionAppendToNote(text: string, actionBar: HTMLElement): void {
		try {
			// Clear any existing undo state before applying new edit
			this.plugin.clearUndoState();
			
			const result = this.plugin.appendAssistantTextToActiveNote(text);
			new Notice("Assistant response appended to active note.");
			this.appendSystemMessage(`Applied edit: appended to ${result.filePath}`, "success");
			this.renderContextChip();
			
			// Replace action bar with undo button
			this.showUndoButton(actionBar, "append-note");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendSystemMessage(`Edit failed: ${msg}`, "error");
		}
	}

	private handleActionReplaceWholeNote(text: string, actionBar: HTMLElement): void {
		const applyChange = () => {
			try {
				// Clear any existing undo state before applying new edit
				this.plugin.clearUndoState();
				
				const result = this.plugin.replaceWholeActiveNote(text);
				new Notice("Whole note replaced from chat response.");
				this.appendSystemMessage(`Applied edit: replaced whole note ${result.filePath}`, "success");
				this.renderContextChip();
				
				// Replace action bar with undo button
				this.showUndoButton(actionBar, "replace-note");
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

	/**
	 * Replace action bar with undo button after an edit is applied
	 */
	private showUndoButton(actionBar: HTMLElement, actionType: string): void {
		actionBar.empty();

		const undoBtn = actionBar.createEl("button", { 
			text: "Undo", 
			cls: "claude-chat-action-btn claude-chat-action-btn--undo" 
		});
		setIcon(undoBtn, "undo");
		undoBtn.addEventListener("click", () => this.handleActionUndo(actionBar, actionType));

		// Also add View diff button using turn snapshot
		if (this.plugin.turnSnapshot) {
			const viewDiffBtn = actionBar.createEl("button", { 
				text: "View diff", 
				cls: "claude-chat-action-btn" 
			});
			setIcon(viewDiffBtn, "git-compare");
			viewDiffBtn.addEventListener("click", () => void this.showTurnDiff());
		}
	}

	/**
	 * Handle undo action
	 */
	private handleActionUndo(actionBar: HTMLElement, originalActionType: string): void {
		try {
			const result = this.plugin.undoLastEdit();
			new Notice("Edit undone.");
			this.appendSystemMessage(`Undid ${result.action} in ${result.filePath}`, "success");
			this.renderContextChip();
			
			// Restore original action bar (with edit buttons)
			// Find the bubble container and re-create the action bar
			const bubble = actionBar.closest(".claude-chat-bubble--assistant");
			if (bubble) {
				actionBar.remove();
				// We need to get the original text to recreate the action bar
				// The text is stored in lastAssistantText
				if (this.lastAssistantText) {
					this.appendActionBar(bubble as HTMLElement, this.lastAssistantText);
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(`Undo failed: ${msg}`);
			this.appendSystemMessage(`Undo failed: ${msg}`, "error");
		}
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

	private renderStatus(session: AuthSession): void {
		if (this.statusEl) {
			this.statusEl.empty();
			this.statusEl.setText(this.describeSession(session));
		}
		this.renderSettingsPanel();
	}

	private toggleSettingsPanel(): void {
		if (!this.settingsPanelEl) return;
		const isVisible = this.settingsPanelEl.style.display !== "none";
		this.settingsPanelEl.style.display = isVisible ? "none" : "flex";
		if (!isVisible) {
			this.renderSettingsPanel();
		}
	}

	private renderSettingsPanel(): void {
		if (!this.settingsPanelEl) return;
		const panel = this.settingsPanelEl;
		panel.empty();

		const session = this.plugin.getChatAuthSession();

		const statusSection = panel.createDiv({ cls: "claude-chat-settings-status" });
		setIcon(statusSection.createSpan({ cls: "claude-chat-settings-status-icon" }), "info");
		statusSection.createSpan({ text: this.describeSession(session) });

		const actionsSection = panel.createDiv({ cls: "claude-chat-settings-actions" });

		const loginBtn = actionsSection.createEl("button", { cls: "claude-chat-settings-action-btn" });
		setIcon(loginBtn.createSpan(), "log-in");
		loginBtn.createSpan({ text: "Sign in" });
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

		const testBtn = actionsSection.createEl("button", { cls: "claude-chat-settings-action-btn" });
		setIcon(testBtn.createSpan(), "activity");
		testBtn.createSpan({ text: "Test Connection" });
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

		const signOutBtn = actionsSection.createEl("button", { cls: "claude-chat-settings-action-btn" });
		setIcon(signOutBtn.createSpan(), "log-out");
		signOutBtn.createSpan({ text: "Sign out" });
		signOutBtn.addEventListener("click", async () => {
			const session = await this.plugin.signOutChat();
			this.renderStatus(session);
			this.appendSystemMessage("Signed out.");
		});

		const closeBtn = panel.createEl("button", { cls: "claude-chat-settings-close-btn", text: "Close" });
		closeBtn.addEventListener("click", () => this.toggleSettingsPanel());
	}

	private onHeaderMenuClick(evt: MouseEvent): void {
		// No longer used, handled by toggleSettingsPanel
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

	/**
	 * Check if a tool name is an edit tool
	 */
	private isEditTool(toolName: string): boolean {
		const editTools = ['write_file', 'edit_file', 'replace', 'append', 'apply_edit', 'str_replace_editor', 'edit'];
		return editTools.some(t => toolName.toLowerCase().includes(t));
	}

	/**
	 * Show diff comparing turn snapshot to current file state
	 */
	private async showTurnDiff(): Promise<void> {
		try {
			const snapshot = this.plugin?.turnSnapshot;
			if (!snapshot || snapshot.files.length === 0) {
				new Notice("No diff available.");
				return;
			}

			const firstSnapshotFile = snapshot.files[0];
			if (!firstSnapshotFile) {
				new Notice("No diff available.");
				return;
			}

			const primaryFilePath = snapshot.primaryFilePath ?? firstSnapshotFile.filePath;
			const original = snapshot.files.find((f) => f.filePath === primaryFilePath) ?? firstSnapshotFile;

			const current = await this.plugin.getCurrentFileContent(original.filePath);
			if (!current) {
				new Notice("Cannot access file content.");
				return;
			}

			// Don't show diff if nothing changed
			if (current.fullContent === original.fullContent) {
				new Notice("No changes to show.");
				return;
			}

			new DiffViewerModal(this.app, {
				originalContent: original.fullContent,
				modifiedContent: current.fullContent,
				actionType: "replace-note",
				filePath: original.filePath,
			}).open();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(`Cannot show diff: ${msg}`);
		}
	}
}
