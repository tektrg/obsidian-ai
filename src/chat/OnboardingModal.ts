import { Modal, Notice, setIcon } from "obsidian";
import type ObsidianAiPlugin from "../main";
import { AuthCardView } from "./AuthCardView";
import { ClaudeMaxLoginCoordinator } from "../auth/ClaudeMaxLoginCoordinator";

interface ProviderOption {
	id: "anthropic-api-key" | "claude-max" | "chatgpt-plus";
	name: string;
	desc: string;
	icon: string;
}

const PROVIDERS: ProviderOption[] = [
	{ id: "claude-max", name: "Claude Max", desc: "OAuth — requires Claude Max subscription", icon: "cpu" },
	{ id: "chatgpt-plus", name: "ChatGPT Plus", desc: "OAuth — requires ChatGPT Plus subscription", icon: "message-circle" },
	{ id: "anthropic-api-key", name: "Anthropic API key", desc: "Direct API access — pay-per-use", icon: "key" },
];

export class OnboardingModal extends Modal {
	private plugin: ObsidianAiPlugin;
	private onComplete: () => void;
	private selectedProvider: ProviderOption["id"] = "claude-max";
	private authCardView: AuthCardView | null = null;
	private isClosed = false;

	constructor(plugin: ObsidianAiPlugin, onComplete: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onComplete = onComplete;
	}

	onOpen(): void {
		this.modalEl.addClass("onboarding-modal");
		this.render();
	}

	onClose(): void {
		this.isClosed = true;
		if (this.authCardView) {
			this.authCardView.destroy();
			this.authCardView = null;
		}
		// Mark as completed (including "Skip for now") so the modal doesn't reappear
		this.plugin.settings.onboardingCompleted = true;
		void this.plugin.saveSettings();
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { cls: "onboarding-title", text: "Connect your AI provider" });
		contentEl.createEl("p", {
			cls: "onboarding-subtitle",
			text: "Choose how you want to connect. You can change this later in Settings.",
		});

		const pickList = contentEl.createDiv({ cls: "onboarding-provider-pick" });

		for (const provider of PROVIDERS) {
			const option = pickList.createDiv({ cls: "onboarding-provider-option" });
			if (provider.id === this.selectedProvider) option.addClass("is-selected");

			const iconEl = option.createSpan();
			setIcon(iconEl, provider.icon);

			const labelEl = option.createDiv({ cls: "onboarding-provider-label" });
			labelEl.createDiv({ cls: "onboarding-provider-name", text: provider.name });
			labelEl.createDiv({ cls: "onboarding-provider-desc", text: provider.desc });

			option.addEventListener("click", () => {
				this.selectedProvider = provider.id;
				pickList.querySelectorAll(".onboarding-provider-option").forEach((el) => el.removeClass("is-selected"));
				option.addClass("is-selected");
			});
		}

		const authHost = contentEl.createDiv({ cls: "onboarding-auth-host" });

		const footer = contentEl.createDiv({ cls: "onboarding-footer" });

		const skipBtn = footer.createEl("button", { cls: "onboarding-btn", text: "Skip for now" });
		skipBtn.addEventListener("click", () => this.close());

