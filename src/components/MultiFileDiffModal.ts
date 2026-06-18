import { App, Modal, Notice, setIcon } from "obsidian";
import type { FileChange, FileSection, DiffStats, DiffViewerSettings } from "../types/diff";
import { generateInlineDiff, getDiffStats as getLineDiffStats } from "../utils/DiffGenerator";

/**
 * MultiFileDiffModal - Overlay for multiple file changes (Edit/Write tools)
 *
 * Layout: Stacked diffs with file headers — GitHub PR-like view.
 * Each diff renders its own file header (filename + addition/deletion counts).
 * All diffs are visible in a single scrollable area.
 */
export interface MultiFileDiffOptions {
	/** List of file changes to display */
	changes: FileChange[];
	/** Whether to consolidate changes by file path (default: true) */
	consolidated?: boolean;
	/** ID of change to focus on initially */
	focusedChangeId?: string;
}

export class MultiFileDiffModal extends Modal {
	private readonly options: MultiFileDiffOptions;
	private settings: DiffViewerSettings;
	private fileSections: FileSection[] = [];
	private currentFileIndex = 0;
	private changeRefs = new Map<string, HTMLElement>();

	constructor(app: App, options: MultiFileDiffOptions) {
		super(app);
		this.options = {
			consolidated: true,
			...options,
		};
		// Load settings from localStorage or use defaults
		this.settings = this.loadSettings();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("claude-multi-diff-modal");

		// Handle empty changes
		if (this.options.changes.length === 0) {
			this.renderEmptyState();
			return;
		}

		// Build file sections
		this.fileSections = this.createFileSections(this.options.changes, this.options.consolidated ?? true);

		// Render header
		this.renderHeader();

		// Render content
		this.renderContent();

		// Scroll to focused change after render
		if (this.options.focusedChangeId) {
			setTimeout(() => this.scrollToChange(this.options.focusedChangeId!), 100);
		}
	}

