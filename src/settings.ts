import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { AuthMode } from "./auth/types";
import ObsidianAiPlugin from "./main";

export interface ObsidianAiSettings {
	authMode: "anthropic-api-key" | "claude-max" | "chatgpt-plus";
	anthropicApiKey: string;
	defaultClaudeModel: string;
	defaultPiModel: string;
	selectedModelsByProvider: Partial<Record<AuthMode, string>>;
	chatSystemPrompt: string;
	requireConfirmForWholeNoteReplace: boolean;
	/** Persisted Claude SDK session id so the chat panel resumes context across restarts. */
	chatSessionId: string;

	// Claude Max OAuth
	claudeOauthAccessToken: string;
	claudeOauthRefreshToken: string;
	claudeOauthExpiresAt: number;
	claudeOauthScopes: string[];
	claudeOauthAuthorizationCode: string;
	claudeOauthPendingState: string;
	claudeOauthPendingCodeVerifier: string;
	claudeOauthPendingExpiresAt: number;

	// ChatGPT Plus OAuth
	chatgptAccessToken: string;
	chatgptRefreshToken: string;
	chatgptIdToken: string;
	chatgptExpiresAt: number;

	onboardingCompleted: boolean;
}

export const DEFAULT_SETTINGS: ObsidianAiSettings = {
	authMode: "anthropic-api-key",
	anthropicApiKey: "",
	defaultClaudeModel: "claude-sonnet-4-5",
	defaultPiModel: "auto",
	selectedModelsByProvider: {
		"anthropic-api-key": "claude-sonnet-4-5-20250929",
		"claude-max": "claude-sonnet-4-5-20250929",
		"chatgpt-plus": "auto",
	},
	chatSystemPrompt: "You are a concise assistant helping with Obsidian notes.",
	requireConfirmForWholeNoteReplace: true,
	chatSessionId: "",

	// Claude Max OAuth
	claudeOauthAccessToken: "",
	claudeOauthRefreshToken: "",
	claudeOauthExpiresAt: 0,
	claudeOauthScopes: [],
	claudeOauthAuthorizationCode: "",
	claudeOauthPendingState: "",
	claudeOauthPendingCodeVerifier: "",
	claudeOauthPendingExpiresAt: 0,

	// ChatGPT Plus OAuth
	chatgptAccessToken: "",
	chatgptRefreshToken: "",
	chatgptIdToken: "",
	chatgptExpiresAt: 0,

	onboardingCompleted: false,
};

export class ObsidianAiSettingTab extends PluginSettingTab {
	plugin: ObsidianAiPlugin;

	constructor(app: App, plugin: ObsidianAiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const selectedModels = this.plugin.settings.selectedModelsByProvider;

		new Setting(containerEl)
			.setName("Chat auth mode")
			.setDesc("Choose your preferred AI provider. Claude Max and ChatGPT Plus use OAuth. API key is direct.")
			.addDropdown((dropdown) => dropdown
				.addOption("anthropic-api-key", "Anthropic API key")
				.addOption("claude-max", "Claude Max account")
				.addOption("chatgpt-plus", "ChatGPT Plus (Codex)")
				.setValue(this.plugin.settings.authMode)
				.onChange(async (value) => {
					const prevMode = this.plugin.settings.authMode;
					const prevSession = this.plugin.getChatAuthSession();
					this.plugin.settings.authMode = value as "anthropic-api-key" | "claude-max" | "chatgpt-plus";
					await this.plugin.saveSettings();
					this.plugin.refreshChatViewsSettingsState();
					if (prevSession.status === "signed-in" && value !== prevMode) {
						const labels: Record<string, string> = {
							"anthropic-api-key": "API key",
							"claude-max": "Claude Max",
							"chatgpt-plus": "ChatGPT Plus",
						};
						new Notice(
							`Switched to ${labels[value] ?? value}. Your ${labels[prevMode] ?? prevMode} session is still stored — switch back to restore it.`
						);
					}
				}));

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Used by API key auth mode and as fallback when Claude Max account login is unavailable.")
			.addText((text) => text
				.setPlaceholder("sk-ant-api03-...")
				.setValue(this.plugin.settings.anthropicApiKey)
				.onChange(async (value) => {
					this.plugin.settings.anthropicApiKey = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Anthropic API key model")
			.setDesc("Default model for Anthropic API key requests.")
			.addText((text) => text
				.setPlaceholder("claude-sonnet-4-5-20250929")
				.setValue(selectedModels["anthropic-api-key"] ?? "claude-sonnet-4-5-20250929")
				.onChange(async (value) => {
					selectedModels["anthropic-api-key"] = value.trim() || "claude-sonnet-4-5-20250929";
					this.plugin.settings.defaultClaudeModel = selectedModels["anthropic-api-key"];
					await this.plugin.saveSettings();
					this.plugin.refreshChatViewsSettingsState();
				}));

		new Setting(containerEl)
			.setName("Claude Max model")
			.setDesc("Default model for Claude Max account requests.")
			.addText((text) => text
				.setPlaceholder("claude-sonnet-4-5-20250929")
				.setValue(selectedModels["claude-max"] ?? "claude-sonnet-4-5-20250929")
				.onChange(async (value) => {
					selectedModels["claude-max"] = value.trim() || "claude-sonnet-4-5-20250929";
					await this.plugin.saveSettings();
					this.plugin.refreshChatViewsSettingsState();
				}));

		new Setting(containerEl)
			.setName("ChatGPT/Pi model")
			.setDesc("Default model for ChatGPT Plus/Codex requests.")
			.addText((text) => text
				.setPlaceholder("auto")
				.setValue(selectedModels["chatgpt-plus"] ?? "auto")
				.onChange(async (value) => {
					selectedModels["chatgpt-plus"] = value.trim() || "auto";
					this.plugin.settings.defaultPiModel = selectedModels["chatgpt-plus"];
					await this.plugin.saveSettings();
					this.plugin.refreshChatViewsSettingsState();
				}));

		new Setting(containerEl)
			.setName("Claude OAuth code")
			.setDesc("Paste the full callback URL or code=... after clicking Sign in in the chat panel.")
			.addTextArea((text) => text
				.setPlaceholder("https://platform.claude.com/oauth/code/callback?code=...")
				.setValue(this.plugin.settings.claudeOauthAuthorizationCode)
				.onChange(async (value) => {
					this.plugin.settings.claudeOauthAuthorizationCode = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Chat system prompt")
			.setDesc("Optional system prompt prepended to chat requests.")
			.addTextArea((text) => text
				.setPlaceholder("You are a concise assistant helping with Obsidian notes.")
				.setValue(this.plugin.settings.chatSystemPrompt)
				.onChange(async (value) => {
					this.plugin.settings.chatSystemPrompt = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName("Confirm before replacing whole note")
			.setDesc("Require a confirmation modal before replacing the entire active note from chat output.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.requireConfirmForWholeNoteReplace)
				.onChange(async (value) => {
					this.plugin.settings.requireConfirmForWholeNoteReplace = value;
					await this.plugin.saveSettings();
				}));
	}
}
