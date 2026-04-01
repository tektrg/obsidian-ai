import { Notice, Plugin } from "obsidian";
import { AuthController } from "./auth/AuthController";
import { AuthSession } from "./auth/types";
import { ClaudeChatClient } from "./chat/ClaudeChatClient";
import { BridgeStreamEvent, ClaudeSdkBridge } from "./chat/ClaudeSdkBridge";
import { CLAUDE_CHAT_VIEW_TYPE, ClaudeChatView } from "./chat/ClaudeChatView";
import { ActiveFileContextService, formatPromptWithActiveContext } from "./editor/ActiveFileContext";
import { EditorChangeApplier } from "./editor/EditorChangeApplier";
import { DEFAULT_SETTINGS, ObsidianAiSettings, ObsidianAiSettingTab } from "./settings";

export default class ObsidianAiPlugin extends Plugin {
	settings: ObsidianAiSettings;
	private authController!: AuthController;
	private chatClient!: ClaudeChatClient;
	private sdkBridge!: ClaudeSdkBridge;
	private activeFileContextService!: ActiveFileContextService;
	private editorChangeApplier!: EditorChangeApplier;

	async onload() {
		await this.loadSettings();
		this.authController = new AuthController(this.settings);
		this.chatClient = new ClaudeChatClient();
		this.sdkBridge = new ClaudeSdkBridge(this);
		this.activeFileContextService = new ActiveFileContextService(this.app);
		this.editorChangeApplier = new EditorChangeApplier(this.app);

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

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshChatViewsActiveContext()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshChatViewsActiveContext()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshChatViewsActiveContext()));
	}

	async onunload() {
		// Don't detach leaves here - let the workspace layout persist across reloads
		// The views will be reconnected when the plugin reloads
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

	shouldConfirmWholeNoteReplace(): boolean {
		return this.settings.requireConfirmForWholeNoteReplace;
	}

	getActiveMarkdownState(): { hasActiveMarkdown: boolean; filePath?: string; hasSelection: boolean } {
		return this.editorChangeApplier.getActiveMarkdownState();
	}

	getActiveContext() {
		return this.activeFileContextService.getActiveContext({
			maxFullContentChars: this.settings.activeNoteContextMaxFullChars,
			maxSelectionChars: this.settings.activeNoteContextMaxSelectionChars,
		});
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
		const runtimeEnv = await this.authController.getRuntimeEnv();
		if (!runtimeEnv) {
			throw new Error("No auth token available. Configure an Anthropic API key or complete Claude Max login.");
		}
		if (this.settings.authMode === "claude-max" && !runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN) {
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
	}

	/**
	 * Validate authentication before making API calls.
	 * Returns validation result with user-friendly message.
	 */
	async validateAuth(): Promise<{ valid: boolean; message: string }> {
		const session = this.authController.getSession();

		if (session.status !== "signed-in") {
			return {
				valid: false,
				message: 'Not authenticated. Click "Sign in" to authenticate with Claude, or configure an API key in settings.'
			};
		}

		// Try to get runtime env - this will trigger token refresh if needed
		try {
			const runtimeEnv = await this.authController.getRuntimeEnv();
			if (!runtimeEnv) {
				return {
					valid: false,
					message: 'Authentication failed. Your session may have expired. Click "Sign out" then "Sign in" to re-authenticate.'
				};
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("refresh") || msg.includes("expired")) {
				return {
					valid: false,
					message: 'Session expired and could not be refreshed. Click "Sign out" then "Sign in" to re-authenticate.'
				};
			}
			return {
				valid: false,
				message: `Authentication error: ${msg}. Try signing out and signing in again.`
			};
		}

		return { valid: true, message: "" };
	}

	async sendChatPrompt(prompt: string, options?: { includeActiveContext?: boolean }): Promise<string> {
		const result = await this.sendChatPromptStream(prompt, options);
		return result.text;
	}

	async sendChatPromptStream(
		prompt: string,
		options?: { includeActiveContext?: boolean },
		handlers?: { onEvent?: (event: BridgeStreamEvent) => void }
	): Promise<{ text: string; fileChanged?: boolean; editedFilePath?: string }> {
		const includeContext = options?.includeActiveContext !== false; // default to true
		const context = includeContext ? this.getActiveContext() : null;
		const finalPrompt = context ? formatPromptWithActiveContext(prompt, context) : prompt;
		const activeFilePath = context?.filePath;

		const runtimeEnv = await this.authController.getRuntimeEnv();
		if (!runtimeEnv) {
			throw new Error("No auth token available. Configure an Anthropic API key or complete Claude Max login.");
		}
		if (this.settings.authMode === "claude-max" && !runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN) {
			throw new Error("No Claude Max OAuth token available. Complete sign-in first.");
		}
		const adapterWithBasePath = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vaultBasePath = adapterWithBasePath.getBasePath?.();
		if (!vaultBasePath) {
			throw new Error("Cannot resolve local vault path for Claude SDK bridge.");
		}
		const result = await this.sdkBridge.chatStream({
			prompt: finalPrompt,
			model: this.settings.defaultClaudeModel,
			systemPrompt: this.settings.chatSystemPrompt,
			cwd: vaultBasePath,
			env: runtimeEnv,
			activeFilePath: activeFilePath,
		}, handlers);
		if (result.fileChanged) {
			const editedPath = result.editedFilePath ?? activeFilePath ?? "active note";
			return {
				...result,
				text: `${result.text}\n\n✅ Updated note: ${editedPath}`,
			};
		}
		return result;
	}

	replaceSelectionWithAssistantText(content: string) {
		return this.editorChangeApplier.replaceSelection(content);
	}

	appendAssistantTextToActiveNote(content: string) {
		return this.editorChangeApplier.appendToNote(content);
	}

	replaceWholeActiveNote(content: string) {
		return this.editorChangeApplier.replaceWholeNote(content);
	}

	private refreshChatViewsActiveContext(): void {
		const leaves = this.app.workspace.getLeavesOfType(CLAUDE_CHAT_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof ClaudeChatView) {
				leaf.view.refreshActiveContext();
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ObsidianAiSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
