import { Notice, Plugin } from "obsidian";
import { AuthController } from "./auth/AuthController";
import { AuthSession } from "./auth/types";
import { ClaudeChatClient } from "./chat/ClaudeChatClient";
import { ClaudeSdkBridge } from "./chat/ClaudeSdkBridge";
import { CLAUDE_CHAT_VIEW_TYPE, ClaudeChatView } from "./chat/ClaudeChatView";
import { DEFAULT_SETTINGS, ObsidianAiSettings, ObsidianAiSettingTab } from "./settings";

export default class ObsidianAiPlugin extends Plugin {
	settings: ObsidianAiSettings;
	private authController!: AuthController;
	private chatClient!: ClaudeChatClient;
	private sdkBridge!: ClaudeSdkBridge;

	async onload() {
		await this.loadSettings();
		this.authController = new AuthController(this.settings);
		this.chatClient = new ClaudeChatClient();
		this.sdkBridge = new ClaudeSdkBridge(this);

		this.registerView(CLAUDE_CHAT_VIEW_TYPE, (leaf) => new ClaudeChatView(leaf, this));
		this.addSettingTab(new ObsidianAiSettingTab(this.app, this));

		this.addCommand({
			id: "claude-chat-open-panel",
			name: "Claude chat: Open panel",
			callback: () => {
				void this.activateChatView();
			}
		});

		this.addCommand({
			id: "claude-chat-sign-in",
			name: "Claude chat: Sign in",
			callback: () => {
				void this.startChatLogin();
			}
		});

		this.addCommand({
			id: "claude-chat-test-connection",
			name: "Claude chat: Test connection",
			callback: () => {
				void this.testChatConnection();
			}
		});
	}

	async onunload() {
		await this.app.workspace.detachLeavesOfType(CLAUDE_CHAT_VIEW_TYPE);
	}

	private async activateChatView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CLAUDE_CHAT_VIEW_TYPE);
		const existingLeaf = existing[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: CLAUDE_CHAT_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	getChatAuthSession(): AuthSession {
		return this.authController.getSession();
	}

	async startChatLogin(): Promise<AuthSession> {
		const session = await this.authController.startLogin();
		await this.saveSettings();
		return session;
	}

	async signOutChat(): Promise<AuthSession> {
		const session = await this.authController.logout();
		await this.saveSettings();
		return session;
	}

	async testChatConnection(): Promise<void> {
		if (this.settings.authMode === "claude-max") {
			const runtimeEnv = await this.authController.getRuntimeEnv();
			if (!runtimeEnv?.CLAUDE_CODE_OAUTH_TOKEN) {
				throw new Error("No Claude Max OAuth token available. Complete sign-in first.");
			}
			const adapterWithBasePath = this.app.vault.adapter as unknown as { getBasePath?: () => string };
			const vaultBasePath = adapterWithBasePath.getBasePath?.();
			if (!vaultBasePath) {
				throw new Error("Cannot resolve local vault path for Claude SDK bridge.");
			}
			await this.sdkBridge.ping(runtimeEnv);
			await this.sdkBridge.chat({
				prompt: "Reply with exactly: OK",
				model: this.settings.defaultClaudeModel,
				systemPrompt: this.settings.chatSystemPrompt,
				cwd: vaultBasePath,
				env: runtimeEnv,
			});
			new Notice("Connection test succeeded");
			return;
		}

		const authHeaders = await this.authController.getAuthHeaders();
		if (!authHeaders) {
			throw new Error("No auth token available. Configure an Anthropic API key or complete Claude Max login.");
		}

		await this.chatClient.testConnection({
			authHeaders,
			model: this.settings.defaultClaudeModel,
			systemPrompt: this.settings.chatSystemPrompt
		});
		new Notice("Connection test succeeded");
	}

	async sendChatPrompt(prompt: string): Promise<string> {
		if (this.settings.authMode === "claude-max") {
			const runtimeEnv = await this.authController.getRuntimeEnv();
			if (!runtimeEnv?.CLAUDE_CODE_OAUTH_TOKEN) {
				throw new Error("No Claude Max OAuth token available. Complete sign-in first.");
			}
			const adapterWithBasePath = this.app.vault.adapter as unknown as { getBasePath?: () => string };
			const vaultBasePath = adapterWithBasePath.getBasePath?.();
			if (!vaultBasePath) {
				throw new Error("Cannot resolve local vault path for Claude SDK bridge.");
			}
			return this.sdkBridge.chat({
				prompt,
				model: this.settings.defaultClaudeModel,
				systemPrompt: this.settings.chatSystemPrompt,
				cwd: vaultBasePath,
				env: runtimeEnv,
			});
		}

		const authHeaders = await this.authController.getAuthHeaders();
		if (!authHeaders) {
			throw new Error("No auth token available. Configure an Anthropic API key or complete Claude Max login.");
		}

		return this.chatClient.sendMessage({
			authHeaders,
			model: this.settings.defaultClaudeModel,
			systemPrompt: this.settings.chatSystemPrompt,
			prompt
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ObsidianAiSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
