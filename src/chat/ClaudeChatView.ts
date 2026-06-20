import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsidianAiPlugin from "../main";
import type { AuthSession } from "../auth/types";
import type { BridgeStreamEvent } from "./types";
import { MultiFileDiffModal } from "../components/MultiFileDiffModal";
import { generateInlineDiff, getDiffStats } from "../utils/DiffGenerator";
import {
	parseFileMentions,
	resolveFileMentions,
	hasFileMentions,
} from "../mentions/FileMentionService";
import { FileMentionController } from "./FileMentionController";
import { StreamingBlockController } from "./StreamingBlockController";
import { AuthCardView } from "./AuthCardView";
import { ClaudeMaxLoginCoordinator } from "../auth/ClaudeMaxLoginCoordinator";

export const CLAUDE_CHAT_VIEW_TYPE = "claude-chat-view";

export class ClaudeChatView extends ItemView {
	private plugin: ObsidianAiPlugin;
	private statusEl: HTMLElement | null = null;
	private threadEl: HTMLElement | null = null;
	private promptInputEl: HTMLTextAreaElement | null = null;
	private contextChipEl: HTMLElement | null = null;
	private modelSelectEl: HTMLSelectElement | null = null;
	private settingsPanelEl: HTMLElement | null = null;
	private contextEnabled = true;

	private sendBtn: HTMLButtonElement | null = null;
	private isSending = false;
	private isStreaming = false;

	private mentionController: FileMentionController | null = null;
	private streamController: StreamingBlockController | null = null;
	private authCardView: AuthCardView | null = null;
	private promptContainerEl: HTMLElement | null = null;
	private authInProgress = false;
	private expiryWarningDismissed = false;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianAiPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CLAUDE_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "AI chat";
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

	refreshSettingsState(): void {
		this.renderStatus(this.plugin.getChatAuthSession());
		this.renderModelPicker();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("claude-chat-view");

		const shellEl = contentEl.createDiv({ cls: "claude-chat-shell" });

		const headerEl = shellEl.createDiv({ cls: "claude-chat-header" });
		const titleWrap = headerEl.createDiv({ cls: "claude-chat-header-title-wrap" });
		titleWrap.createEl("h3", { text: "AI chat", cls: "claude-chat-title" });
		this.statusEl = titleWrap.createEl("div", { cls: "claude-chat-status" });
		this.renderStatus(this.plugin.getChatAuthSession());

		const headerActionsEl = headerEl.createDiv({ cls: "claude-chat-header-actions" });

		const newChatBtn = headerActionsEl.createEl("button", {
			cls: "clickable-icon claude-chat-icon-btn claude-chat-new-chat-btn",
			attr: { "aria-label": "New chat" },
		});
		setIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => this.clearConversation());

		const menuBtn = headerActionsEl.createEl("button", {
			cls: "clickable-icon claude-chat-icon-btn claude-chat-burger-btn",
			attr: { "aria-label": "Menu" },
		});
		setIcon(menuBtn, "menu");
		menuBtn.addEventListener("click", () => this.toggleSettingsPanel());

		this.settingsPanelEl = shellEl.createDiv({ cls: "claude-chat-settings-panel" });
		this.settingsPanelEl.style.display = "none";
		this.renderSettingsPanel();

		this.threadEl = shellEl.createDiv({ cls: "claude-chat-thread" });
		this.streamController = new StreamingBlockController(this.threadEl);
		// Only Claude bridges resume by session id; ChatGPT/Pi ignore it, so don't
		// promise a resumed conversation that the active provider won't actually restore.
		const providerResumesSession = this.plugin.settings.authMode !== "chatgpt-plus";
		if (this.plugin.settings.chatSessionId && providerResumesSession) {
			this.appendSystemMessage('Resumed your previous conversation — Claude still has its context. Use "New conversation" to start fresh.');
		} else {
			this.appendSystemMessage("Ready. Ask Claude about your active note.");
		}

		const composerEl = shellEl.createDiv({ cls: "claude-chat-composer" });
		const pillRow = composerEl.createDiv({ cls: "claude-chat-pill-row" });

		const contextInfoWrap = pillRow.createDiv({ cls: "claude-chat-context-info-wrap" });
		this.contextChipEl = contextInfoWrap.createDiv({ cls: "claude-chat-chip-container" });
		this.renderContextChip();

