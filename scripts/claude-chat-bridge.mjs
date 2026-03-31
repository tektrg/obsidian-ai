#!/usr/bin/env node
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
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

function extractActiveFilePath(prompt) {
	if (!prompt) return "";
	const markerStart = "ACTIVE_FILE_CONTEXT_START";
	const markerEnd = "ACTIVE_FILE_CONTEXT_END";
	const start = prompt.indexOf(markerStart);
	const end = prompt.indexOf(markerEnd);
	const scope = start >= 0 && end > start ? prompt.slice(start, end) : prompt;
	const match = scope.match(/File path:\s*(.+)/i);
	if (!match?.[1]) return "";
	return String(match[1]).trim();
}

function resolveTargetFile(payload, prompt, cwd) {
	const fromPayload = typeof payload?.activeFilePath === "string" ? payload.activeFilePath.trim() : "";
	const fromPrompt = extractActiveFilePath(prompt);
	const relativePath = fromPayload || fromPrompt;
	if (!relativePath) return { relativePath: "", absolutePath: "" };
	return {
		relativePath,
		absolutePath: path.resolve(cwd, relativePath),
	};
}

function readFileSafe(filePath) {
	if (!filePath) return null;
	try {
		if (!fs.existsSync(filePath)) return null;
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function isEditIntent(text) {
	if (!text) return false;
	return /(update|edit|rewrite|modify|change|fix|patch|mark\s+.*todo|apply\s+changes)/i.test(text);
}

function buildSystemPrompt(systemPrompt, prompt, targetFile) {
	const segments = [];
	if (systemPrompt?.trim()) {
		segments.push(systemPrompt.trim());
	}

	const shouldForceEditTool = isEditIntent(prompt);
	if (shouldForceEditTool && targetFile?.relativePath) {
		segments.push([
			"When the user asks to update/edit/modify the page, you must perform an actual file edit using Claude Code tools (Edit/Write).",
			"Do not return only a summary when an update was requested.",
			`Target note path: ${targetFile.relativePath}`,
			"Apply changes directly to that file unless user explicitly asks for a preview only.",
			"After editing, give a concise confirmation of what was changed.",
		].join("\n"));
	}

	return segments.join("\n\n").trim() || undefined;
}

async function runChat(payload) {
	const prompt = String(payload?.prompt ?? "").trim();
	if (!prompt) {
		throw new Error("Missing prompt");
	}

	const model = String(payload?.model ?? "claude-sonnet-4-5").trim();
	const systemPrompt = typeof payload?.systemPrompt === "string" ? payload.systemPrompt : "";
	const cwd = typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
	const targetFile = resolveTargetFile(payload, prompt, cwd);
	const before = readFileSafe(targetFile.absolutePath);

	const sdkMessages = [];
	for await (const msg of query({
		prompt,
		options: {
			model,
			cwd,
			maxTurns: 8,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: buildSystemPrompt(systemPrompt, prompt, targetFile),
			},
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

	const after = readFileSafe(targetFile.absolutePath);
	const fileChanged = before !== null && after !== null && before !== after;

	return {
		text,
		fileChanged,
		editedFilePath: fileChanged ? targetFile.relativePath : undefined,
	};
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
