import { App, ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import type ObsidianAiPlugin from "../main";
import type { AuthSession } from "../auth/types";
import type { ContextScope } from "../editor/ActiveFileContext";

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
	private activeFileEl: HTMLElement | null = null;
	private outputEl: HTMLElement | null = null;
	private promptInputEl: HTMLTextAreaElement | null = null;
	private includeContextEl: HTMLInputElement | null = null;
	private scopeEl: HTMLSelectElement | null = null;
	private replaceSelectionBtn: HTMLButtonElement | null = null;
	private appendBtn: HTMLButtonElement | null = null;
	private replaceNoteBtn: HTMLButtonElement | null = null;
	private lastAssistantText = "";

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

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("claude-chat-view");

		const titleEl = contentEl.createEl("h3", { text: "Claude chat" });
		titleEl.addClass("claude-chat-title");

		this.statusEl = contentEl.createEl("div", { cls: "claude-chat-status" });
		this.renderStatus(this.plugin.getChatAuthSession());

		this.activeFileEl = contentEl.createEl("div", { cls: "claude-chat-active-file" });
		this.renderActiveFileStatus();

		const contextControlsEl = contentEl.createEl("div", { cls: "claude-chat-context-controls" });
		const includeLabel = contextControlsEl.createEl("label", { cls: "claude-chat-inline-label" });
		this.includeContextEl = includeLabel.createEl("input", { type: "checkbox" });
		this.includeContextEl.checked = this.plugin.isActiveContextEnabledByDefault();
		includeLabel.appendText(" Include active note context");
		this.includeContextEl.addEventListener("change", () => this.renderActiveFileStatus());

		const scopeLabel = contextControlsEl.createEl("label", { cls: "claude-chat-inline-label" });
		scopeLabel.appendText("Scope:");
		this.scopeEl = scopeLabel.createEl("select", { cls: "claude-chat-scope-select" });
		this.scopeEl.createEl("option", { text: "Selection", value: "selection" });
		this.scopeEl.createEl("option", { text: "Whole note", value: "note" });
		this.scopeEl.value = this.plugin.getDefaultContextScope();
		this.scopeEl.addEventListener("change", () => this.renderActiveFileStatus());

		const controlsEl = contentEl.createEl("div", { cls: "claude-chat-controls" });

		const loginBtn = controlsEl.createEl("button", { text: "Sign in" });
		loginBtn.addEventListener("click", async () => {
			try {
				const session = await this.plugin.startChatLogin();
				this.renderStatus(session);
				this.appendOutput(`Auth result: ${this.describeSession(session)}`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendOutput(`Sign in failed: ${msg}`);
			}
		});

		const testBtn = controlsEl.createEl("button", { text: "Test connection" });
		testBtn.addEventListener("click", async () => {
			try {
				await this.plugin.testChatConnection();
				this.appendOutput("Connection test succeeded.");
				this.renderStatus(this.plugin.getChatAuthSession());
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendOutput(`Connection test failed: ${msg}`);
			}
		});

		const signOutBtn = controlsEl.createEl("button", { text: "Sign out" });
		signOutBtn.addEventListener("click", async () => {
			const session = await this.plugin.signOutChat();
			this.renderStatus(session);
			this.appendOutput("Signed out.");
		});

		this.promptInputEl = contentEl.createEl("textarea", { cls: "claude-chat-prompt" });
		this.promptInputEl.placeholder = "Ask Claude about your current note...";

		const sendBtn = contentEl.createEl("button", { text: "Send" });
		sendBtn.addClass("mod-cta");
		sendBtn.addEventListener("click", async () => {
			if (!this.promptInputEl) return;
			const prompt = this.promptInputEl.value.trim();
			if (!prompt) {
				new Notice("Enter a prompt first.");
				return;
			}

			this.appendOutput(`You: ${prompt}`);
			this.promptInputEl.value = "";

			try {
				const response = await this.plugin.sendChatPrompt(prompt, {
					includeActiveContext: this.includeContextEl?.checked ?? false,
					scope: this.getSelectedScope(),
				});
				this.lastAssistantText = response;
				this.appendOutput(`Claude: ${response}`);
				this.updateEditButtons();
				this.renderActiveFileStatus();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendOutput(`Claude error: ${msg}`);
			}
		});

		const editActions = contentEl.createEl("div", { cls: "claude-chat-edit-actions" });
		this.replaceSelectionBtn = editActions.createEl("button", { text: "Replace selection with last answer" });
		this.replaceSelectionBtn.addEventListener("click", () => this.handleReplaceSelection());

		this.appendBtn = editActions.createEl("button", { text: "Append last answer to note" });
		this.appendBtn.addEventListener("click", () => this.handleAppendToNote());

		this.replaceNoteBtn = editActions.createEl("button", { text: "Replace whole note with last answer" });
		this.replaceNoteBtn.addClass("mod-warning");
		this.replaceNoteBtn.addEventListener("click", () => this.handleReplaceWholeNote());

		this.outputEl = contentEl.createEl("div", { cls: "claude-chat-output" });
		this.appendOutput("Ready. Sign in, then test connection or send a prompt.");
		this.updateEditButtons();
	}

	private handleReplaceSelection(): void {
		if (!this.lastAssistantText.trim()) {
			new Notice("No assistant response available yet.");
			return;
		}
		try {
			const result = this.plugin.replaceSelectionWithAssistantText(this.lastAssistantText);
			new Notice("Selection replaced from chat response.");
			this.appendOutput(`Applied edit: replaced selection in ${result.filePath}`);
			this.renderActiveFileStatus();
			this.updateEditButtons();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendOutput(`Edit failed: ${msg}`);
		}
	}

	private handleAppendToNote(): void {
		if (!this.lastAssistantText.trim()) {
			new Notice("No assistant response available yet.");
			return;
		}
		try {
			const result = this.plugin.appendAssistantTextToActiveNote(this.lastAssistantText);
			new Notice("Assistant response appended to active note.");
			this.appendOutput(`Applied edit: appended to ${result.filePath}`);
			this.renderActiveFileStatus();
			this.updateEditButtons();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(msg);
			this.appendOutput(`Edit failed: ${msg}`);
		}
	}

	private handleReplaceWholeNote(): void {
		if (!this.lastAssistantText.trim()) {
			new Notice("No assistant response available yet.");
			return;
		}
		const applyChange = () => {
			try {
				const result = this.plugin.replaceWholeActiveNote(this.lastAssistantText);
				new Notice("Whole note replaced from chat response.");
				this.appendOutput(`Applied edit: replaced whole note ${result.filePath}`);
				this.renderActiveFileStatus();
				this.updateEditButtons();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendOutput(`Edit failed: ${msg}`);
			}
		};

		if (this.plugin.shouldConfirmWholeNoteReplace()) {
			new ConfirmReplaceModal(this.app, applyChange).open();
			return;
		}
		applyChange();
	}

	private updateEditButtons(): void {
		const state = this.plugin.getActiveMarkdownState();
		const hasLastAnswer = this.lastAssistantText.trim().length > 0;
		if (this.replaceSelectionBtn) {
			this.replaceSelectionBtn.disabled = !hasLastAnswer || !state.hasActiveMarkdown || !state.hasSelection;
		}
		if (this.appendBtn) {
			this.appendBtn.disabled = !hasLastAnswer || !state.hasActiveMarkdown;
		}
		if (this.replaceNoteBtn) {
			this.replaceNoteBtn.disabled = !hasLastAnswer || !state.hasActiveMarkdown;
		}
	}

	private renderActiveFileStatus(): void {
		if (!this.activeFileEl) return;
		const includeContext = this.includeContextEl?.checked ?? false;
		const scope = this.getSelectedScope();
		const context = this.plugin.getActiveContext(scope);
		if (!context) {
			this.activeFileEl.setText("Active note: none (open a markdown note to use context and edit actions).");
			this.updateEditButtons();
			return;
		}

		const contextLabel = includeContext
			? `context enabled (${context.scopeUsed}, ${context.content.length} chars${context.wasTruncated ? ", truncated" : ""})`
			: "context disabled";
		this.activeFileEl.setText(`Active note: ${context.filePath} — ${contextLabel}`);
		this.updateEditButtons();
	}

	private getSelectedScope(): ContextScope {
		if (this.scopeEl?.value === "note") {
			return "note";
		}
		return "selection";
	}

	private appendOutput(text: string): void {
		if (!this.outputEl) return;
		const line = this.outputEl.createEl("div", { cls: "claude-chat-line" });
		line.setText(text);
		this.outputEl.scrollTop = this.outputEl.scrollHeight;
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