		this.modelSelectEl = pillRow.createEl("select", {
			cls: "claude-chat-model-select",
			attr: { "aria-label": "Chat model" },
		});
		this.modelSelectEl.addEventListener("change", () => {
			if (!this.modelSelectEl) return;
			void this.plugin.setSelectedChatModel(this.modelSelectEl.value).then(() => {
				this.renderModelPicker();
			});
		});
		this.renderModelPicker();

		const mentionChipsEl = composerEl.createDiv({ cls: "claude-chat-mention-chips" });
		mentionChipsEl.style.display = "none";

		const promptContainer = composerEl.createDiv({ cls: "claude-chat-prompt-container" });
		this.promptContainerEl = promptContainer;
		this.authCardView = new AuthCardView(composerEl, promptContainer);

		const mentionDropdownEl = promptContainer.createDiv({ cls: "claude-chat-mention-dropdown" });
		mentionDropdownEl.style.display = "none";

		this.promptInputEl = promptContainer.createEl("textarea", { cls: "claude-chat-prompt" });
		this.promptInputEl.placeholder = "Ask Claude to improve, summarize, or edit your current note... Type @ to mention files";
		this.promptInputEl.rows = 1;
		this.adjustTextareaHeight();

		this.mentionController = new FileMentionController(
			this.promptInputEl,
			mentionDropdownEl,
			mentionChipsEl,
			this.app,
			() => this.adjustTextareaHeight()
		);

		this.promptInputEl.addEventListener("input", () => this.handleInput());
		this.promptInputEl.addEventListener("keydown", (evt) => this.handleInputKeydown(evt));
		this.promptInputEl.addEventListener("keyup", () => this.mentionController?.onKeyup());
		this.promptInputEl.addEventListener("click", () => this.mentionController?.onClick());

