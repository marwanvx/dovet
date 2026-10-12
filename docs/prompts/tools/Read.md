Reads a file from the local filesystem.

- `file_path` may be absolute or relative to the working directory.
- Returns lines as `<line number><tab><text>`. Never include the line-number prefix when you copy text into Edit's old_string.
- Reads up to about 25,000 tokens per call. If a file is larger, you get the first part with a PARTIAL notice: continue with `offset` (1-based line) and `limit`, or find the part you need with Grep. If you truly need the whole file at once, set `allow_large: true`; it works when the context has room.
- Re-reading a file that hasn't changed returns a short note pointing to your earlier result instead of the content again.
- Images (PNG, JPEG, GIF, WebP) are shown to you visually. Short PDFs are read whole; longer ones need `pages` (e.g. "1-5"). Jupyter notebooks are returned with their outputs.
- To list a directory, use Glob or `ls`, not Read.
