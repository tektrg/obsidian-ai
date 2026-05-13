/**
 * Types for multi-file diff viewer
 */

/** Type of change operation */
export type ToolType = 'Edit' | 'Write';

/** A single file change (Edit or Write operation) */
export interface FileChange {
	/** Unique ID for this change */
	id: string;
	/** Absolute file path */
	filePath: string;
	/** Tool type: Edit or Write */
	toolType: ToolType;
	/** For Edit: the old_string; For Write: empty or previous content if available */
	original: string;
	/** For Edit: the new_string; For Write: the written content */
	modified: string;
	/** Optional: pre-computed unified diff string (alternative to original/modified) */
	unifiedDiff?: string;
	/** Error message if the tool failed */
	error?: string;
}

/** A group of changes for a single file */
export interface FileSection {
	/** Unique key (file path) */
	key: string;
	/** File path */
	filePath: string;
	/** Changes for this file */
	changes: FileChange[];
}

/** Diff viewer display preferences */
export interface DiffViewerSettings {
	/** Unified or split diff view */
	diffStyle: 'unified' | 'split';
	/** Whether to disable background highlighting */
	disableBackground: boolean;
}

/** Diff statistics for a change */
export interface DiffStats {
	/** Number of added lines */
	additions: number;
	/** Number of deleted lines */
	deletions: number;
}

/** Options for opening the multi-file diff modal */
export interface MultiFileDiffOptions {
	/** List of file changes to display */
	changes: FileChange[];
	/** Whether to consolidate changes by file path (default: true) */
	consolidated?: boolean;
	/** ID of change to focus on initially */
	focusedChangeId?: string;
}