		this.sendBtn = promptContainer.createEl("button", {
			cls: "claude-chat-send-btn clickable-icon",
			attr: { "aria-label": "Send" },
		});
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
		this.promptInputEl.style.height = "auto";
		const newHeight = Math.min(this.promptInputEl.scrollHeight, 220);
		this.promptInputEl.style.height = `${newHeight}px`;
	}

	private handleInput(): void {
		this.adjustTextareaHeight();
		this.mentionController?.onInput();
	}

	private renderModelPicker(): void {
		if (!this.modelSelectEl) return;

		const selectedModel = this.plugin.getSelectedChatModel();
		const options = this.plugin.getActiveModelOptions();
		this.modelSelectEl.empty();

		for (const option of options) {
			const optionEl = this.modelSelectEl.createEl("option", {
				text: option.label,
				attr: { value: option.id },
			});
			if (option.description) {
				optionEl.title = option.description;
			}
		}

		this.modelSelectEl.value = selectedModel;
		this.modelSelectEl.disabled = this.isSending;
	}

	private handleInputKeydown(evt: KeyboardEvent): void {
		if (this.mentionController?.handleKeydown(evt)) return;
		if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			void this.handleSend();
		}
	}

	private async handleStop(): Promise<void> {
		if (!this.isStreaming) return;
		this.plugin.stopGeneration();
	}

	private async handleSend(): Promise<void> {
		if (!this.promptInputEl || this.isSending) return;
		const rawPrompt = this.promptInputEl.value.trim();
		if (!rawPrompt) {
			new Notice("Enter a prompt first.");
			return;
		}

		// Claim the send synchronously before any await so a second rapid Enter
		// can't slip past the isSending guard and race on the persisted session id.
		this.isSending = true;

		const authCheck = await this.plugin.validateAuth();
		if (!authCheck.valid) {
			this.isSending = false;
			this.appendSystemMessage(authCheck.message, "error");
			return;
		}

		try {
			let resolvedPrompt = rawPrompt;
			if (hasFileMentions(rawPrompt)) {
				const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
				const vaultBasePath = adapter.getBasePath?.() || "";
				resolvedPrompt = resolveFileMentions(rawPrompt, vaultBasePath);
			}

			this.appendUserMessage(rawPrompt);
			this.promptInputEl.value = "";
			this.adjustTextareaHeight();
			this.mentionController?.onInput();
			this.setSendingState(true, false);
			this.streamController?.begin();

			const response = await this.plugin.sendChatPromptStream(
				resolvedPrompt,
				{
					includeActiveContext: this.contextEnabled,
					resumeSessionId: this.plugin.settings.chatSessionId || undefined,
				},
				{
					onEvent: (event) => {
						if (!this.isStreaming) this.setSendingState(true, true);
						this.handleStreamEvent(event);
					},
				}
			);
			if (response.sessionId && response.sessionId !== this.plugin.settings.chatSessionId) {
				this.plugin.settings.chatSessionId = response.sessionId;
				void this.plugin.saveSettings();
			}
			this.streamController?.finish(response.text, {
				onBubbleReady: (bubbleEl) => {
					if (this.plugin.turnHasEdits && this.plugin.turnSnapshot) {
						void this.appendChangesPanel(bubbleEl);
					}
				},
			});
			this.renderContextChip();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg === "GENERATION_CANCELLED") {
				this.appendSystemMessage("Generation stopped.");
				this.streamController?.end();
			} else {
				this.handleAuthError(error);
				this.streamController?.end();
			}
		} finally {
			this.setSendingState(false, false);
		}
	}

	private handleAuthError(error: unknown): void {
		const msg = error instanceof Error ? error.message : String(error);
		const isSessionError =
			msg.includes("401") ||
			msg.includes("authentication_error") ||
			msg.includes("Invalid bearer token") ||
			msg.includes("invalid_grant") ||
			msg.includes("revoked") ||
			msg.includes("invalid refresh") ||
			msg.includes("refresh_token") ||
			msg.includes("No auth token available") ||
			msg.includes("No Claude Max OAuth token");

		if (isSessionError) {
			this.authCardView?.show({
				kind: "session-recovery",
				onSignIn: () => this.handleSignInClick(),
			});
			return;
		}

		if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
			new Notice("Connection timed out. Please try again.");
			this.appendSystemMessage("Connection timed out. Check your internet connection and try again.", "error");
			return;
		}

		if (msg.includes("429") || msg.includes("rate limit") || msg.includes("Rate limit")) {
			new Notice("Rate limited. Please wait a moment.");
			this.appendSystemMessage("Rate limit hit. Please wait a moment before trying again.", "error");
			return;
		}

		new Notice(msg);
		this.appendSystemMessage(`Claude error: ${msg}`, "error");
	}

	private handleStreamEvent(event: BridgeStreamEvent): void {
		this.streamController?.handleEvent(event, {
			onToolFinished: (toolName, detail, ok) => {
				if (this.isEditTool(toolName)) {
					this.plugin.turnHasEdits = true;
					if (detail) void this.trackFileChangeFromTool(detail, ok ? undefined : detail);
				}
			},
			appendStatusMessage: (text) => {
				if (text.trim()) this.appendSystemMessage(text);
			},
		});
	}

	private setSendingState(isSending: boolean, isStreaming = false): void {
		this.isSending = isSending;
		this.isStreaming = isStreaming;
		if (this.sendBtn) {
			this.sendBtn.disabled = false;
			this.sendBtn.empty();
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
		if (this.promptInputEl) this.promptInputEl.disabled = isSending;
		if (this.modelSelectEl) this.modelSelectEl.disabled = isSending;
	}

	private renderStatus(session: AuthSession): void {
		if (this.statusEl) {
			this.statusEl.empty();
			this.statusEl.removeClass("is-expiring");
			const { dotClass, labelText, isExpiring } = this.classifySession(session);
			const dot = this.statusEl.createSpan({ cls: `claude-auth-dot ${dotClass}` });
			dot.setAttribute("aria-hidden", "true");
			this.statusEl.createSpan({ text: labelText });
			if (isExpiring) {
				this.statusEl.addClass("is-expiring");
				this.statusEl.title = "Session expiring soon — click to re-authenticate";
				this.statusEl.addEventListener("click", () => void this.plugin.startChatLogin(), { once: true });
			}
		}

		// Show expiry warning card only when signed in, not dismissed, and no other card is visible
		if (
			this.authCardView &&
			!this.authCardView.isVisible() &&
			!this.expiryWarningDismissed &&
			session.status === "signed-in" &&
			session.expiresAt
		) {
			const hoursLeft = (session.expiresAt - Date.now()) / 3_600_000;
			if (hoursLeft < 24) {
				this.authCardView.show({
					kind: "expiry-warning",
					expiresAt: session.expiresAt,
					onReauth: () => this.handleSignInClick(),
					onDismiss: () => { this.expiryWarningDismissed = true; },
				});
			}
		} else if (session.status !== "signed-in" && this.authCardView?.isVisible()) {
			this.authCardView.hide();
		}

		this.renderSettingsPanel();
	}

	private classifySession(session: AuthSession): { dotClass: string; labelText: string; isExpiring: boolean } {
		if (session.status === "signed-in") {
			const expiresAt = session.expiresAt;
			if (expiresAt) {
				const hoursLeft = (expiresAt - Date.now()) / 3_600_000;
				if (hoursLeft < 24) {
					const h = Math.max(1, Math.round(hoursLeft));
					return { dotClass: "claude-auth-dot--warning", labelText: `Expires in ${h}h`, isExpiring: true };
				}
			}
			return { dotClass: "claude-auth-dot--ok", labelText: `Signed in (${session.accountLabel ?? session.mode})`, isExpiring: false };
		}
		if (session.status === "pending") {
			return { dotClass: "claude-auth-dot--warning", labelText: "Auth pending — paste code in settings", isExpiring: false };
		}
		if (session.status === "unsupported") {
			return { dotClass: "claude-auth-dot--error", labelText: "Auth mode unsupported", isExpiring: false };
		}
		return { dotClass: "claude-auth-dot--muted", labelText: "Signed out", isExpiring: false };
	}

	private toggleSettingsPanel(): void {
		if (!this.settingsPanelEl) return;
		const isVisible = this.settingsPanelEl.style.display !== "none";
		this.settingsPanelEl.style.display = isVisible ? "none" : "flex";
		if (!isVisible) this.renderSettingsPanel();
	}

	private renderSettingsPanel(): void {
		if (!this.settingsPanelEl) return;
		const panel = this.settingsPanelEl;
		panel.empty();

		const session = this.plugin.getChatAuthSession();

		const statusSection = panel.createDiv({ cls: "claude-chat-settings-status" });
		setIcon(statusSection.createSpan({ cls: "claude-chat-settings-status-icon" }), "info");
		statusSection.createSpan({ text: this.classifySession(session).labelText });

		const actionsSection = panel.createDiv({ cls: "claude-chat-settings-actions" });

		const loginBtn = actionsSection.createEl("button", { cls: "claude-chat-settings-action-btn" });
		setIcon(loginBtn.createSpan(), "log-in");
		loginBtn.createSpan({ text: "Sign in" });
		loginBtn.addEventListener("click", () => {
			this.toggleSettingsPanel();
			this.handleSignInClick();
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
			const s = await this.plugin.signOutChat();
			this.renderStatus(s);
			this.appendSystemMessage("Signed out.");
		});

		const closeBtn = panel.createEl("button", { cls: "claude-chat-settings-close-btn", text: "Close" });
		closeBtn.addEventListener("click", () => this.toggleSettingsPanel());
	}

	handleSignInClick(): void {
		if (!this.authCardView || this.authInProgress) return;

		this.authInProgress = true;
		this.expiryWarningDismissed = false;
		const mode = this.plugin.settings.authMode;

		const done = (session?: import("../auth/types").AuthSession) => {
			this.authInProgress = false;
			if (session) this.renderStatus(session);
		};

		if (mode === "claude-max") {
			const coordinator = new ClaudeMaxLoginCoordinator(this.plugin);
			this.authCardView.show({ kind: "claude-max-step1" });

			const startOver = () => {
				coordinator.cancel();
				this.authInProgress = false;
				this.handleSignInClick();
			};

			void coordinator.beginLogin({
				onBrowserOpened: () => {
					if (!this.authCardView) { done(); return; }
					this.authCardView.show({
						kind: "claude-max-step2",
						onReopen: () => void coordinator.reopenBrowser(),
						onStartOver: startOver,
						onConfirm: async (url) => {
							const session = await coordinator.confirmWithUrl(url);
							this.authCardView?.hide();
							done(session);
							this.appendSystemMessage("Signed in to Claude Max.", "success");
						},
					});
				},
				onError: (msg) => {
					this.authCardView?.hide();
					done();
					this.appendSystemMessage(`Sign in failed: ${msg}`, "error");
				},
			});
			return;
		}

		if (mode === "chatgpt-plus") {
			const TIMEOUT_MS = 5 * 60 * 1000;
			let cancelled = false;
			this.authCardView.show({
				kind: "chatgpt-spinner",
				timeoutMs: TIMEOUT_MS,
				onCancel: () => {
					cancelled = true;
					this.authCardView?.hide();
					done();
					void this.plugin.signOutChat();
				},
			});
			void this.plugin.startChatLogin().then((session) => {
				if (cancelled) return;
				this.authCardView?.hide();
				done(session);
				this.appendSystemMessage("Signed in to ChatGPT Plus.", "success");
			}).catch((err) => {
				if (cancelled) return;
				this.authCardView?.hide();
				done();
				const msg = err instanceof Error ? err.message : String(err);
				this.appendSystemMessage(`Sign in failed: ${msg}`, "error");
			});
			return;
		}

		// API key mode: no inline card needed
		void this.plugin.startChatLogin().then((session) => {
			done(session);
		}).catch((err) => {
			done();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(msg);
		});
	}

	clearConversation(): void {
		if (this.isSending) this.setSendingState(false);
		this.streamController?.clearAll();
		this.plugin.clearTurnSnapshot();

		// Drop the resumable session so the next message starts a fresh context.
		if (this.plugin.settings.chatSessionId) {
			this.plugin.settings.chatSessionId = "";
			void this.plugin.saveSettings();
		}

		if (this.threadEl) {
			this.threadEl.empty();
			this.appendSystemMessage("Ready. Ask Claude about your active note.");
		}
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

	private truncateSelectionPreview(text: string, wordCount: number): string {
		const words = text.trim().split(/\s+/);
		if (words.length <= wordCount) return text.trim();
		return words.slice(0, wordCount).join(" ") + "...";
	}

	private async appendChangesPanel(bubbleEl: HTMLElement): Promise<void> {
		const stats = await this.calculateDiffStats();
		if (!stats) return;

		const fileCount = this.plugin.editedFiles.length || this.plugin.turnSnapshot?.files.length || 0;
		const isMultiFile = fileCount > 1;

		const changesPanel = bubbleEl.createDiv({ cls: "claude-chat-changes-panel" });
		changesPanel.createSpan({
			text: isMultiFile ? `${fileCount} files changed` : "Changes",
			cls: "claude-chat-changes-title",
		});

		const statsEl = changesPanel.createDiv({ cls: "claude-chat-changes-stats" });
		if (stats.added > 0) statsEl.createSpan({ text: `+${stats.added}`, cls: "claude-chat-changes-added" });
		if (stats.removed > 0) statsEl.createSpan({ text: `-${stats.removed}`, cls: "claude-chat-changes-removed" });

		changesPanel.addEventListener("click", () => void this.showTurnDiff());
	}

	private async calculateDiffStats(): Promise<{ added: number; removed: number } | null> {
		try {
			const changes = await this.plugin.getTurnFileChanges();
			if (changes.length === 0) return null;

			let totalAdded = 0;
			let totalRemoved = 0;
			for (const change of changes) {
				if (change.error) continue;
				const diff = generateInlineDiff(change.original, change.modified);
				const stats = getDiffStats(diff);
				totalAdded += stats.added;
				totalRemoved += stats.removed;
			}
			return { added: totalAdded, removed: totalRemoved };
		} catch {
			return null;
		}
	}

	private isEditTool(toolName: string): boolean {
		const editTools = ["write_file", "edit_file", "replace", "append", "apply_edit", "str_replace_editor", "edit"];
		return editTools.some((t) => toolName.toLowerCase().includes(t));
	}

	private async trackFileChangeFromTool(detail: string, error?: string): Promise<void> {
		try {
			const pathMatch = detail.match(/([\w\-./]+\.(?:md|txt|js|ts|json|css|html|yaml|yml))/i);
			if (!pathMatch?.[1]) return;

			const filePath = pathMatch[1];
			const existing = this.plugin.editedFiles.find((f) => f.filePath === filePath);
			if (existing) {
				if (error) existing.error = error;
				return;
			}

			const snapshotFile = this.plugin.turnSnapshot?.files.find((f) => f.filePath === filePath);
			const original = snapshotFile?.fullContent ?? "";
			this.plugin.trackFileEdit(filePath, original, undefined, error ?? undefined);
		} catch {
			// Tracking is best-effort
		}
	}

	private async showTurnDiff(): Promise<void> {
		try {
			const changes = await this.plugin.getTurnFileChanges();
			if (changes.length === 0) {
				new Notice("No changes to show.");
				return;
			}

			if (changes.length === 1 && changes[0]) {
				const change = changes[0];
				if (change.error) {
					new Notice(`Error in ${change.filePath}: ${change.error}`);
					return;
				}
			}

			new MultiFileDiffModal(this.app, { changes, consolidated: true }).open();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(`Cannot show diff: ${msg}`);
		}
	}
}
