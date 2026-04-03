import { App, PluginSettingTab, Setting } from "obsidian";
import ObsidianAiPlugin from "./main";

export interface ObsidianAiSettings {
	authMode: "anthropic-api-key" | "claude-max";
	anthropicApiKey: string;
	defaultClaudeModel: string;
	chatSystemPrompt: string;
	requireConfirmForWholeNoteReplace: boolean;
	claudeOauthAccessToken: string;
	claudeOauthRefreshToken: string;
	claudeOauthExpiresAt: number;
	claudeOauthScopes: string[];
	claudeOauthAuthorizationCode: string;
}

export const DEFAULT_SETTINGS: ObsidianAiSettings = {
	authMode: "anthropic-api-key",
	anthropicApiKey: "",
	defaultClaudeModel: "claude-sonnet-4-5",
	chatSystemPrompt: "You are a concise assistant helping with Obsidian notes.",
	requireConfirmForWholeNoteReplace: true,
	claudeOauthAccessToken: "",
	claudeOauthRefreshToken: "",
	claudeOauthExpiresAt: 0,
	claudeOauthScopes: [],
	claudeOauthAuthorizationCode: ""
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

		new Setting(containerEl)
			.setName("Chat auth mode")
			.setDesc("Choose Claude Max account OAuth or Anthropic API key fallback.")
			.addDropdown((dropdown) => dropdown
				.addOption("anthropic-api-key", "Anthropic API key")
				.addOption("claude-max", "Claude Max account")
				.setValue(this.plugin.settings.authMode)
				.onChange(async (value) => {
					this.plugin.settings.authMode = value as "anthropic-api-key" | "claude-max";
					await this.plugin.saveSettings();
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
			.setName("Claude model")
			.setDesc("Default model ID for chat requests.")
			.addText((text) => text
				.setPlaceholder("claude-sonnet-4-5")
				.setValue(this.plugin.settings.defaultClaudeModel)
				.onChange(async (value) => {
					this.plugin.settings.defaultClaudeModel = value.trim() || "claude-sonnet-4-5";
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Claude OAuth code")
			.setDesc("Paste the full callback URL or code=... after clicking Sign in in the chat panel.")
			.addTextArea((text) => text
				.setPlaceholder("https://console.anthropic.com/oauth/code/callback?code=...")
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
