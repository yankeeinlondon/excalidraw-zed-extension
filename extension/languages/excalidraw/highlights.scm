; Excalidraw's bare `.excalidraw` format is JSON, so this highlights the
; tree-sitter-json tree. Pattern order matters: Zed resolves the first matching
; capture, so the object-key rule must precede the generic `(string)` rule.

(pair
  key: (string) @property)

(string) @string

(number) @number

[
  (null)
  (true)
  (false)
] @constant.builtin

(escape_sequence) @string.escape

(comment) @comment

[
  ","
  ":"
] @punctuation.delimiter

[
  "{"
  "}"
  "["
  "]"
] @punctuation.bracket

; A malformed scene shows up as a highlighted parse error rather than silently
; looking fine — this is the "is my hand-edit still valid JSON?" signal.
(ERROR) @error
