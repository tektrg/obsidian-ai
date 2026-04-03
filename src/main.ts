import { Notice, Plugin } from "obsidian";
import { AuthController } from "./auth/AuthController";
import { AuthSession } from "./auth/types";
import { BridgeStreamEvent, ClaudeSdkBridge } from "./chat/ClaudeSdkBridge";
import { CLAUDE_CHAT_VIEW_TYPE, ClaudeChatView } from "./chat/ClaudeChatView";
import { ActiveFileContextService, PromptContextSnapshot, formatPromptWithContext } from "./editor/ActiveFileContext";
import { EditorChangeApplier } from "./editor/EditorChangeApplier";
import { DEFAULT_SETTINGS, ObsidianAiSettings, ObsidianAiSettingTab } from "./settings";

export default class ObsidianAiPlugin extends Plugin {
	settings: ObsidianAiSettings;
	private authController!: AuthController;
	private sdkBridge!: ClaudeSdkBridge;
	private activeFileContextService!: ActiveFileContextService;
	private editorChangeApplier!: EditorChangeApplier;

	// Turn-based diff tracking (at plugin level to survive view reloads)
	turnSnapshot: PromptContextSnapshot | null = null;
	turnHasEdits = false;

	async onload() {
		await this.loadSettings();
		this.authController = new AuthController(this.settings);
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

		this.addCommand({
			id: "claude-chat-new-conversation",
			name: "Claude chat: New conversation",
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(CLAUDE_CHAT_VIEW_TYPE);
				for (const leaf of leaves) {
					if (leaf.view instanceof ClaudeChatView) {
						leaf.view.clearConversation();
					}
				}
				new Notice("New conversation started");
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

	getActiveMarkdownState(): { hasActiveMarkdown: boolean; filePath?: string; hasSelection: boolean } {
		return this.editorChangeApplier.getActiveMarkdownState();
	}

	getActiveContextSnapshot() {
		return this.activeFileContextService.captureContextSnapshot();
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
			const normalized = msg.toLowerCase();
			if (normalized.includes("revoked") || normalized.includes("invalid_grant") || normalized.includes("invalid refresh")) {
				return {
					valid: false,
					message: 'Your Claude session was revoked or invalid. Click "Sign in" to re-authenticate.'
				};
			}
			if (normalized.includes("refresh") || normalized.includes("expired")) {
				return {
					valid: false,
					message: 'Session expired and could not be refreshed. Click "Sign out" then "Sign in" to re-authenticate.'
				};
			}
			if (normalized.includes("network") || normalized.includes("timeout") || normalized.includes("fetch")) {
				return {
					valid: false,
					message: 'Temporary network error while validating authentication. Please try again.'
				};
			}
			return {
				valid: false,
				message: `Authentication error: ${msg}. Try signing in again.`
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

		// Clear and capture canonical turn snapshot before prompt send
		this.clearTurnSnapshot();
		const contextSnapshot = includeContext ? this.getActiveContextSnapshot() : null;
		if (contextSnapshot) {
			this.saveTurnSnapshot(contextSnapshot);
		}

		const finalPrompt = contextSnapshot ? formatPromptWithContext(prompt, contextSnapshot) : prompt;
		const activeFilePath = contextSnapshot?.primaryFilePath;

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

	/**
	 * Save turn snapshot for diff comparison
	 */
	saveTurnSnapshot(snapshot: PromptContextSnapshot): void {
		this.turnSnapshot = snapshot;
	}

	/**
	 * Clear turn snapshot
	 */
	clearTurnSnapshot(): void {
		this.turnSnapshot = null;
		this.turnHasEdits = false;
	}

	/**
	 * Stop the active generation if any.
	 * Returns true if a generation was stopped.
	 */
	stopGeneration(): boolean {
		return this.sdkBridge.stop();
	}

	/**
	 * Get current content for a file path using editor-first, vault-fallback strategy.
	 */
	async getCurrentFileContent(filePath: string) {
		return this.activeFileContextService.getCurrentFileContent(filePath);
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
