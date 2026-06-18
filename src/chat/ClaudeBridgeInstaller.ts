import { Plugin } from "obsidian";
import claudeBridgeSource from "virtual:claude-chat-bridge-source";
import claudeCodeCliSource from "virtual:claude-code-cli-source";

const BRIDGE_RELATIVE_PATH = "scripts/claude-chat-bridge.mjs";
const CLAUDE_CODE_CLI_RELATIVE_PATH = "scripts/claude-code-cli.js";

type FsModule = {
	existsSync?: (path: string) => boolean;
	mkdirSync?: (path: string, options: { recursive: boolean }) => void;
	readFileSync?: (path: string, encoding: "utf8") => string;
	writeFileSync?: (path: string, contents: string, encoding: "utf8") => void;
};

type PathModule = {
	dirname?: (path: string) => string;
	join?: (...parts: string[]) => string;
};

function requireNodeModule<T>(moduleName: string): T {
	const win = window as unknown as { require?: (name: string) => unknown };
	const module = win.require?.(moduleName) as T | undefined;
	if (!module) {
		throw new Error(`Cannot load Node ${moduleName} module in this Obsidian runtime.`);
	}
	return module;
}

export function installClaudeBridge(plugin: Plugin, vaultBasePath: string): string {
	const fs = requireNodeModule<FsModule>("fs");
	const path = requireNodeModule<PathModule>("path");
	if (!fs.existsSync || !fs.mkdirSync || !fs.readFileSync || !fs.writeFileSync || !path.dirname || !path.join) {
		throw new Error("Required Node filesystem APIs are unavailable in this Obsidian runtime.");
	}
	const nodeFs = fs as Required<FsModule>;
	const nodePath = path as Required<PathModule>;

	const pluginDir = nodePath.join(vaultBasePath, plugin.app.vault.configDir, "plugins", plugin.manifest.id);
	const bridgePath = nodePath.join(pluginDir, BRIDGE_RELATIVE_PATH);

	try {
		writeRuntimeFile(nodeFs, nodePath, nodePath.join(pluginDir, CLAUDE_CODE_CLI_RELATIVE_PATH), claudeCodeCliSource);
		writeRuntimeFile(nodeFs, nodePath, bridgePath, claudeBridgeSource);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to install Claude runtime files: ${message}`);
	}

	return bridgePath;
}

function writeRuntimeFile(fs: Required<FsModule>, path: Required<PathModule>, filePath: string, source: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const currentSource = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
	if (currentSource !== source) {
		fs.writeFileSync(filePath, source, "utf8");
	}
}
