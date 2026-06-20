import { Plugin } from "obsidian";
import claudeBridgeSource from "virtual:claude-chat-bridge-source";
import claudeCodeCliSource from "virtual:claude-code-cli-source";
import piBridgeSource from "virtual:pi-agent-bridge-source";

const CLAUDE_BRIDGE_RELATIVE_PATH = "scripts/claude-chat-bridge.mjs";
const CLAUDE_CODE_CLI_RELATIVE_PATH = "scripts/claude-code-cli.js";
const PI_BRIDGE_RELATIVE_PATH = "scripts/pi-agent-bridge.mjs";

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

interface RuntimeInstaller {
	fs: Required<FsModule>;
	path: Required<PathModule>;
	pluginDir: string;
}

function requireNodeModule<T>(moduleName: string): T {
	const win = window as unknown as { require?: (name: string) => unknown };
	const module = win.require?.(moduleName) as T | undefined;
	if (!module) {
		throw new Error(`Cannot load Node ${moduleName} module in this Obsidian runtime.`);
	}
	return module;
}

export function installClaudeBridge(plugin: Plugin, vaultBasePath: string): string {
	const installer = getRuntimeInstaller(plugin, vaultBasePath);
	const bridgePath = installer.path.join(installer.pluginDir, CLAUDE_BRIDGE_RELATIVE_PATH);

	try {
		writeRuntimeFile(installer, installer.path.join(installer.pluginDir, CLAUDE_CODE_CLI_RELATIVE_PATH), claudeCodeCliSource);
		writeRuntimeFile(installer, bridgePath, claudeBridgeSource);
		writeRuntimeFile(installer, installer.path.join(installer.pluginDir, PI_BRIDGE_RELATIVE_PATH), piBridgeSource);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to install chat runtime files: ${message}`);
	}

	return bridgePath;
}

export function installPiBridge(plugin: Plugin, vaultBasePath: string): string {
	const installer = getRuntimeInstaller(plugin, vaultBasePath);
	const bridgePath = installer.path.join(installer.pluginDir, PI_BRIDGE_RELATIVE_PATH);

	try {
		writeRuntimeFile(installer, bridgePath, piBridgeSource);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to install Pi runtime files: ${message}`);
	}

	return bridgePath;
}

function getRuntimeInstaller(plugin: Plugin, vaultBasePath: string): RuntimeInstaller {
	const fs = requireNodeModule<FsModule>("fs");
	const path = requireNodeModule<PathModule>("path");
	if (!fs.existsSync || !fs.mkdirSync || !fs.readFileSync || !fs.writeFileSync || !path.dirname || !path.join) {
		throw new Error("Required Node filesystem APIs are unavailable in this Obsidian runtime.");
	}
	const requiredPath = path as Required<PathModule>;
	return {
		fs: fs as Required<FsModule>,
		path: requiredPath,
		pluginDir: requiredPath.join(vaultBasePath, plugin.app.vault.configDir, "plugins", plugin.manifest.id),
	};
}

function writeRuntimeFile(installer: RuntimeInstaller, filePath: string, source: string): void {
	installer.fs.mkdirSync(installer.path.dirname(filePath), { recursive: true });
	const currentSource = installer.fs.existsSync(filePath) ? installer.fs.readFileSync(filePath, "utf8") : "";
	if (currentSource !== source) {
		installer.fs.writeFileSync(filePath, source, "utf8");
	}
}
