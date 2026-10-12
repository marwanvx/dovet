# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub's private vulnerability reporting: the **Security** tab of this repository → **Report a vulnerability**. Don't open a public issue.

Include what you found, how to reproduce it, and the Dovet version and OS.

## What counts

Anything that breaks Dovet's promises, including:

- **Sandbox escapes**: a command that reads or writes outside what the sandbox allows, or reaches the network when it shouldn't.
- A permission rule, mode or prompt that can be bypassed (a command runs that should have been denied or asked about).
- Secrets leaking into logs, receipts, bug reports or model requests.
- Tampered updates that `dovet update` or the install scripts accept.
- Anything that makes Dovet hide or misreport what it did, what it cost, or what it was told.

## Supported versions

Only the latest release gets security fixes.
