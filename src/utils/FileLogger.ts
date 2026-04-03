import { Platform } from "obsidian";

/**
 * File-based logger for debugging
 */
export class FileLogger {
	private logFile: string;
	private vaultPath: string;

	constructor(vaultPath: string, logFile: string = ".claude-ai-debug.log") {
		this.vaultPath = vaultPath;
		this.logFile = logFile;
	}

	private async write(level: string, message: string, data?: unknown): Promise<void> {
		try {
			const timestamp = new Date().toISOString();
			const dataStr = data ? ` ${JSON.stringify(data)}` : "";
			const logLine = `[${timestamp}] [${level}] ${message}${dataStr}\n`;
			
			// Use Node.js fs if available (desktop)
			if (Platform.isDesktop) {
				const fs = require("fs");
				const path = require("path");
				const fullPath = path.join(this.vaultPath, this.logFile);
				fs.appendFileSync(fullPath, logLine);
			}
		} catch (e) {
			// Silent fail
		}
	}

	log(message: string, data?: unknown): void {
		void this.write("LOG", message, data);
	}

	info(message: string, data?: unknown): void {
		void this.write("INFO", message, data);
	}

	error(message: string, data?: unknown): void {
		void this.write("ERROR", message, data);
	}
}

// Global logger instance
let globalLogger: FileLogger | null = null;

export function initLogger(vaultPath: string): FileLogger {
	globalLogger = new FileLogger(vaultPath);
	return globalLogger;
}

export function getLogger(): FileLogger | null {
	return globalLogger;
}
