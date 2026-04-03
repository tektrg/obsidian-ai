import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

function isUsableMarkdownView(view: MarkdownView | null | undefined): view is MarkdownView {
	if (!view) {
		return false;
	}
	const file = view.file;
	if (!file || !(file instanceof TFile) || file.extension !== "md") {
		return false;
	}
	return true;
}

function resolveMarkdownViewFromLeaf(leaf: WorkspaceLeaf | null | undefined): MarkdownView | null {
	if (!leaf) {
		return null;
	}
	const view = leaf.view;
	if (view instanceof MarkdownView && isUsableMarkdownView(view)) {
		return view;
	}
	return null;
}

export function resolveMarkdownView(app: App): MarkdownView | null {
	const activeLeafView = resolveMarkdownViewFromLeaf(app.workspace.activeLeaf);
	if (activeLeafView) {
		return activeLeafView;
	}

	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	if (isUsableMarkdownView(activeView)) {
		return activeView;
	}

	const mostRecentLeafView = resolveMarkdownViewFromLeaf(app.workspace.getMostRecentLeaf());
	if (mostRecentLeafView) {
		return mostRecentLeafView;
	}

	const markdownLeaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of markdownLeaves) {
		const view = resolveMarkdownViewFromLeaf(leaf);
		if (view) {
			return view;
		}
	}

	return null;
}

export function resolveMarkdownViewForFile(app: App, filePath: string): MarkdownView | null {
	const markdownLeaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of markdownLeaves) {
		const view = resolveMarkdownViewFromLeaf(leaf);
		if (view?.file?.path === filePath) {
			return view;
		}
	}
	return null;
}
