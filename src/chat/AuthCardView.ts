export type AuthCardMode =
	| { kind: "claude-max-step1" }
	| { kind: "claude-max-step2"; onConfirm: (url: string) => Promise<void>; onReopen: () => void; onStartOver: () => void }
	| { kind: "chatgpt-spinner"; timeoutMs: number; onCancel: () => void }
	| { kind: "session-recovery"; onSignIn: () => void }
	| { kind: "expiry-warning"; expiresAt: number; onReauth: () => void; onDismiss: () => void };

export class AuthCardView {
	private containerEl: HTMLElement;
	private inputEl: HTMLElement;
	private cardEl: HTMLElement | null = null;
	private countdownTimer: number | null = null;
	private autoCloseTimer: number | null = null;

	constructor(containerEl: HTMLElement, inputEl: HTMLElement) {
		this.containerEl = containerEl;
		this.inputEl = inputEl;
	}

	isVisible(): boolean {
		return this.cardEl !== null;
	}

	show(mode: AuthCardMode): void {
		this.hideInternal();
		this.inputEl.addClass("composer-input-hidden");

		const card = this.containerEl.createDiv({ cls: "auth-card" });
		this.cardEl = card;

		switch (mode.kind) {
			case "claude-max-step1":
				this.renderClaudeStep1(card);
				break;
			case "claude-max-step2":
				this.renderClaudeStep2(card, mode.onConfirm, mode.onReopen, mode.onStartOver);
				break;
			case "chatgpt-spinner":
				this.renderChatGptSpinner(card, mode.timeoutMs, mode.onCancel);
				break;
			case "session-recovery":
				this.renderRecovery(card, mode.onSignIn);
				break;
			case "expiry-warning":
				this.renderExpiryWarning(card, mode.expiresAt, mode.onReauth, mode.onDismiss);
				break;
		}
	}

	hide(): void {
		this.hideInternal();
		this.inputEl.removeClass("composer-input-hidden");
	}

	destroy(): void {
		// Use hide() to ensure CSS class is also removed
		this.hide();
	}

	private hideInternal(): void {
		if (this.countdownTimer !== null) {
			window.clearInterval(this.countdownTimer);
			this.countdownTimer = null;
		}
		if (this.autoCloseTimer !== null) {
			window.clearTimeout(this.autoCloseTimer);
			this.autoCloseTimer = null;
		}
		if (this.cardEl) {
			this.cardEl.remove();
			this.cardEl = null;
		}
	}

	private renderClaudeStep1(card: HTMLElement): void {
		card.createDiv({ cls: "auth-card-title", text: "Connect Claude Max" });
		card.createDiv({
			cls: "auth-card-body",
			text: "Opening browser… Log in on claude.ai, then copy the URL from your browser.",
		});
		const spinner = card.createDiv({ cls: "auth-card-spinner-row" });
		spinner.createDiv({ cls: "claude-chat-thinking-loading-dots" });
		spinner.createSpan({ cls: "auth-card-countdown", text: "Waiting for browser…" });
	}

