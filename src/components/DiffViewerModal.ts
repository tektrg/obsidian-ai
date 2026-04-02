import { App, Modal, setIcon } from "obsidian";
import { generateInlineDiff, getDiffStats, type DiffLine } from "../utils/DiffGenerator";

export interface DiffViewerOptions {
  originalContent: string;
  modifiedContent: string;
  actionType: "replace-selection" | "append-note" | "replace-note";
  filePath: string;
}

export class DiffViewerModal extends Modal {
  private readonly options: DiffViewerOptions;

  constructor(app: App, options: DiffViewerOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("claude-diff-modal");

    // Header
    const headerEl = contentEl.createDiv({ cls: "claude-diff-header" });
    const titleWrap = headerEl.createDiv({ cls: "claude-diff-title-wrap" });
    
    const titleText = this.getActionTitle();
    titleWrap.createEl("h3", { text: titleText, cls: "claude-diff-title" });
    
    // Close button
    const closeBtn = headerEl.createEl("button", {
      cls: "claude-diff-close-btn clickable-icon",
      attr: { "aria-label": "Close" }
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());

    // File info
    const infoEl = contentEl.createDiv({ cls: "claude-diff-info" });
    infoEl.createEl("div", { 
      text: `File: ${this.options.filePath}`,
      cls: "claude-diff-file-path" 
    });
    infoEl.createEl("div", { 
      text: `Action: ${this.getActionDescription()}`,
      cls: "claude-diff-action-type" 
    });

    // Stats
    const diff = generateInlineDiff(this.options.originalContent, this.options.modifiedContent);
    const stats = getDiffStats(diff);
    
    const statsEl = contentEl.createDiv({ cls: "claude-diff-stats" });
    if (stats.added > 0) {
      statsEl.createSpan({ 
        text: `+${stats.added} lines`, 
        cls: "claude-diff-stat claude-diff-stat--added" 
      });
    }
    if (stats.removed > 0) {
      statsEl.createSpan({ 
        text: `-${stats.removed} lines`, 
        cls: "claude-diff-stat claude-diff-stat--removed" 
      });
    }
    if (stats.unchanged > 0) {
      statsEl.createSpan({ 
        text: `${stats.unchanged} unchanged`, 
        cls: "claude-diff-stat claude-diff-stat--unchanged" 
      });
    }

    // Diff content
    const contentContainer = contentEl.createDiv({ cls: "claude-diff-content-container" });
    const diffContent = contentContainer.createDiv({ cls: "claude-diff-content" });
    
    if (diff.length === 0) {
      diffContent.createEl("div", { 
        text: "No changes",
        cls: "claude-diff-empty" 
      });
    } else {
      for (const line of diff) {
        this.renderDiffLine(diffContent, line);
      }
    }

    // Footer actions
    const actionsEl = contentEl.createDiv({ cls: "claude-diff-actions" });
    const closeActionBtn = actionsEl.createEl("button", { 
      text: "Close",
      cls: "claude-diff-close-action-btn"
    });
    closeActionBtn.addEventListener("click", () => this.close());
  }

  private renderDiffLine(container: HTMLElement, line: DiffLine): void {
    const lineEl = container.createDiv({ 
      cls: `claude-diff-line claude-diff-line--${line.type}` 
    });
    
    // Prefix indicator
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    lineEl.createSpan({ 
      text: prefix,
      cls: "claude-diff-line-prefix" 
    });
    
    // Line content
    const contentSpan = lineEl.createSpan({ 
      text: line.content,
      cls: "claude-diff-line-content" 
    });
    
    // Handle empty lines
    if (line.content === '') {
      contentSpan.addClass("claude-diff-line-empty");
    }
  }

  private getActionTitle(): string {
    switch (this.options.actionType) {
      case "replace-selection":
        return "Diff: Replace Selection";
      case "append-note":
        return "Diff: Append to Note";
      case "replace-note":
        return "Diff: Replace Note";
      default:
        return "View Diff";
    }
  }

  private getActionDescription(): string {
    switch (this.options.actionType) {
      case "replace-selection":
        return "Replace selected text";
      case "append-note":
        return "Append to end of note";
      case "replace-note":
        return "Replace entire note";
      default:
        return "Unknown action";
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
