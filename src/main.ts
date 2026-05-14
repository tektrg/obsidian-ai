import { Notice, Plugin, TFile } from "obsidian";
import { AuthController } from "./auth/AuthController";
import type { AuthMode, AuthSession } from "./auth/types";
import { BridgeFactory } from "./chat/BridgeFactory";
import type { BaseBridge } from "./chat/BaseBridge";
import type { BridgeStreamEvent, ChatModelOption, PiAuth } from "./chat/types";
import { CLAUDE_CHAT_VIEW_TYPE, ClaudeChatView } from "./chat/ClaudeChatView";
import { ActiveFileContextService, PromptContextSnapshot, formatPromptWithContext } from "./editor/ActiveFileContext";
import { EditorChangeApplier } from "./editor/EditorChangeApplier";
import { DEFAULT_SETTINGS, ObsidianAiSettings, ObsidianAiSettingTab } from "./settings";
import type { FileChange } from "./types/diff";

const CLAUDE_MODEL_LABELS: Record<string, string> = {
	"claude-sonnet-4-5": "Sonnet 4.5",
	"claude-sonnet-4-5-20250929": "Sonnet 4.5",
	"claude-opus-4-6": "Opus 4.6",
	"claude-opus-4-6-20251014": "Opus 4.6",
	"claude-haiku-4-5": "Haiku 4.5",
	"claude-haiku-4-5-20250929": "Haiku 4.5",
};

const PI_MODEL_LABELS: Record<string, string> = {
	auto: "Auto",
	"openai-codex/gpt-5.5": "GPT-5.5",
	"openai-codex/gpt-5.4": "GPT-5.4",
	"openai-codex/gpt-5.3-codex": "GPT-5.3 Codex",
};

const DEFAULT_MODEL_BY_PROVIDER: Record<AuthMode, string> = {
	"anthropic-api-key": "claude-sonnet-4-5-20250929",
	"claude-max": "claude-sonnet-4-5-20250929",
	"chatgpt-plus": "auto",
};

export default class ObsidianAiPlugin extends Plugin {
	settings: ObsidianAiSettings;
	private authController!: AuthController;
	private activeFileContextService!: ActiveFileContextService;
	private editorChangeApplier!: EditorChangeApplier;

	// Turn-based diff tracking (at plugin level to survive view reloads)
	turnSnapshot: PromptContextSnapshot | null = null;
	turnHasEdits = false;
	editedFiles: { filePath: string; original: string; modified?: string; error?: string }[] = [];

