import { App, TFile, setIcon } from "obsidian";
import {
	parseFileMentions,
	insertFileMention,
	removeFileMention,
	getFileDisplayName,
} from "../mentions/FileMentionService";

export class FileMentionController {
	private promptInputEl: HTMLTextAreaElement;
	private dropdownEl: HTMLElement;
	private chipsEl: HTMLElement;
	private app: App;
	private onHeightChange: () => void;

	private isActive = false;
	private selectedIndex = 0;
	private searchQuery = "";
	private files: TFile[] = [];
	private cursorPosition = 0;

	constructor(
		promptInputEl: HTMLTextAreaElement,
		dropdownEl: HTMLElement,
		chipsEl: HTMLElement,
		app: App,
		onHeightChange: () => void
	) {
		this.promptInputEl = promptInputEl;
		this.dropdownEl = dropdownEl;
		this.chipsEl = chipsEl;
		this.app = app;
		this.onHeightChange = onHeightChange;
	}

	onInput(): void {
		this.updateChips();
	}

	onKeyup(): void {
		this.checkTrigger();
	}

	// Returns true if the event was handled (caller should not process further)
	handleKeydown(evt: KeyboardEvent): boolean {
		if (!this.isActive) return false;
		switch (evt.key) {
			case "ArrowDown":
				evt.preventDefault();
				this.selectNext();
				return true;
			case "ArrowUp":
				evt.preventDefault();
				this.selectPrevious();
				return true;
			case "Enter":
				evt.preventDefault();
				this.insertSelected();
				return true;
			case "Escape":
				evt.preventDefault();
				this.close();
				return true;
			default:
				return false;
		}
	}

	onClick(): void {
		this.close();
	}

	private checkTrigger(): void {
		const cursorPos = this.promptInputEl.selectionStart || 0;
		const text = this.promptInputEl.value;

		if (this.isActive) {
			const textAfterTrigger = text.slice(this.cursorPosition, cursorPos);
			if (/\s/.test(textAfterTrigger)) {
				this.close();
				return;
			}
			this.searchQuery = textAfterTrigger.toLowerCase();
			this.renderDropdown();
			return;
		}

		if (cursorPos > 0 && text[cursorPos - 1] === "@") {
			this.cursorPosition = cursorPos;
			this.searchQuery = "";
			this.open();
		}
	}

	private open(): void {
		const files = this.app.vault.getMarkdownFiles();
		files.sort((a, b) => b.stat.mtime - a.stat.mtime);
		this.files = files;
		this.selectedIndex = 0;
		this.isActive = true;
		this.renderDropdown();
		this.dropdownEl.style.display = "block";
	}

	private close(): void {
		this.isActive = false;
		this.dropdownEl.style.display = "none";
		this.dropdownEl.empty();
	}

	private renderDropdown(): void {
		this.dropdownEl.empty();

		const filtered = this.searchQuery
			? this.files.filter(
				(f) =>
					f.name.toLowerCase().includes(this.searchQuery) ||
					f.path.toLowerCase().includes(this.searchQuery)
			)
			: this.files.slice(0, 50);

		if (filtered.length === 0) {
			this.dropdownEl.createDiv({ cls: "claude-chat-mention-item", text: "No files found" });
			return;
		}

		filtered.forEach((file, index) => {
			const item = this.dropdownEl.createDiv({ cls: "claude-chat-mention-item" });
			if (index === this.selectedIndex) item.addClass("is-selected");

			const topRow = item.createDiv({ cls: "claude-chat-mention-item-top" });
			const iconEl = topRow.createSpan({ cls: "claude-chat-mention-item-icon" });
			setIcon(iconEl, "file-text");
			topRow.createSpan({ cls: "claude-chat-mention-item-name", text: file.name });

			if (file.parent?.path && file.parent.path !== "/") {
				item.createDiv({ cls: "claude-chat-mention-item-path", text: file.parent.path });
			}

			item.addEventListener("click", () => this.insertAt(file.path));
		});
	}

	private selectNext(): void {
		this.selectedIndex = Math.min(this.selectedIndex + 1, this.files.length - 1);
		this.renderDropdown();
	}

	private selectPrevious(): void {
		this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
		this.renderDropdown();
	}

	private insertSelected(): void {
		const file = this.files[this.selectedIndex];
		if (file) this.insertAt(file.path);
	}

	private insertAt(filePath: string): void {
		const cursorPos = this.promptInputEl.selectionStart || 0;
		const text = this.promptInputEl.value;
		const beforeTrigger = text.slice(0, cursorPos - 1);
		const afterCursor = text.slice(cursorPos);

		const { newText, newCursorPos } = insertFileMention(
			beforeTrigger + afterCursor,
			cursorPos - 1,
			filePath
		);

		this.promptInputEl.value = newText;
		this.promptInputEl.setSelectionRange(newCursorPos, newCursorPos);
		this.promptInputEl.focus();

		this.close();
		this.updateChips();
		this.onHeightChange();
	}

	private updateChips(): void {
		const text = this.promptInputEl.value;
		const mentions = parseFileMentions(text);

		this.chipsEl.empty();

		if (mentions.files.length === 0) {
			this.chipsEl.style.display = "none";
			return;
		}

		this.chipsEl.style.display = "flex";

		mentions.files.forEach((filePath) => {
			const chip = this.chipsEl.createDiv({ cls: "claude-chat-mention-chip" });
			const iconEl = chip.createSpan();
			setIcon(iconEl, "file-text");
			chip.createSpan({ text: getFileDisplayName(filePath) });

			const removeBtn = chip.createEl("button", {
				cls: "claude-chat-mention-chip-remove",
				text: "×",
			});
			removeBtn.addEventListener("click", () => this.removeFile(filePath));
		});
	}

	private removeFile(filePath: string): void {
		this.promptInputEl.value = removeFileMention(this.promptInputEl.value, filePath);
		this.updateChips();
	}
}
