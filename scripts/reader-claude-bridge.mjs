#!/usr/bin/env node
import { query } from "@anthropic-ai/claude-agent-sdk";
import process from "node:process";

function respond(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function extractTextFromSdkMessages(sdkMessages) {
	for (let i = sdkMessages.length - 1; i >= 0; i -= 1) {
		const message = sdkMessages[i];
		if (!message || typeof message !== "object") continue;
		if (message.type === "result" && typeof message.result === "string" && message.result.trim()) {
			return message.result.trim();
		}
	}

	const textParts = [];
	for (const message of sdkMessages) {
		if (!message || typeof message !== "object") continue;
		if (message.type !== "assistant") continue;
		const content = Array.isArray(message.message?.content) ? message.message.content : [];
		for (const part of content) {
			if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
				textParts.push(part.text);
			}
		}
	}

	const fallbackText = textParts.join("\n\n").trim();
	return fallbackText || "";
}

async function runChat(payload) {
	const prompt = String(payload?.prompt ?? "").trim();
	if (!prompt) {
		throw new Error("Missing prompt");
	}

	const model = String(payload?.model ?? "claude-sonnet-4-5").trim();
	const systemPrompt = typeof payload?.systemPrompt === "string" ? payload.systemPrompt : "";
	const cwd = typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();

	const sdkMessages = [];
	for await (const msg of query({
		prompt,
		options: {
			model,
			cwd,
			maxTurns: 1,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			systemPrompt: systemPrompt
				? {
					type: "preset",
					preset: "claude_code",
					append: systemPrompt
				}
				: undefined,
		}
	})) {
		sdkMessages.push(msg);
	}

	const text = extractTextFromSdkMessages(sdkMessages);
	if (!text) {
		const seenTypes = sdkMessages
			.map((message) => (message && typeof message === "object" ? String(message.type ?? "unknown") : "non-object"))
			.join(", ");
		throw new Error(`Claude SDK returned no text output (seen message types: ${seenTypes || "none"})`);
	}

	return { text };
}

async function handleLine(rawLine) {
	const line = rawLine.trim();
	if (!line) return;

	let req;
	try {
		req = JSON.parse(line);
	} catch {
		respond({ id: null, ok: false, error: "Invalid JSON input" });
		return;
	}

	const id = req?.id ?? null;
	const method = req?.method;

	try {
		if (method === "ping") {
			respond({ id, ok: true, result: { pong: true } });
			return;
		}

		if (method === "chat") {
			const result = await runChat(req.payload ?? {});
			respond({ id, ok: true, result });
			return;
		}

		respond({ id, ok: false, error: `Unknown method: ${String(method)}` });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		respond({ id, ok: false, error: message });
	}
}

let buffer = "";
let stdinEnded = false;
const inFlight = new Set();

function maybeExit() {
	if (stdinEnded && inFlight.size === 0) {
		process.exit(0);
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let idx = buffer.indexOf("\n");
	while (idx >= 0) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		const task = handleLine(line)
			.catch((error) => {
				respond({ id: null, ok: false, error: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				inFlight.delete(task);
				maybeExit();
			});
		inFlight.add(task);
		idx = buffer.indexOf("\n");
	}
});

process.stdin.on("end", () => {
	stdinEnded = true;
	maybeExit();
});