	private renderClaudeStep2(
		card: HTMLElement,
		onConfirm: (url: string) => Promise<void>,
		onReopen: () => void,
		onStartOver: () => void
	): void {
		card.createDiv({ cls: "auth-card-title", text: "Connect Claude Max — Step 2 of 2" });
		card.createDiv({
			cls: "auth-card-body",
			text: "Copy the full URL from your browser address bar after logging in, then paste it below.",
		});

		const input = card.createEl("input", {
			cls: "auth-card-input",
			attr: {
				type: "text",
				placeholder: "https://console.anthropic.com/oauth/code/callback?code=…",
			},
		});
		input.focus();

		const errorEl = card.createDiv({ cls: "auth-card-error" });
		errorEl.addClass("claude-chat-hidden");

		const actions = card.createDiv({ cls: "auth-card-actions" });

		const reopenBtn = actions.createEl("button", { cls: "auth-card-btn", text: "Re-open browser" });
		reopenBtn.addEventListener("click", () => onReopen());

		const confirmBtn = actions.createEl("button", {
			cls: "auth-card-btn auth-card-btn--primary",
			text: "Confirm",
		});

		const doConfirm = async () => {
			const url = input.value.trim();
			if (!url) {
				errorEl.setText("Please paste the callback URL first.");
				errorEl.removeClass("claude-chat-hidden");
				return;
			}
			confirmBtn.disabled = true;
			confirmBtn.textContent = "Signing in…";
			errorEl.addClass("claude-chat-hidden");
			try {
				await onConfirm(url);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const isExpired =
					msg.toLowerCase().includes("expired") ||
					msg.toLowerCase().includes("invalid_grant") ||
					msg.toLowerCase().includes("invalid state");
				errorEl.setText(isExpired ? `${msg} — start a fresh flow below.` : msg);
				errorEl.removeClass("claude-chat-hidden");
				confirmBtn.disabled = false;
				confirmBtn.textContent = "Confirm";
				// Show Start over button for unrecoverable PKCE errors
				if (isExpired && !actions.querySelector(".auth-card-btn--start-over")) {
					const startOverBtn = actions.createEl("button", {
						cls: "auth-card-btn auth-card-btn--start-over",
						text: "Start over",
					});
					startOverBtn.addEventListener("click", () => onStartOver());
				}
			}
		};

		confirmBtn.addEventListener("click", () => void doConfirm());
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") void doConfirm();
		});
	}

	private renderChatGptSpinner(card: HTMLElement, timeoutMs: number, onCancel: () => void): void {
		card.createDiv({ cls: "auth-card-title", text: "Connect ChatGPT Plus" });

		const row = card.createDiv({ cls: "auth-card-spinner-row" });
		row.createDiv({ cls: "claude-chat-thinking-loading-dots" });
		const countdownEl = row.createSpan({ cls: "auth-card-countdown" });

		const endTime = Date.now() + timeoutMs;

		const updateCountdown = () => {
			const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
			countdownEl.setText(`Waiting for browser… ${remaining}s`);
			if (remaining === 0) {
				// Auto-cancel when countdown expires
				window.clearInterval(this.countdownTimer!);
				this.countdownTimer = null;
				onCancel();
			}
		};
		updateCountdown();
		this.countdownTimer = window.setInterval(updateCountdown, 1000);

		card.createDiv({
			cls: "auth-card-body",
			text: "Complete authentication in the browser window. This will close automatically.",
		});

		const actions = card.createDiv({ cls: "auth-card-actions" });
		const cancelBtn = actions.createEl("button", { cls: "auth-card-btn", text: "Cancel" });
		cancelBtn.addEventListener("click", () => onCancel());
	}

	private renderRecovery(card: HTMLElement, onSignIn: () => void): void {
		card.addClass("auth-card--recovery");
		card.createDiv({ cls: "auth-card-title", text: "Session ended" });
		card.createDiv({
			cls: "auth-card-body",
			text: "Your session has expired or been revoked. Sign in to continue.",
		});
		const actions = card.createDiv({ cls: "auth-card-actions" });
		const signInBtn = actions.createEl("button", {
			cls: "auth-card-btn auth-card-btn--primary",
			text: "Sign in",
		});
		signInBtn.addEventListener("click", () => {
			this.hide();
			onSignIn();
		});
	}

	private renderExpiryWarning(
		card: HTMLElement,
		expiresAt: number,
		onReauth: () => void,
		onDismiss: () => void
	): void {
		card.addClass("auth-card--expiry");

		const msLeft = expiresAt - Date.now();
		if (msLeft <= 0) {
			// Already expired — show recovery instead of misleading expiry time
			card.removeClass("auth-card--expiry");
			this.renderRecovery(card, onReauth);
			return;
		}

		const hoursLeft = Math.max(1, Math.round(msLeft / 3_600_000));
		card.createDiv({ cls: "auth-card-title", text: `Session expires in ${hoursLeft}h` });
		card.createDiv({
			cls: "auth-card-body",
			text: "Re-authenticate now to avoid interruption during your work session.",
		});
		const actions = card.createDiv({ cls: "auth-card-actions" });
		const reauthBtn = actions.createEl("button", {
			cls: "auth-card-btn auth-card-btn--primary",
			text: "Re-authenticate",
		});
		reauthBtn.addEventListener("click", () => {
			this.hide();
			onReauth();
		});
		const dismissBtn = actions.createEl("button", { cls: "auth-card-btn", text: "Dismiss" });
		dismissBtn.addEventListener("click", () => {
			this.hide();
			onDismiss();
		});
	}
}