		const connectBtn = footer.createEl("button", {
			cls: "onboarding-btn onboarding-btn--primary",
			text: "Connect",
		});
		connectBtn.addEventListener("click", () => this.handleConnect(authHost, footer, connectBtn));
	}

	private handleConnect(authHost: HTMLElement, footer: HTMLElement, connectBtn: HTMLButtonElement): void {
		authHost.empty();
		footer.remove();

		if (this.selectedProvider === "anthropic-api-key") {
			this.renderApiKeyFlow(authHost);
			return;
		}

		if (this.selectedProvider === "claude-max") {
			this.renderClaudeMaxFlow(authHost);
			return;
		}

		if (this.selectedProvider === "chatgpt-plus") {
			this.renderChatGptFlow(authHost);
			return;
		}
	}

	private renderApiKeyFlow(host: HTMLElement): void {
		host.createDiv({ cls: "onboarding-provider-name", text: "Enter your API key" });

		const input = host.createEl("input", {
			cls: "onboarding-api-input",
			attr: { type: "text", placeholder: "sk-ant-api03-…" },
		});
		input.focus();

		const errorEl = host.createDiv({ cls: "auth-card-error" });
		errorEl.addClass("claude-chat-hidden");

		const footer = this.contentEl.createDiv({ cls: "onboarding-footer" });
		const saveBtn = footer.createEl("button", { cls: "onboarding-btn onboarding-btn--primary", text: "Save" });

		const doSave = async () => {
			const key = input.value.trim();
			if (!key.startsWith("sk-")) {
				errorEl.setText("API keys start with sk-ant-api03-…");
				errorEl.removeClass("claude-chat-hidden");
				return;
			}
			this.plugin.settings.anthropicApiKey = key;
			await this.plugin.saveSettings();
			if (this.isClosed) return;
			this.renderSuccess(host, footer);
		};

		saveBtn.addEventListener("click", () => void doSave());
		input.addEventListener("keydown", (evt) => { if (evt.key === "Enter") void doSave(); });
	}

	private renderClaudeMaxFlow(host: HTMLElement): void {
		// Create a dummy input element for AuthCardView (it won't actually hide anything in the modal)
		const dummy = host.createDiv();
		dummy.addClass("claude-chat-hidden");
		this.authCardView = new AuthCardView(host, dummy);

		const coordinator = new ClaudeMaxLoginCoordinator(this.plugin);
		this.authCardView.show({ kind: "claude-max-step1" });

		void coordinator.beginLogin({
			onBrowserOpened: () => {
				if (this.isClosed || !this.authCardView) return;
				this.authCardView.show({
					kind: "claude-max-step2",
					onReopen: () => void coordinator.reopenBrowser(),
					onStartOver: () => {
						if (this.isClosed) return;
						coordinator.cancel();
						if (this.authCardView) {
							this.authCardView.destroy();
							this.authCardView = null;
						}
						host.empty();
						this.renderClaudeMaxFlow(host);
					},
					onConfirm: async (url) => {
						if (this.isClosed) return;
						await coordinator.confirmWithUrl(url);
						if (this.isClosed) return;
						if (this.authCardView) {
							this.authCardView.destroy();
							this.authCardView = null;
						}
						const footer = this.contentEl.createDiv({ cls: "onboarding-footer" });
						this.renderSuccess(host, footer);
					},
				});
			},
			onError: (msg) => {
				if (this.isClosed) return;
				new Notice(`Claude Max sign in failed: ${msg}`);
				this.close();
			},
		});
	}

	private renderChatGptFlow(host: HTMLElement): void {
		const dummy = host.createDiv();
		dummy.addClass("claude-chat-hidden");
		this.authCardView = new AuthCardView(host, dummy);

		const TIMEOUT_MS = 5 * 60 * 1000;
		let cancelled = false;

		this.authCardView.show({
			kind: "chatgpt-spinner",
			timeoutMs: TIMEOUT_MS,
			onCancel: () => {
				cancelled = true;
				void this.plugin.signOutChat();
				this.close();
			},
		});

		void this.plugin.startChatLogin().then(() => {
			if (cancelled || this.isClosed) return;
			if (this.authCardView) {
				this.authCardView.destroy();
				this.authCardView = null;
			}
			const footer = this.contentEl.createDiv({ cls: "onboarding-footer" });
			this.renderSuccess(host, footer);
		}).catch((err) => {
			if (cancelled || this.isClosed) return;
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`ChatGPT sign in failed: ${msg}`);
			this.close();
		});
	}

	private renderSuccess(host: HTMLElement, footer: HTMLElement): void {
		if (this.isClosed) return;
		this.plugin.settings.authMode = this.selectedProvider;
		void this.plugin.saveSettings();

		host.empty();
		footer.empty();

		const success = host.createDiv({ cls: "onboarding-success" });
		const iconEl = success.createDiv({ cls: "onboarding-success-icon" });
		setIcon(iconEl, "check-circle");
		success.createDiv({ cls: "onboarding-success-text", text: "You're connected! Start chatting below." });

		const doneBtn = footer.createEl("button", {
			cls: "onboarding-btn onboarding-btn--primary",
			text: "Start chatting",
		});
		doneBtn.addEventListener("click", () => {
			this.onComplete();
			this.close();
		});
	}
}
