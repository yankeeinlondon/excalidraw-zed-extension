---
reviewed: false
clarified: false
---

# Editor not Preview

We have always called this extension the Excalidraw Preview but "preview" was never the right name because it's not a read-only previewer but instead a full blown editor. In this features we will:

1. change all nomenclature from "Preview" to "Editor"; make binary just "excalidraw" (not "excalidraw-preview" or "excalidraw-editor")
2. add in the ability use it as a desktop application, not just as a Zed Extension

## Desktop Application

We can already bring up excalidraw to edit a file with `excalidraw-preview <filename>` and create a new file with `excalidraw-preview --new <filename>` but we now need to add:

- handling a call to the CLI with no parameters will bring up a native file system dialog so user can choose a file
- allow CTRL+O and CMD+O to bring up a file system dialog
