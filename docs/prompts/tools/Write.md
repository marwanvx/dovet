Creates a new file or replaces an existing file's entire content.

- Prefer Edit for changes to existing files; use Write for new files or complete rewrites.
- Overwriting an existing file requires having read it in this session, unless it could be read without asking. If the file changed since you read it, read it again first.
- Always write the complete content. Never use placeholders such as "// ... rest of the code unchanged"; they would replace real code and are rejected.
- Parent directories are created as needed. The file's existing encoding and line endings are preserved.
- Don't create documentation or README files unless asked.