	/**
	 * Render empty state when no changes to display
	 */
	private renderEmptyState(): void {
		const { contentEl } = this;

		// Header with close button
		const headerEl = contentEl.createDiv({ cls: "claude-multi-diff-header" });
		const titleWrap = headerEl.createDiv({ cls: "claude-multi-diff-title-wrap" });
		const iconEl = titleWrap.createEl("span", { cls: "claude-multi-diff-icon" });
		setIcon(iconEl, "file-x");
		titleWrap.createEl("h3", { text: "No Changes", cls: "claude-multi-diff-title" });

		const controlsEl = headerEl.createDiv({ cls: "claude-multi-diff-controls" });
		const closeBtn = controlsEl.createEl("button", {
			cls: "claude-multi-diff-close-btn",
			attr: { title: "Close (Esc)" }
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.close());

		// Empty state content
		const contentContainer = contentEl.createDiv({ cls: "claude-multi-diff-content" });
		const emptyEl = contentContainer.createDiv({ cls: "claude-multi-diff-empty-state" });

		const emptyIcon = emptyEl.createEl("div", { cls: "claude-multi-diff-empty-icon" });
		setIcon(emptyIcon, "file-x");

		emptyEl.createEl("h4", { text: "No changes to display", cls: "claude-multi-diff-empty-title" });
		emptyEl.createEl("p", {
			text: "There are no file changes to show for this turn.",
			cls: "claude-multi-diff-empty-message"
		});

		const dismissBtn = emptyEl.createEl("button", {
			text: "Dismiss",
			cls: "claude-multi-diff-empty-btn"
		});
		dismissBtn.addEventListener("click", () => this.close());
	}

	private loadSettings(): DiffViewerSettings {
		try {
			const saved = localStorage.getItem("claude-chat-diff-settings");
			if (saved) {
				return { diffStyle: 'unified', disableBackground: false, ...JSON.parse(saved) };
			}
		} catch {
			// Ignore parse errors
		}
		return { diffStyle: 'unified', disableBackground: false };
	}

	private saveSettings(): void {
		try {
			localStorage.setItem("claude-chat-diff-settings", JSON.stringify(this.settings));
		} catch {
			// Ignore save errors
		}
	}

	/**
	 * Groups changes into file sections.
	 * In consolidated mode, changes to the same file are grouped together.
	 * In non-consolidated mode, each change is its own section.
	 */
	private createFileSections(changes: FileChange[], consolidated: boolean): FileSection[] {
		if (!consolidated) {
			return changes.map((change) => ({
				key: change.id,
				filePath: change.filePath,
				changes: [change],
			}));
		}

		// Group by file path, preserving order of first occurrence
		const byPath = new Map<string, FileChange[]>();
		for (const change of changes) {
			const existing = byPath.get(change.filePath) || [];
			existing.push(change);
			byPath.set(change.filePath, existing);
		}

		return Array.from(byPath.entries()).map(([filePath, fileChanges]) => ({
			key: filePath,
			filePath,
			changes: fileChanges,
		}));
	}

	/**
	 * Compute total diff stats across all changes
	 */
	private computeTotalStats(): DiffStats {
		let additions = 0;
		let deletions = 0;

		for (const change of this.options.changes) {
			if (change.error) continue;
			const stats = this.computeChangeStats(change);
			additions += stats.additions;
			deletions += stats.deletions;
		}

		return { additions, deletions };
	}

	/**
	 * Compute diff stats for a single change
	 */
	private computeChangeStats(change: FileChange): DiffStats {
		if (change.error) {
			return { additions: 0, deletions: 0 };
		}

		// Use pre-computed unified diff if available
		if (change.unifiedDiff) {
			return this.parseUnifiedDiffStats(change.unifiedDiff);
		}

		// Compute from original/modified
		const diff = generateInlineDiff(change.original, change.modified);
		const stats = getLineDiffStats(diff);
		return {
			additions: stats.added,
			deletions: stats.removed,
		};
	}

	/**
	 * Parse stats from unified diff format
	 */
	private parseUnifiedDiffStats(unifiedDiff: string): DiffStats {
		let additions = 0;
		let deletions = 0;

		const lines = unifiedDiff.split('\n');
		for (const line of lines) {
			if (line.startsWith('+') && !line.startsWith('+++')) {
				additions++;
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				deletions++;
			}
		}

		return { additions, deletions };
	}

	/**
	 * Render the modal header with title, navigation, and controls
	 */
	private renderHeader(): void {
		const { contentEl } = this;
		const totalStats = this.computeTotalStats();
		const totalChanges = this.options.changes.length;
		const fileCount = this.fileSections.length;
		const isMultiFile = fileCount > 1;

		const headerEl = contentEl.createDiv({ cls: "claude-multi-diff-header" });

		// Left side: Title and file count
		const titleWrap = headerEl.createDiv({ cls: "claude-multi-diff-title-wrap" });

		// Icon
		const iconEl = titleWrap.createEl("span", { cls: "claude-multi-diff-icon" });
		setIcon(iconEl, isMultiFile ? "files" : "file-edit");

		// Title
		const titleText = isMultiFile
			? `${totalChanges} edit${totalChanges !== 1 ? 's' : ''} across ${fileCount} file${fileCount !== 1 ? 's' : ''}`
			: this.fileSections[0]?.filePath ?? "Changes";
		titleWrap.createEl("h3", { text: titleText, cls: "claude-multi-diff-title" });

		// Right side: Controls and close
		const controlsEl = headerEl.createDiv({ cls: "claude-multi-diff-controls" });

		// Stats display
		const statsEl = controlsEl.createDiv({ cls: "claude-multi-diff-stats" });
		statsEl.createSpan({
			text: `-${totalStats.deletions}`,
			cls: "claude-multi-diff-stat claude-multi-diff-stat--removed"
		});
		statsEl.createSpan({
			text: `+${totalStats.additions}`,
			cls: "claude-multi-diff-stat claude-multi-diff-stat--added"
		});

		// View toggle button (unified/split)
		const viewToggleBtn = controlsEl.createEl("button", {
			cls: "claude-multi-diff-control-btn",
			attr: { title: this.settings.diffStyle === 'unified' ? 'Switch to split view' : 'Switch to unified view' }
		});
		setIcon(viewToggleBtn, this.settings.diffStyle === 'unified' ? "columns" : "align-justify");
		viewToggleBtn.addEventListener("click", () => {
			this.settings.diffStyle = this.settings.diffStyle === 'unified' ? 'split' : 'unified';
			this.saveSettings();
			this.refreshView();
		});

		// Background toggle button
		const bgToggleBtn = controlsEl.createEl("button", {
			cls: "claude-multi-diff-control-btn",
			attr: { title: this.settings.disableBackground ? 'Enable background highlighting' : 'Disable background highlighting' }
		});
		bgToggleBtn.toggleClass("claude-multi-diff-control-btn--disabled", this.settings.disableBackground);
		setIcon(bgToggleBtn, this.settings.disableBackground ? "eye-off" : "paintbrush");
		bgToggleBtn.addEventListener("click", () => {
			this.settings.disableBackground = !this.settings.disableBackground;
			this.saveSettings();
			this.refreshView();
		});

		// Close button
		const closeBtn = controlsEl.createEl("button", {
			cls: "claude-multi-diff-close-btn",
			attr: { title: "Close (Esc)" }
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.close());

		// Navigation (only for multi-file)
		if (isMultiFile) {
			this.renderNavigation(controlsEl);
		}
	}

	/**
	 * Render navigation controls for multi-file view
	 */
	private renderNavigation(container: HTMLElement): void {
		const navEl = container.createDiv({ cls: "claude-multi-diff-nav" });

		// Previous button
		const prevBtn = navEl.createEl("button", {
			cls: "claude-multi-diff-nav-btn",
			attr: { title: "Previous file" }
		});
		setIcon(prevBtn, "chevron-left");
		prevBtn.disabled = this.currentFileIndex === 0;
		prevBtn.addEventListener("click", () => {
			if (this.currentFileIndex > 0) {
				this.currentFileIndex--;
				this.scrollToFile(this.currentFileIndex);
				this.refreshNavigation();
			}
		});

		// File counter / dropdown
		const counterEl = navEl.createEl("span", {
			text: `${this.currentFileIndex + 1} / ${this.fileSections.length}`,
			cls: "claude-multi-diff-nav-counter"
		});

		// Next button
		const nextBtn = navEl.createEl("button", {
			cls: "claude-multi-diff-nav-btn",
			attr: { title: "Next file" }
		});
		setIcon(nextBtn, "chevron-right");
		nextBtn.disabled = this.currentFileIndex >= this.fileSections.length - 1;
		nextBtn.addEventListener("click", () => {
			if (this.currentFileIndex < this.fileSections.length - 1) {
				this.currentFileIndex++;
				this.scrollToFile(this.currentFileIndex);
				this.refreshNavigation();
			}
		});

		// Store nav elements for refreshing
		(navEl as HTMLElementWithNav).dataset.nav = "true";
	}

	private refreshNavigation(): void {
		const navEl = this.modalEl.querySelector('[data-nav="true"]') as HTMLElementWithNav | null;
		if (!navEl) return;

		const counterEl = navEl.querySelector(".claude-multi-diff-nav-counter");
		if (counterEl) {
			counterEl.textContent = `${this.currentFileIndex + 1} / ${this.fileSections.length}`;
		}

		const buttons = navEl.querySelectorAll(".claude-multi-diff-nav-btn");
		if (buttons[0]) (buttons[0] as HTMLButtonElement).disabled = this.currentFileIndex === 0;
		if (buttons[1]) (buttons[1] as HTMLButtonElement).disabled = this.currentFileIndex >= this.fileSections.length - 1;
	}

	private scrollToFile(index: number): void {
		const section = this.fileSections[index];
		if (!section) return;

		const firstChange = section.changes[0];
		if (firstChange) {
			this.scrollToChange(firstChange.id);
		}
	}

	private scrollToChange(changeId: string): void {
		const el = this.changeRefs.get(changeId);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}

	/**
	 * Render the main content with stacked diffs
	 */
	private renderContent(): void {
		const { contentEl } = this;

		const contentContainer = contentEl.createDiv({ cls: "claude-multi-diff-content" });

		// Stacked diffs
		const diffsContainer = contentContainer.createDiv({ cls: "claude-multi-diff-stack" });

		for (const section of this.fileSections) {
			for (const change of section.changes) {
				this.renderChangeCard(diffsContainer, change);
			}
		}
	}

	/**
	 * Render a single change card
	 */
	private renderChangeCard(container: HTMLElement, change: FileChange): void {
		const cardEl = container.createDiv({
			cls: "claude-multi-diff-card",
		});

		// Store reference for scrolling
		this.changeRefs.set(change.id, cardEl);

		// Error state
		if (change.error) {
			this.renderErrorCard(cardEl, change);
			return;
		}

		// File header
		const stats = this.computeChangeStats(change);
		const headerEl = cardEl.createDiv({ cls: "claude-multi-diff-card-header" });

		const headerLeft = headerEl.createDiv({ cls: "claude-multi-diff-card-header-left" });
		const fileIcon = headerLeft.createEl("span", { cls: "claude-multi-diff-card-icon" });
		setIcon(fileIcon, change.toolType === 'Write' ? "file-plus" : "file-edit");
		headerLeft.createEl("span", {
			text: change.filePath,
			cls: "claude-multi-diff-card-path"
		});

		const headerRight = headerEl.createDiv({ cls: "claude-multi-diff-card-header-right" });
		if (stats.deletions > 0) {
			headerRight.createSpan({
				text: `-${stats.deletions}`,
				cls: "claude-multi-diff-card-stat claude-multi-diff-card-stat--removed"
			});
		}
		if (stats.additions > 0) {
			headerRight.createSpan({
				text: `+${stats.additions}`,
				cls: "claude-multi-diff-card-stat claude-multi-diff-card-stat--added"
			});
		}

		// Diff content
		const contentEl = cardEl.createDiv({ cls: "claude-multi-diff-card-content" });

		if (change.unifiedDiff) {
			this.renderUnifiedDiff(contentEl, change.unifiedDiff);
		} else {
			this.renderInlineDiff(contentEl, change.original, change.modified);
		}
	}

	/**
	 * Render an error card for failed changes
	 */
	private renderErrorCard(container: HTMLElement, change: FileChange): void {
		const errorEl = container.createDiv({ cls: "claude-multi-diff-error" });

		const errorHeader = errorEl.createDiv({ cls: "claude-multi-diff-error-header" });
		const iconEl = errorHeader.createEl("span", { cls: "claude-multi-diff-error-icon" });
		setIcon(iconEl, "x-circle");
		errorHeader.createEl("span", {
			text: `${change.toolType} Failed`,
			cls: "claude-multi-diff-error-title"
		});

		errorEl.createEl("p", {
			text: change.error ?? "Unknown error",
			cls: "claude-multi-diff-error-message"
		});
	}

	/**
	 * Render unified diff format
	 */
	private renderUnifiedDiff(container: HTMLElement, unifiedDiff: string): void {
		const lines = unifiedDiff.split('\n');
		const diffEl = container.createDiv({ cls: "claude-multi-diff-unified" });

		for (const line of lines) {
			if (line.startsWith('@@')) {
				// Hunk header
				diffEl.createEl("div", {
					text: line,
					cls: "claude-multi-diff-line claude-multi-diff-line--hunk"
				});
			} else if (line.startsWith('+') && !line.startsWith('+++')) {
				// Addition
				diffEl.createEl("div", {
					text: line,
					cls: `claude-multi-diff-line claude-multi-diff-line--added ${this.settings.disableBackground ? 'claude-multi-diff-line--no-bg' : ''}`
				});
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				// Deletion
				diffEl.createEl("div", {
					text: line,
					cls: `claude-multi-diff-line claude-multi-diff-line--removed ${this.settings.disableBackground ? 'claude-multi-diff-line--no-bg' : ''}`
				});
			} else if (line.startsWith(' ') || line === '') {
				// Context
				diffEl.createEl("div", {
					text: line,
					cls: "claude-multi-diff-line claude-multi-diff-line--context"
				});
			} else if (line.startsWith('---') || line.startsWith('+++')) {
				// File header - skip or show minimally
				diffEl.createEl("div", {
					text: line,
					cls: "claude-multi-diff-line claude-multi-diff-line--file-header"
				});
			}
		}
	}

	/**
	 * Render inline diff from original/modified content
	 */
	private renderInlineDiff(container: HTMLElement, original: string, modified: string): void {
		const diff = generateInlineDiff(original, modified);
		const diffEl = container.createDiv({ cls: "claude-multi-diff-inline" });

		if (diff.length === 0) {
			diffEl.createEl("div", {
				text: "No changes",
				cls: "claude-multi-diff-empty"
			});
			return;
		}

		for (const line of diff) {
			const lineEl = diffEl.createEl("div", {
				cls: "claude-multi-diff-line"
			});

			// Prefix
			const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
			lineEl.createSpan({
				text: prefix,
				cls: `claude-multi-diff-line-prefix claude-multi-diff-line-prefix--${line.type}`
			});

			// Content
			const contentSpan = lineEl.createSpan({
				text: line.content,
				cls: `claude-multi-diff-line-content claude-multi-diff-line-content--${line.type} ${this.settings.disableBackground ? 'claude-multi-diff-line-content--no-bg' : ''}`
			});

			if (line.content === '') {
				contentSpan.addClass("claude-multi-diff-line-empty");
			}
		}
	}

	/**
	 * Refresh the entire view (used when settings change)
	 */
	private refreshView(): void {
		const contentEl = this.modalEl.querySelector(".claude-multi-diff-content") as HTMLElement | null;
		if (contentEl) {
			contentEl.empty();
			this.changeRefs.clear();
			this.renderContent();
		}
		this.renderHeader();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.changeRefs.clear();
	}
}

// Type helper for navigation elements
interface HTMLElementWithNav extends HTMLElement {
	dataset: {
		nav?: string;
	} & DOMStringMap;
}
