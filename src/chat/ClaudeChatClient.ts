import { requestUrl } from "obsidian";

interface SendMessageParams {
	authHeaders: Record<string, string>;
	model: string;
	prompt: string;
	systemPrompt?: string;
}

export class ClaudeChatClient {
	async sendMessage(params: SendMessageParams): Promise<string> {
		const response = await requestUrl({
			url: "https://api.anthropic.com/v1/messages",
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...params.authHeaders
			},
			body: JSON.stringify({
				model: params.model,
				max_tokens: 1024,
				system: params.systemPrompt?.trim() || undefined,
				messages: [
					{ role: "user", content: params.prompt }
				]
			})
		});

		if (response.status < 200 || response.status >= 300) {
			const message = this.getErrorMessage(response.json);
			throw new Error(`Anthropic request failed (${response.status}): ${message}`);
		}

		const text = this.extractText(response.json);
		if (!text) {
			throw new Error("Anthropic response did not include text content.");
		}

		return text;
	}

	async testConnection(params: Omit<SendMessageParams, "prompt">): Promise<void> {
		await this.sendMessage({
			...params,
			prompt: "Reply with exactly: OK"
		});
	}

	private extractText(payload: unknown): string {
		if (!payload || typeof payload !== "object") {
			return "";
		}

		const root = payload as Record<string, unknown>;
		const content = root.content;
		if (!Array.isArray(content)) {
			return "";
		}

		const parts = content
			.filter((item) => item && typeof item === "object")
			.map((item) => {
				const record = item as Record<string, unknown>;
				return typeof record.text === "string" ? record.text : "";
			})
			.filter(Boolean);

		return parts.join("\n\n").trim();
	}

	private getErrorMessage(payload: unknown): string {
		if (!payload || typeof payload !== "object") {
			return "Unknown error";
		}

		const root = payload as Record<string, unknown>;
		const error = root.error;
		if (error && typeof error === "object") {
			const errorRecord = error as Record<string, unknown>;
			if (typeof errorRecord.message === "string" && errorRecord.message.trim()) {
				return errorRecord.message;
			}
		}

		return "Unknown error";
	}
}
