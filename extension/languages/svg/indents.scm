; Indent the body of an element between its start and end tags, and treat a
; dangling ">" / "/>" as the end of the tag being written.
(STag ">" @end) @indent

(EmptyElemTag "/>" @end) @indent

(element
  (STag) @start
  (ETag)? @end) @indent
