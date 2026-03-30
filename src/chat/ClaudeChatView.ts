import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type ObsidianAiPlugin from "../main";
import type { AuthSession } from "../auth/types";

export const CLAUDE_CHAT_VIEW_TYPE = "claude-chat-view";

export class ClaudeChatView extends ItemView {
	private plugin: ObsidianAiPlugin;
	private statusEl: HTMLElement | null = null;
	private outputEl: HTMLElement | null = null;
	private promptInputEl: HTMLTextAreaElement | null = null;

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
				const response = await this.plugin.sendChatPrompt(prompt);
				this.appendOutput(`Claude: ${response}`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				new Notice(msg);
				this.appendOutput(`Claude error: ${msg}`);
			}
		});

		this.outputEl = contentEl.createEl("div", { cls: "claude-chat-output" });
		this.appendOutput("Ready. Sign in, then test connection or send a prompt.");
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
