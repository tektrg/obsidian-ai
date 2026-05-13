# Multi-File Diff Implementation

## Summary

Implemented a multi-file diff viewer for obsidian-ai that displays all file changes from an agent turn in a stacked layout (GitHub PR-style), similar to Craft Agents.

## Changes Made

### 1. New Types (`src/types/diff.ts`)
- `FileChange` - Interface for a single file change
- `FileSection` - Group of changes for a single file
- `DiffViewerSettings` - User preferences for diff display
- `DiffStats` - Addition/deletion statistics
- `MultiFileDiffOptions` - Options for opening the modal

### 2. New Component (`src/components/MultiFileDiffModal.ts`)
**Features:**
- **Stacked layout** - All files visible in a single scrollable area
- **File consolidation** - Multiple edits to same file are grouped together
- **Smart header** - Shows "X edits across Y files" for multi-file scenarios
- **Navigation controls** - Previous/Next buttons with file counter (for multi-file)
- **View toggles** - Unified/Split view toggle + background highlighting toggle
- **Settings persistence** - Preferences saved to localStorage
- **Error handling** - Failed edits shown with error banners
- **Scroll-to-change** - Can focus on specific change on open

**Methods:**
- `createFileSections()` - Groups changes by file path
- `computeTotalStats()` - Calculates total additions/deletions
- `renderChangeCard()` - Renders individual file diff
- `renderUnifiedDiff()` - Renders pre-computed unified diff format
- `renderInlineDiff()` - Renders computed diff from original/modified

### 3. Updated `src/main.ts`
- Added `editedFiles: Map` to track all edited files during a turn
- Added `trackFileEdit()` method to record file changes
- Added `getTurnFileChanges()` method to collect all changes for display
- Updated `clearTurnSnapshot()` to clear edited files

### 4. Updated `src/chat/ClaudeChatView.ts`
- Added import for `MultiFileDiffModal`
- Updated `showTurnDiff()` to use multi-file modal
- Updated `calculateDiffStats()` to use new tracking
- Updated `appendChangesPanel()` to show file count for multi-file scenarios

### 5. Styles (`styles.css`)
Added comprehensive styling for:
- Modal layout (90vw, max 1200px, 85vh height)
- Header with title, stats, controls, and navigation
- File cards with headers and diff content
- Diff lines with addition/deletion highlighting
- Error states with red borders
- Scrollbar styling
- Responsive controls

## Usage

### Opening Multi-File Diff

```typescript
// In chat view, when showing diff
const changes = await this.plugin.getTurnFileChanges();

if (changes.length > 0) {
  new MultiFileDiffModal(this.app, {
    changes,
    consolidated: true,  // Group multiple edits to same file
    focusedChangeId: "change-0",  // Optional: scroll to specific change
  }).open();
}
```

### Tracking File Edits

```typescript
// When agent edits a file
this.plugin.trackFileEdit(
  filePath,
  originalContent,
  modifiedContent,
  errorMessage  // Optional: if edit failed
);
```

## UI Structure

```
┌─────────────────────────────────────────────────────────────┐
│ [Icon] X edits across Y files              [-X +Y] [Controls]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ [Icon] src/main.ts                        [-5 +12]  │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ -│old line                                         │   │
│  │ +│new line                                         │   │
│  │  │context line                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ [Icon] src/settings.ts                    [-2 +8]   │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ ...                                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

1. **Stacked Layout** - GitHub PR-style view with all files visible
2. **File Consolidation** - Multiple edits to same file are grouped
3. **Smart Header** - Shows "X edits across Y files" or single file path
4. **View Controls** - Toggle between unified/split view and background highlighting
5. **Settings Persistence** - User preferences saved to localStorage
6. **Error Handling** - Failed edits shown with error banners
7. **Navigation** - Previous/Next buttons for multi-file scenarios
8. **Statistics** - Shows -X +Y stats for each file and total

## Settings

Settings are stored in `localStorage` under key `obsidian-ai-diff-settings`:

```typescript
interface DiffViewerSettings {
  diffStyle: 'unified' | 'split';
  disableBackground: boolean;
}
```

## Future Enhancements

Potential improvements:
1. **Syntax highlighting** - Add Shiki/Prism.js for language-aware coloring
2. **Split view** - Implement side-by-side diff view
3. **File filtering** - Filter by file type or search by path
4. **Export** - Export diff as patch file
5. **Accept/Reject** - Apply or discard individual changes
6. **Keyboard shortcuts** - Arrow keys for navigation, ESC to close