	async onload() {
		await this.loadSettings();
		this.authController = new AuthController(this.settings);
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
		BridgeFactory.clearCache();
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

	getActiveModelOptions(): ChatModelOption[] {
		const bridgeType = this.authController.getBridgeType();
		const capabilities = this.getActiveBridge().getCapabilities();
		const optionMap = bridgeType === "pi" ? PI_MODEL_LABELS : CLAUDE_MODEL_LABELS;
		return capabilities.availableModels.map((id) => ({
			id,
			label: optionMap[id] ?? id,
		}));
	}

	getSelectedChatModel(): string {
		return this.getChatModel();
	}

	async setSelectedChatModel(model: string): Promise<void> {
		const nextModel = model.trim();
		if (!nextModel) return;

		const allowedModels = new Set(this.getActiveBridge().getCapabilities().availableModels);
		if (!allowedModels.has(nextModel)) return;

		this.settings.selectedModelsByProvider[this.authController.getMode()] = nextModel;
		await this.saveSettings();
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
		const runtimeEnv = await this.getRuntimeEnvAndSave();
		if (!runtimeEnv) {
			throw new Error("No auth token available. Configure an Anthropic API key or complete Claude Max login.");
		}
		if (this.settings.authMode === "claude-max" && !runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN) {
			throw new Error("No Claude Max OAuth token available. Complete sign-in first.");
		}
		const adapterWithBasePath = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vaultBasePath = adapterWithBasePath.getBasePath?.();
		if (!vaultBasePath) {
			throw new Error("Cannot resolve local vault path for chat bridge.");
		}
		const bridge = this.getActiveBridge();
		const piAuth = await this.getActivePiAuth();
		const model = this.getChatModel();
		await bridge.ping(runtimeEnv, vaultBasePath);
		await bridge.chat({
			prompt: "Reply with exactly: OK",
			model,
			systemPrompt: this.settings.chatSystemPrompt,
			cwd: vaultBasePath,
			env: runtimeEnv,
		}, piAuth);
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
			const runtimeEnv = await this.getRuntimeEnvAndSave();
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

		const runtimeEnv = await this.getRuntimeEnvAndSave();
		if (!runtimeEnv) {
			throw new Error("No auth token available. Configure an Anthropic API key or complete Claude Max login.");
		}
		if (this.settings.authMode === "claude-max" && !runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN) {
			throw new Error("No Claude Max OAuth token available. Complete sign-in first.");
		}
		const adapterWithBasePath = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vaultBasePath = adapterWithBasePath.getBasePath?.();
		if (!vaultBasePath) {
			throw new Error("Cannot resolve local vault path for chat bridge.");
		}
		const bridge = this.getActiveBridge();
		const piAuth = await this.getActivePiAuth();
		const model = this.getChatModel();
		const result = await bridge.chatStream({
			prompt: finalPrompt,
			model,
			systemPrompt: this.settings.chatSystemPrompt,
			cwd: vaultBasePath,
			env: runtimeEnv,
			activeFilePath: activeFilePath,
		}, piAuth, handlers);
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
		this.editedFiles = [];
	}

	/**
	 * Track a file edit for diff comparison
	 */
	trackFileEdit(filePath: string, original: string, modified?: string, error?: string): void {
		const existing = this.editedFiles.find(f => f.filePath === filePath);
		if (existing) {
			// Keep original, update modified/error
			existing.modified = modified ?? existing.modified;
			existing.error = error ?? existing.error;
		} else {
			this.editedFiles.push({ filePath, original, modified, error });
		}
		this.turnHasEdits = true;
	}

	/**
	 * Get all file changes for the current turn
	 */
	async getTurnFileChanges(): Promise<FileChange[]> {
		const changes: FileChange[] = [];
		let id = 0;

		for (const data of this.editedFiles) {
			// Get current content if not already tracked
			let modified = data.modified;
			if (modified === undefined && !data.error) {
				const current = await this.getCurrentFileContent(data.filePath);
				if (current) {
					modified = current.fullContent;
				}
			}

			changes.push({
				id: `change-${id++}`,
				filePath: data.filePath,
				toolType: 'Edit',
				original: data.original,
				modified: modified ?? '',
				error: data.error,
			});
		}

		// Fallback to snapshot files if no tracked edits
		if (changes.length === 0 && this.turnSnapshot) {
			for (const file of this.turnSnapshot.files) {
				const current = await this.getCurrentFileContent(file.filePath);
				if (current && current.fullContent !== file.fullContent) {
					changes.push({
						id: `change-${id++}`,
						filePath: file.filePath,
						toolType: 'Edit',
						original: file.fullContent,
						modified: current.fullContent,
					});
				}
			}
		}

		return changes;
	}

	/**
	 * Stop the active generation if any.
	 * Returns true if a generation was stopped.
	 */
	stopGeneration(): boolean {
		return this.getActiveBridge().stop();
	}

	refreshChatViewsSettingsState(): void {
		const leaves = this.app.workspace.getLeavesOfType(CLAUDE_CHAT_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof ClaudeChatView) {
				leaf.view.refreshSettingsState();
			}
		}
	}

	private getActiveBridge(): BaseBridge {
		return BridgeFactory.getBridge(this.authController.getBridgeType(), this);
	}

	private async getActivePiAuth(): Promise<PiAuth | undefined> {
		if (this.authController.getBridgeType() !== "pi") {
			return undefined;
		}
		const piAuth = await this.authController.getPiAuth();
		if (!piAuth) {
			throw new Error("No ChatGPT Plus OAuth token available. Complete Codex sign-in first.");
		}
		return piAuth;
	}

	private getChatModel(): string {
		const mode = this.authController.getMode();
		const selectedModel = this.settings.selectedModelsByProvider[mode];
		const allowedModels = this.getActiveBridge().getCapabilities().availableModels;
		if (selectedModel && allowedModels.includes(selectedModel)) {
			return selectedModel;
		}

		const defaultModel = DEFAULT_MODEL_BY_PROVIDER[mode] || this.authController.getDefaultModel();
		if (allowedModels.includes(defaultModel)) {
			return defaultModel;
		}

		return allowedModels[0] ?? this.authController.getDefaultModel();
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
		const loaded = (await this.loadData()) as Partial<ObsidianAiSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.selectedModelsByProvider = {
			...DEFAULT_SETTINGS.selectedModelsByProvider,
			...loaded?.selectedModelsByProvider,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async getRuntimeEnvAndSave(): Promise<Record<string, string> | null> {
		const runtimeEnv = await this.authController.getRuntimeEnv();
		await this.saveSettings();
		return runtimeEnv;
	}
}
