/**
 * Simple file-based logger for debugging
 */

export class Logger {
	private logFile: string;
	private maxLines: number;

	constructor(logFile: string = ".obsidian/plugins/obsidian-ai/debug.log", maxLines: number = 1000) {
		this.logFile = logFile;
		this.maxLines = maxLines;
	}

	private async writeLog(level: string, message: string, data?: unknown): Promise<void> {
		try {
			const timestamp = new Date().toISOString();
			const dataStr = data ? " " + JSON.stringify(data) : "";
			const logLine = `[${timestamp}] [${level}] ${message}${dataStr}\n`;

			// In Obsidian, we can't easily write files without the app
			// So we'll use console and also try to accumulate in memory if needed
			console.log(`[ClaudeAI] ${message}`, data || "");
		} catch (e) {
			// Silent fail
		}
	}

	info(message: string, data?: unknown): void {
		void this.writeLog("INFO", message, data);
	}

	debug(message: string, data?: unknown): void {
		void this.writeLog("DEBUG", message, data);
	}

	warn(message: string, data?: unknown): void {
		void this.writeLog("WARN", message, data);
	}

	error(message: string, data?: unknown): void {
		void this.writeLog("ERROR", message, data);
	}
}

// Singleton instance
export const logger = new Logger();
