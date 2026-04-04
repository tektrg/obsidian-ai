/**
 * File Mention Service
 *
 * Handles parsing and resolving @ file mentions in chat messages.
 * Compatible with craft-agents-oss semantic marker pattern.
 *
 * Mention format:
 * - Storage: [file:path/to/file.md]
 * - Resolved: [Mentioned file: file.md (at /absolute/path/to/file.md)]
 */

export interface ParsedFileMentions {
	/** File paths mentioned via [file:path] */
	files: string[];
}

/**
 * Parse file mentions from text
 * Pattern: [file:path/to/file.md]
 *
 * @param text - The message text to parse
 * @returns Parsed file mentions
 *
 * @example
 * parseFileMentions('Check [file:src/index.ts]')
 * // Returns: { files: ['src/index.ts'] }
 */
export function parseFileMentions(text: string): ParsedFileMentions {
	const files: string[] = [];
	const filePattern = /\[file:([^\]]+)\]/g;
	let match: RegExpExecArray | null;

	while ((match = filePattern.exec(text)) !== null) {
		const filePath = match[1];
		if (filePath && !files.includes(filePath)) {
			files.push(filePath);
		}
	}

	return { files };
}

/**
 * Resolve file mentions to semantic markers.
 *
 * [file:src/index.ts] → [Mentioned file: index.ts (at /Users/me/project/src/index.ts)]
 *
 * The semantic wrapper signals to the agent that the user explicitly referenced
 * this file and it should be proactively read.
 *
 * @param text - The message text with [file:...] mentions
 * @param vaultBasePath - Absolute path to the vault root
 * @returns Text with file mentions resolved to semantic markers
 */
export function resolveFileMentions(text: string, vaultBasePath: string): string {
	return text.replace(/\[file:([^\]]+)\]/g, (_match, filePath: string) => {
		// Resolve to absolute path
		const resolved = filePath.startsWith('/')
			? filePath
			: `${vaultBasePath}/${filePath}`;

		// Extract filename from path
		const name = filePath.split('/').pop() || filePath;

		return `[Mentioned file: ${name} (at ${resolved})]`;
	});
}

/**
 * Insert a file mention at cursor position.
 *
 * @param text - Current input text
 * @param cursorPos - Cursor position in text
 * @param filePath - File path to mention
 * @returns New text and cursor position
 */
export function insertFileMention(
	text: string,
	cursorPos: number,
	filePath: string
): { newText: string; newCursorPos: number } {
	const mention = `[file:${filePath}]`;
	const newText = text.slice(0, cursorPos) + mention + text.slice(cursorPos);
	return { newText, newCursorPos: cursorPos + mention.length };
}

/**
 * Remove a file mention from text.
 *
 * @param text - Message text with mentions
 * @param filePath - File path to remove
 * @returns Text with the mention removed
 */
export function removeFileMention(text: string, filePath: string): string {
	const pattern = new RegExp(`\\[file:${escapeRegExp(filePath)}\\]\\s*`, 'g');
	return text.replace(pattern, '').replace(/\s+/g, ' ').trim();
}

/**
 * Check if text contains any file mentions.
 *
 * @param text - Message text to check
 * @returns True if text contains [file:...] mentions
 */
export function hasFileMentions(text: string): boolean {
	return /\[file:[^\]]+\]/.test(text);
}

/**
 * Extract display name from file path.
 *
 * @param filePath - File path
 * @returns Filename (last component)
 */
export function getFileDisplayName(filePath: string): string {
	return filePath.split('/').pop() || filePath;
}

/**
 * Escape special regex characters.
 */
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
