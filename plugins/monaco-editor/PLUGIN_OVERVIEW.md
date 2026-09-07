Edit a file in bb instead of only reading it. It applies to every place where bb opens a file: chat links, the file search, and `bb thread open`. The editor is Monaco, the editor from VS Code.

## What you get

- Edit and save with Cmd+S, or Ctrl+S on Linux and Windows. If the file changed on disk since you opened it, the save stops and offers Reload or Overwrite.
- Find in file with Cmd+F or Ctrl+F, multiple cursors, block selection, bracket matching, and code folding.
- Syntax highlighting for about 86 common file types.
- A file tree that you toggle from the file bar. Filter by path, expand directories, and open another file. Right-click a row to copy its absolute path, relative path, or filename.
- Command palette actions for fold, unfold, sort selected lines, and copy the path of the current file.
- Colors that follow your bb theme, including light and dark switches and custom palettes.

## How it works

The plugin claims common code, configuration, and text extensions. Binary files such as images and PDFs stay with bb's own preview. Files larger than 8 MB open in the read-only preview.

To change the opener for one file type, go to Settings and open File openers. Right-click a file link for a one-off Open with choice.

There is no language server. Go-to-definition, find references, and type checking are not available.
