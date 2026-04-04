import { App, ItemView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsidianAiPlugin from "../main";
import type { AuthSession } from "../auth/types";
import type { BridgeStreamEvent } from "./ClaudeSdkBridge";
import { DiffViewerModal } from "../components/DiffViewerModal";
import { generateInlineDiff, getDiffStats } from "../utils/DiffGenerator";
import { IncrementalDomRenderer } from "incremark-renderer";
import {
	parseFileMentions,
	resolveFileMentions,
	insertFileMention,
	removeFileMention,
	getFileDisplayName,
	hasFileMentions,
} from "../mentions/FileMentionService";

export const CLAUDE_CHAT_VIEW_TYPE = "claude-chat-view";

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
	private thinkingLoadingEl: HTMLElement | null = null;
	private isSending = false;
	private isStreaming = false;

	// Streaming buffers - accumulate in memory, not DOM (prevents layout thrashing)
	private assistantTextBuffer = "";
	private thinkingTextBuffer = "";
	private pendingAnimationFrame: number | null = null;
	private lastScrollTime = 0;

	// Incremental markdown renderer for streaming content
	private incrementalRenderer: IncrementalDomRenderer | null = null;
	private thinkingIncrementalRenderer: IncrementalDomRenderer | null = null;

	// File mention state
	private mentionDropdownEl: HTMLElement | null = null;
	private mentionChipsEl: HTMLElement | null = null;
	private mentionDropdownActive = false;
	private mentionDropdownSelectedIndex = 0;
	private mentionSearchQuery = '';
	private mentionFiles: TFile[] = [];
	private mentionCursorPosition = 0;

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

		// New chat button
		const newChatBtn = headerActionsEl.createEl("button", {
			cls: "clickable-icon claude-chat-icon-btn claude-chat-new-chat-btn",
			attr: { "aria-label": "New chat" }
		});
		setIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => this.clearConversation());

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

		// Mention chips container (below input)
		this.mentionChipsEl = composerEl.createDiv({ cls: "claude-chat-mention-chips" });
		this.mentionChipsEl.style.display = "none";

		const promptContainer = composerEl.createDiv({ cls: "claude-chat-prompt-container" });

		// Mention dropdown (positioned above input)
		this.mentionDropdownEl = promptContainer.createDiv({ cls: "claude-chat-mention-dropdown" });
		this.mentionDropdownEl.style.display = "none";

		this.promptInputEl = promptContainer.createEl("textarea", { cls: "claude-chat-prompt" });
		this.promptInputEl.placeholder = "Ask Claude to improve, summarize, or edit your current note... Type @ to mention files";
		this.promptInputEl.rows = 1;
		this.adjustTextareaHeight();
		this.promptInputEl.addEventListener("input", () => this.handleInput());
		this.promptInputEl.addEventListener("keydown", (evt) => this.handleInputKeydown(evt));
		this.promptInputEl.addEventListener("keyup", () => this.checkForMentionTrigger());
		this.promptInputEl.addEventListener("click", () => this.closeMentionDropdown());

		this.sendBtn = promptContainer.createEl("button", { cls: "claude-chat-send-btn clickable-icon", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "send");
		this.sendBtn.addEventListener("click", () => {
			if (this.isStreaming) {
				void this.handleStop();
			} else {
				void this.handleSend();
			}
		});
	}

	private adjustTextareaHeight(): void {
		if (!this.promptInputEl) return;
		// Reset height to auto to shrink if text is deleted
		this.promptInputEl.style.height = "auto";
		// Set to scrollHeight to expand to fit content (capped by max-height in CSS)
		const newHeight = Math.min(this.promptInputEl.scrollHeight, 220);
		this.promptInputEl.style.height = `${newHeight}px`;
	}

	/**
	 * Handle input changes - adjust height and check for mentions
	 */
	private handleInput(): void {
		this.adjustTextareaHeight();
		this.updateMentionChips();
	}

	/**
	 * Check if the user typed @ to trigger mention dropdown
	 */
	private checkForMentionTrigger(): void {
		if (!this.promptInputEl) return;

		const cursorPos = this.promptInputEl.selectionStart || 0;
		const text = this.promptInputEl.value;

		// Check if we're in an active mention (after @ before space/newline)
		if (this.mentionDropdownActive) {
			// Extract text between @ trigger and cursor
			const textAfterTrigger = text.slice(this.mentionCursorPosition, cursorPos);
			// If user typed space or newline, close dropdown
			if (/\s/.test(textAfterTrigger)) {
				this.closeMentionDropdown();
				return;
			}
			// Update search query and re-render
			this.mentionSearchQuery = textAfterTrigger.toLowerCase();
			this.renderMentionDropdown();
			return;
		}

		// Check if @ was just typed before cursor
		if (cursorPos > 0 && text[cursorPos - 1] === '@') {
			this.mentionCursorPosition = cursorPos;
			this.mentionSearchQuery = '';
			this.openMentionDropdown();
		}
	}

	/**
	 * Handle keyboard events for mention dropdown navigation
	 */
	private handleInputKeydown(evt: KeyboardEvent): void {
		if (this.mentionDropdownActive) {
			switch (evt.key) {
				case 'ArrowDown':
					evt.preventDefault();
					this.selectNextMention();
					return;
				case 'ArrowUp':
					evt.preventDefault();
					this.selectPreviousMention();
					return;
				case 'Enter':
					evt.preventDefault();
					this.insertSelectedMention();
					return;
				case 'Escape':
					evt.preventDefault();
					this.closeMentionDropdown();
					return;
			}
		}

		// Normal send on Enter (not Shift+Enter)
		if (evt.key === 'Enter' && !evt.shiftKey) {
			evt.preventDefault();
			void this.handleSend();
		}
	}

	/**
	 * Open the mention dropdown with file suggestions
	 */
	private openMentionDropdown(): void {
		if (!this.mentionDropdownEl || !this.promptInputEl) return;

		// Get all markdown files in vault
		const files = this.app.vault.getMarkdownFiles();
		// Sort by recently modified
		files.sort((a, b) => b.stat.mtime - a.stat.mtime);

		this.mentionFiles = files;
		this.mentionDropdownSelectedIndex = 0;
		this.mentionDropdownActive = true;

		this.renderMentionDropdown();
		this.mentionDropdownEl.style.display = 'block';
	}

	/**
	 * Close the mention dropdown
	 */
	private closeMentionDropdown(): void {
		if (!this.mentionDropdownEl) return;
		this.mentionDropdownActive = false;
		this.mentionDropdownEl.style.display = 'none';
		this.mentionDropdownEl.empty();
	}

	/**
	 * Render the mention dropdown items
	 */
	private renderMentionDropdown(): void {
		if (!this.mentionDropdownEl) return;
		this.mentionDropdownEl.empty();

		const filteredFiles = this.mentionSearchQuery
			? this.mentionFiles.filter(f =>
				f.name.toLowerCase().includes(this.mentionSearchQuery.toLowerCase()) ||
				f.path.toLowerCase().includes(this.mentionSearchQuery.toLowerCase())
			)
			: this.mentionFiles.slice(0, 50); // Show top 50 recent files

		if (filteredFiles.length === 0) {
			this.mentionDropdownEl.createDiv({
				cls: 'claude-chat-mention-item',
				text: 'No files found'
			});
			return;
		}

		filteredFiles.forEach((file, index) => {
			const item = this.mentionDropdownEl!.createDiv({
				cls: 'claude-chat-mention-item'
			});

			if (index === this.mentionDropdownSelectedIndex) {
				item.addClass('is-selected');
			}

			// Top row: icon + filename
			const topRow = item.createDiv({ cls: 'claude-chat-mention-item-top' });
			const iconEl = topRow.createSpan({ cls: 'claude-chat-mention-item-icon' });
			setIcon(iconEl, 'file-text');
			topRow.createSpan({ cls: 'claude-chat-mention-item-name', text: file.name });

			// Bottom row: path (if in folder)
			if (file.parent?.path && file.parent.path !== '/') {
				item.createDiv({
					cls: 'claude-chat-mention-item-path',
					text: file.parent.path
				});
			}

			item.addEventListener('click', () => {
				this.insertMention(file.path);
			});
		});
	}

	/**
	 * Select next item in dropdown
	 */
	private selectNextMention(): void {
		this.mentionDropdownSelectedIndex = Math.min(
			this.mentionDropdownSelectedIndex + 1,
			this.mentionFiles.length - 1
		);
		this.renderMentionDropdown();
	}

	/**
	 * Select previous item in dropdown
	 */
	private selectPreviousMention(): void {
		this.mentionDropdownSelectedIndex = Math.max(
			this.mentionDropdownSelectedIndex - 1,
			0
		);
		this.renderMentionDropdown();
	}

	/**
	 * Insert the selected mention
	 */
	private insertSelectedMention(): void {
		const file = this.mentionFiles[this.mentionDropdownSelectedIndex];
		if (file) {
			this.insertMention(file.path);
		}
	}

	/**
	 * Insert a file mention at the trigger position
	 */
	private insertMention(filePath: string): void {
		if (!this.promptInputEl) return;

		const cursorPos = this.promptInputEl.selectionStart || 0;
		const text = this.promptInputEl.value;

		// Remove the @ character that triggered this
		const beforeTrigger = text.slice(0, cursorPos - 1);
		const afterCursor = text.slice(cursorPos);

		// Insert the mention
		const { newText, newCursorPos } = insertFileMention(
			beforeTrigger + afterCursor,
			cursorPos - 1,
			filePath
		);

		this.promptInputEl.value = newText;
		this.promptInputEl.setSelectionRange(newCursorPos, newCursorPos);
		this.promptInputEl.focus();

		this.closeMentionDropdown();
		this.updateMentionChips();
		this.adjustTextareaHeight();
	}

	/**
	 * Update the mention chips display based on current input
	 */
	private updateMentionChips(): void {
		if (!this.promptInputEl || !this.mentionChipsEl) return;

		const text = this.promptInputEl.value;
		const mentions = parseFileMentions(text);

		// Clear existing chips
		this.mentionChipsEl.empty();

		if (mentions.files.length === 0) {
			this.mentionChipsEl.style.display = 'none';
			return;
		}

		this.mentionChipsEl.style.display = 'flex';

		mentions.files.forEach(filePath => {
			const chip = this.mentionChipsEl!.createDiv({ cls: 'claude-chat-mention-chip' });

			// File icon
			const iconEl = chip.createSpan();
			setIcon(iconEl, 'file-text');

			// File name
			chip.createSpan({ text: getFileDisplayName(filePath) });

			// Remove button
			const removeBtn = chip.createEl('button', {
				cls: 'claude-chat-mention-chip-remove',
				text: '×'
			});
			removeBtn.addEventListener('click', () => {
				this.removeMention(filePath);
			});
		});
	}

	/**
	 * Remove a file mention
	 */
	private removeMention(filePath: string): void {
		if (!this.promptInputEl) return;

		const text = this.promptInputEl.value;
		this.promptInputEl.value = removeFileMention(text, filePath);
		this.updateMentionChips();
	}

	private async handleStop(): Promise<void> {
		if (!this.isStreaming) return;
		const stopped = this.plugin.stopGeneration();
		if (stopped) {
			// The error handler in handleSend will catch the cancellation and update UI
			console.log("[ClaudeChat] Stop requested");
		}
	}

	private async handleSend(): Promise<void> {
		if (!this.promptInputEl || this.isSending) return;
		const rawPrompt = this.promptInputEl.value.trim();
		if (!rawPrompt) {
			new Notice("Enter a prompt first.");
			return;
		}

		// Check auth before sending
		const authCheck = await this.plugin.validateAuth();
		if (!authCheck.valid) {
			this.appendSystemMessage(authCheck.message, "error");
			return;
		}

		// Resolve file mentions to semantic markers
		let resolvedPrompt = rawPrompt;
		if (hasFileMentions(rawPrompt)) {
			const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
			const vaultBasePath = adapter.getBasePath?.() || '';
			resolvedPrompt = resolveFileMentions(rawPrompt, vaultBasePath);
		}

		// Display the raw user message (with [file:...] visible)
		this.appendUserMessage(rawPrompt);
		this.promptInputEl.value = "";
		this.adjustTextareaHeight();
		this.updateMentionChips();
		this.setSendingState(true, false);
		this.beginStreamingAssistantBlocks();

		try {
			const response = await this.plugin.sendChatPromptStream(resolvedPrompt, {
				includeActiveContext: this.contextEnabled,
			}, {
				onEvent: (event) => {
					// Set streaming state on first event
					if (!this.isStreaming) {
						this.setSendingState(true, true);
					}
					this.handleStreamEvent(event);
				},
			});
			this.finishStreamingAssistantText(response.text);
			this.renderContextChip();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg === "GENERATION_CANCELLED") {
				this.appendSystemMessage("Generation stopped.");
				this.endStreamingBlocks();
			} else {
				this.handleAuthError(error);
				this.endStreamingBlocks();
			}
		} finally {
			this.setSendingState(false, false);
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

		if (msg.includes("invalid_grant") || msg.includes("revoked") || msg.includes("invalid refresh")) {
			new Notice("Session revoked. Please sign in again.");
			this.appendSystemMessage(
				'Your Claude session was revoked or invalid. Click "Sign in" to re-authenticate.',
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
				if (!this.streamingAssistantBubbleEl) {
					this.beginStreamingAssistantBlocks();
				}
				// Use incremark for incremental markdown rendering
				this.assistantTextBuffer += event.text;
				if (this.incrementalRenderer) {
					this.incrementalRenderer.append(event.text);
				}
				this.throttledScroll();
				return;
			}
			case "thinking_delta": {
				if (!this.thinkingPanelEl) {
					this.createThinkingBlock();
				}
				// Hide loading placeholder when thinking text starts streaming
				if (this.thinkingLoadingEl) {
					this.thinkingLoadingEl.style.display = "none";
					this.thinkingLoadingEl = null;
				}
				// Use incremark for incremental markdown rendering in thinking panel
				this.thinkingTextBuffer += event.text;
				if (this.thinkingIncrementalRenderer) {
					this.thinkingIncrementalRenderer.append(event.text);
				}
				this.throttledScroll();
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

		// Create container for incremental markdown renderer
		const markdownContainer = assistantBubble.createDiv({ cls: "claude-chat-bubble-markdown" });

		// Initialize incremark incremental renderer
		this.incrementalRenderer = new IncrementalDomRenderer(markdownContainer, {
			highlight: {
				showLineNumbers: true,
			},
			math: {
				katex: {
					throwOnError: false,
				},
			},
		});

		// Keep reference to text element for fallback/thinking display
		this.streamingAssistantTextEl = assistantBubble.createDiv({ cls: "claude-chat-bubble-text" });
		this.streamingAssistantTextEl.style.display = "none"; // Hidden, used as fallback

		this.streamingToolContainerEl = this.threadEl.createDiv({ cls: "claude-chat-steps" });
		this.toolStepEls.clear();
		this.scrollThreadToBottom();
	}

	private finishStreamingAssistantText(finalText: string): void {
		console.log("[ClaudeChat] finishStreamingAssistantText called");
		// Cancel any pending frame and flush immediately
		if (this.pendingAnimationFrame) {
			cancelAnimationFrame(this.pendingAnimationFrame);
			this.pendingAnimationFrame = null;
		}

		// Hide loading placeholder if still visible (no thinking text was streamed)
		if (this.thinkingLoadingEl) {
			this.thinkingLoadingEl.style.display = "none";
			this.thinkingLoadingEl = null;
		}

		// Update buffer
		this.assistantTextBuffer = finalText;

		const bubbleEl = this.streamingAssistantBubbleEl; // Capture before ending blocks

		// Finalize incremark renderer
		if (this.incrementalRenderer) {
			this.incrementalRenderer.finalize();
		}

		// Render final markdown content with Obsidian's renderer for full compatibility
		void this.renderMarkdownContent(finalText).then(() => {
			// Show Changes panel if there are edits
			if (this.plugin.turnHasEdits && this.plugin.turnSnapshot && bubbleEl) {
				void this.appendChangesPanel(bubbleEl);
			}
		});

		// Finalize thinking renderer if any
		if (this.thinkingIncrementalRenderer) {
			this.thinkingIncrementalRenderer.finalize();
		}

		this.scrollThreadToBottom();

		// Collapse the thinking panel when response is complete
		console.log("[ClaudeChat] About to call collapseThinkingPanel");
		this.collapseThinkingPanel();
		console.log("[ClaudeChat] About to call endStreamingBlocks");

		this.endStreamingBlocks();
		console.log("[ClaudeChat] finishStreamingAssistantText done");
	}

	/**
	 * Render markdown content to the assistant bubble.
	 * With incremark, this is now optional - incremark handles incremental rendering.
	 * This method can be used for Obsidian-specific features if needed.
	 */
	private async renderMarkdownContent(markdown: string): Promise<void> {
		if (!this.streamingAssistantBubbleEl) return;

		// Remove the hidden plain text element if it exists
		if (this.streamingAssistantTextEl) {
			this.streamingAssistantTextEl.remove();
			this.streamingAssistantTextEl = null;
		}

		// incremark already rendered the markdown incrementally.
		// If we need Obsidian-specific features (wikilinks, embeds, etc.),
		// we could re-render here, but for now we'll keep incremark's output
		// for better performance and streaming experience.

		this.scrollThreadToBottom();
	}

	private endStreamingBlocks(): void {
		console.log("[ClaudeChat] endStreamingBlocks called - clearing streaming refs only");
		this.streamingAssistantBubbleEl = null;
		this.streamingAssistantTextEl = null;
		this.streamingThinkingTextEl = null;
		this.thinkingLoadingEl = null;
		// NOTE: Do NOT clear thinkingPanelEl and thinkingExpandBtnEl here
		// These need to persist so users can toggle the panel after streaming ends
		this.thinkingDetailsEl = null;
		this.streamingToolContainerEl = null;
		this.toolStepEls.clear();

		// Clear incremark renderers
		this.incrementalRenderer = null;
		this.thinkingIncrementalRenderer = null;

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
		titleWrap.createDiv({ cls: "claude-chat-thinking-status", text: "Thinking" });
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
			this.thinkingLoadingEl = loadingEl;
		}

		// Create markdown container for incremark incremental renderer
		const markdownContainer = content.createDiv({ cls: "claude-chat-thinking-markdown" });

		// Initialize incremark incremental renderer for thinking content
		this.thinkingIncrementalRenderer = new IncrementalDomRenderer(markdownContainer, {
			highlight: {
				showLineNumbers: true,
			},
			math: {
				katex: {
					throwOnError: false,
				},
			},
		});

		this.streamingThinkingTextEl = content;

		// Click handler for expand button
		expandBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleThinkingPanel();
		});

		// Click handler for entire panel when collapsed
		panel.addEventListener("click", (evt) => {
			console.log("[ClaudeChat] Panel clicked, target:", evt.target, "currentTarget:", evt.currentTarget);
			console.log("[ClaudeChat] Panel has is-collapsed:", panel.classList.contains("is-collapsed"));
			console.log("[ClaudeChat] Panel classes:", panel.className);
			// Only handle click if panel is collapsed (don't interfere when expanded)
			if (panel.classList.contains("is-collapsed")) {
				evt.preventDefault();
				evt.stopPropagation();
				console.log("[ClaudeChat] Calling toggleThinkingPanel");
				this.toggleThinkingPanel();
			}
		});

		this.scrollThreadToBottom();
	}

	private toggleThinkingPanel(): void {
		console.log("[ClaudeChat] toggleThinkingPanel called");
		if (!this.thinkingPanelEl || !this.thinkingExpandBtnEl) {
			console.log("[ClaudeChat] toggleThinkingPanel early return - missing refs");
			return;
		}
		const isCollapsedNow = this.thinkingPanelEl.classList.contains("is-collapsed");
		console.log("[ClaudeChat] toggleThinkingPanel isCollapsedNow:", isCollapsedNow);
		if (isCollapsedNow) {
			this.thinkingPanelEl.removeClass("is-collapsed");
			setIcon(this.thinkingExpandBtnEl, "chevron-up");
			console.log("[ClaudeChat] toggleThinkingPanel expanded panel");
		} else {
			this.thinkingPanelEl.addClass("is-collapsed");
			setIcon(this.thinkingExpandBtnEl, "chevron-down");
			console.log("[ClaudeChat] toggleThinkingPanel collapsed panel");
		}
	}

	private collapseThinkingPanel(): void {
		console.log("[ClaudeChat] collapseThinkingPanel called");
		if (!this.thinkingPanelEl || !this.thinkingExpandBtnEl) {
			console.log("[ClaudeChat] collapseThinkingPanel early return - missing refs");
			return;
		}
		this.thinkingPanelEl.addClass("is-collapsed");
		setIcon(this.thinkingExpandBtnEl, "chevron-down");
		console.log("[ClaudeChat] collapseThinkingPanel done, panel collapsed");
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
			return;
		}

		const context = this.plugin.getActiveContextSnapshot();

		if (!context || context.files.length === 0) {
			const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip claude-chat-chip--warning" });
			chip.setText("No active markdown note");
			return;
		}

		const primary = context.primaryFilePath
			? context.files.find((f) => f.filePath === context.primaryFilePath) ?? context.files[0]
			: context.files[0];
		if (!primary) {
			const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip claude-chat-chip--warning" });
			chip.setText("No active markdown note");
			return;
		}

		const chip = this.contextChipEl.createDiv({ cls: "claude-chat-chip" });
		chip.createSpan({ text: primary.fileName });
		if (primary.hasSelection && primary.selectionContent.trim()) {
			const preview = this.truncateSelectionPreview(primary.selectionContent, 2);
			chip.createSpan({ text: `| ${preview}`, cls: "claude-chat-chip-selection" });
		}
		const removeBtn = chip.createEl("button", { text: "×", cls: "claude-chat-chip-remove" });
		removeBtn.addEventListener("click", () => {
			this.contextEnabled = false;
			this.renderContextChip();
		});
	}

	/**
	 * Truncate selection text to first N words with ellipsis if truncated.
	 */
	private truncateSelectionPreview(text: string, wordCount: number): string {
		const words = text.trim().split(/\s+/);
		if (words.length <= wordCount) {
			return text.trim();
		}
		return words.slice(0, wordCount).join(" ") + "...";
	}

	private setSendingState(isSending: boolean, isStreaming = false): void {
		this.isSending = isSending;
		this.isStreaming = isStreaming;
		if (this.sendBtn) {
			this.sendBtn.disabled = false; // Always enabled - acts as stop when streaming
			this.sendBtn.empty();
			// Show square (stop) icon when streaming, hourglass when sending but not yet streaming, send when idle
			if (isStreaming) {
				setIcon(this.sendBtn, "square");
				this.sendBtn.setAttribute("aria-label", "Stop generation");
				this.sendBtn.addClass("claude-chat-stop-btn");
			} else if (isSending) {
				setIcon(this.sendBtn, "hourglass");
				this.sendBtn.setAttribute("aria-label", "Sending...");
				this.sendBtn.removeClass("claude-chat-stop-btn");
			} else {
				setIcon(this.sendBtn, "send");
				this.sendBtn.setAttribute("aria-label", "Send");
				this.sendBtn.removeClass("claude-chat-stop-btn");
			}
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

	/**
	 * Clear the conversation thread and reset state for a new chat
	 */
	clearConversation(): void {
		// Cancel any ongoing streaming
		if (this.isSending) {
			this.setSendingState(false);
		}
		if (this.pendingAnimationFrame) {
			cancelAnimationFrame(this.pendingAnimationFrame);
			this.pendingAnimationFrame = null;
		}

		// Clear incremark renderers
		if (this.incrementalRenderer) {
			this.incrementalRenderer.finalize();
			this.incrementalRenderer = null;
		}
		if (this.thinkingIncrementalRenderer) {
			this.thinkingIncrementalRenderer.finalize();
			this.thinkingIncrementalRenderer = null;
		}

		// Clear streaming buffers
		this.assistantTextBuffer = "";
		this.thinkingTextBuffer = "";

		// Reset turn snapshot at plugin level
		this.plugin.clearTurnSnapshot();

		// Clear the thread
		if (this.threadEl) {
			this.threadEl.empty();
			this.appendSystemMessage("Ready. Ask Claude about your active note.");
		}

		// Reset streaming refs
		this.endStreamingBlocks();
		this.thinkingPanelEl = null;
		this.thinkingExpandBtnEl = null;
		this.thinkingDetailsEl = null;
		this.thinkingLoadingEl = null;
		this.toolStepEls.clear();
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
	 * Append a Changes panel showing diff stats (+X -Y)
	 */
	private async appendChangesPanel(bubbleEl: HTMLElement): Promise<void> {
		const stats = await this.calculateDiffStats();
		if (!stats) return;

		const changesPanel = bubbleEl.createDiv({ cls: "claude-chat-changes-panel" });
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
