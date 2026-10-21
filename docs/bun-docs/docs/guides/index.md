# Guides

Code samples and walkthroughs for common tasks with Bun.

Bun guides are short, practical recipes organized by topic. Each guide shows a complete, runnable example using Bun's APIs — from deploying to various platforms and building HTTP servers, to reading/writing files, working with binary data, and integrating with popular frameworks.

## Deployment

- [Deploy a Bun application on AWS Lambda](deployment/aws-lambda.md)
- [Deploy a Bun application on DigitalOcean](deployment/digital-ocean.md)
- [Deploy a Bun application on Google Cloud Run](deployment/google-cloud-run.md)
- [Deploy a Bun application on Railway](deployment/railway.md): Deploy a Bun application to Railway from the CLI or dashboard, with optional PostgreSQL setup and automatic SSL
- [Deploy a Bun application on Render](deployment/render.md)
- [Deploy a Bun application on Vercel](deployment/vercel.md)

## Runtime

- [Build-time constants with --define](runtime/build-time-constants.md)
- [Codesign a single-file JavaScript executable on macOS](runtime/codesign-macos-executable.md): Fix the "can't be opened because it is from an unidentified developer" Gatekeeper warning when running your JavaScript executable.
- [Debugging Bun with the VS Code extension](runtime/vscode-debugger.md)
- [Debugging Bun with the web debugger](runtime/web-debugger.md)
- [Define and replace static globals & constants](runtime/define-constant.md)
- [Delete directories](runtime/delete-directory.md)
- [Delete files](runtime/delete-file.md)
- [Import a HTML file as text](runtime/import-html.md)
- [Import a JSON file](runtime/import-json.md)
- [Import a JSON5 file](runtime/import-json5.md)
- [Import a TOML file](runtime/import-toml.md)
- [Import a YAML file](runtime/import-yaml.md)
- [Import an XML file](runtime/import-xml.md)
- [Inspect memory usage using V8 heap snapshots](runtime/heap-snapshot.md)
- [Install and run Bun in GitHub Actions](runtime/cicd.md)
- [Install TypeScript declarations for Bun](runtime/typescript.md)
- [Re-map import paths](runtime/tsconfig-paths.md)
- [Read environment variables](runtime/read-env.md)
- [Run a Shell Command](runtime/shell.md)
- [Set a time zone in Bun](runtime/timezone.md)
- [Set environment variables](runtime/set-env.md)

## Utilities

- [Check if the current file is the entrypoint](util/entrypoint.md)
- [Check if two objects are deeply equal](util/deep-equals.md)
- [Compress and decompress data with DEFLATE](util/deflate.md)
- [Compress and decompress data with gzip](util/gzip.md)
- [Convert a file URL to an absolute path](util/file-url-to-path.md)
- [Convert an absolute path to a file URL](util/path-to-file-url.md)
- [Detect when code is executed with Bun](util/detect-bun.md)
- [Encode and decode base64 data](util/base64.md)
- [Escape an HTML string](util/escape-html.md)
- [Generate a UUID](util/javascript-uuid.md)
- [Get the absolute path of the current file](util/import-meta-path.md)
- [Get the absolute path to the current entrypoint](util/main.md)
- [Get the current Bun version](util/version.md)
- [Get the directory of the current file](util/import-meta-dir.md)
- [Get the file name of the current file](util/import-meta-file.md)
- [Get the path to an executable bin file](util/which-path-to-executable-bin.md)
- [Hash a password](util/hash-a-password.md)
- [Sleep for a fixed number of milliseconds](util/sleep.md)
- [Upgrade Bun to the latest version](util/upgrade.md)

## Ecosystem

- [Add Sentry to a Bun app](ecosystem/sentry.md)
- [Build a frontend using Vite and Bun](ecosystem/vite.md)
- [Build a React app with Bun](ecosystem/react.md)
- [Build an app with Astro and Bun](ecosystem/astro.md)
- [Build an app with Next.js and Bun](ecosystem/nextjs.md)
- [Build an app with Nuxt and Bun](ecosystem/nuxt.md)
- [Build an app with Qwik and Bun](ecosystem/qwik.md)
- [Build an app with Remix and Bun](ecosystem/remix.md)
- [Build an app with SolidStart and Bun](ecosystem/solidstart.md)
- [Build an app with SvelteKit and Bun](ecosystem/sveltekit.md)
- [Build an HTTP server using Elysia and Bun](ecosystem/elysia.md)
- [Build an HTTP server using Express and Bun](ecosystem/express.md)
- [Build an HTTP server using Hono and Bun](ecosystem/hono.md)
- [Bun Redis with Upstash](ecosystem/upstash.md)
- [Containerize a Bun application with Docker](ecosystem/docker.md)
- [Create a Discord bot](ecosystem/discordjs.md)
- [Read and write data to MongoDB using Mongoose and Bun](ecosystem/mongoose.md)
- [Run Bun as a daemon with PM2](ecosystem/pm2.md)
- [Run Bun as a daemon with systemd](ecosystem/systemd.md)
- [Server-side render (SSR) a React component](ecosystem/ssr-react.md)
- [Use Drizzle ORM with Bun](ecosystem/drizzle.md)
- [Use Gel with Bun](ecosystem/gel.md)
- [Use Neon Postgres through Drizzle ORM](ecosystem/neon-drizzle.md)
- [Use Neon's Serverless Postgres with Bun](ecosystem/neon-serverless-postgres.md)
- [Use Prisma Postgres with Bun](ecosystem/prisma-postgres.md)
- [Use Prisma with Bun](ecosystem/prisma.md)
- [Use TanStack Start with Bun](ecosystem/tanstack-start.md)

## HTTP

- [Common HTTP server usage](http/server.md)
- [Configure TLS on an HTTP server](http/tls.md)
- [fetch with unix domain sockets in Bun](http/fetch-unix.md)
- [Hot reload an HTTP server](http/hot.md)
- [Proxy HTTP requests using fetch()](http/proxy.md)
- [Send an HTTP request using fetch](http/fetch.md)
- [Server-Sent Events (SSE) with Bun](http/sse.md)
- [Start a cluster of HTTP servers](http/cluster.md): Run multiple HTTP servers concurrently with the "reusePort" option to share the same port across multiple processes
- [Stream a file as an HTTP Response](http/stream-file.md)
- [Streaming HTTP Server with Async Iterators](http/stream-iterator.md)
- [Streaming HTTP Server with Node.js Streams](http/stream-node-streams-in-bun.md)
- [Upload files via HTTP using FormData](http/file-uploads.md)
- [Write a simple HTTP server](http/simple.md)

## WebSocket

- [Build a publish-subscribe WebSocket server](websocket/pubsub.md)
- [Build a simple WebSocket server](websocket/simple.md)
- [Enable compression for WebSocket messages](websocket/compression.md)
- [Set per-socket contextual data on a WebSocket](websocket/context.md)

## Process & child processes

- [Get the process uptime in nanoseconds](process/nanoseconds.md)
- [Listen for CTRL+C](process/ctrl-c.md)
- [Listen to OS signals](process/os-signals.md)
- [Parse command-line arguments](process/argv.md)
- [Read from stdin](process/stdin.md)
- [Read stderr from a child process](process/spawn-stderr.md)
- [Read stdout from a child process](process/spawn-stdout.md)
- [Spawn a child process](process/spawn.md)
- [Spawn a child process and communicate using IPC](process/ipc.md)

## Package installation

- [Add a dependency](install/add.md)
- [Add a development dependency](install/add-dev.md)
- [Add a Git dependency](install/add-git.md)
- [Add a peer dependency](install/add-peer.md)
- [Add a tarball dependency](install/add-tarball.md)
- [Add a trusted dependency](install/trusted.md)
- [Add an optional dependency](install/add-optional.md)
- [Configure a private registry for an organization scope with bun install](install/registry-scope.md)
- [Configure git to diff Bun's lockb lockfile](install/git-diff-bun-lockfile.md)
- [Configuring a monorepo using workspaces](install/workspaces.md)
- [Generate a yarn-compatible lockfile](install/yarnlock.md)
- [Install a package under a different name](install/npm-alias.md)
- [Install dependencies with Bun in GitHub Actions](install/cicd.md)
- [Migrate from npm install to bun install](install/from-npm-install-to-bun-install.md)
- [Override the default npm registry for bun install](install/custom-registry.md)
- [Using bun install with an Azure Artifacts npm registry](install/azure-artifacts.md)
- [Using bun install with Artifactory](install/jfrog-artifactory.md)

## Testing

- [Bail early with the Bun test runner](test/bail.md)
- [Generate code coverage reports with the Bun test runner](test/coverage.md)
- [import, require, and test Svelte components with bun test](test/svelte-test.md)
- [Mark a test as a "todo" with the Bun test runner](test/todo-tests.md)
- [Migrate from Jest to Bun's test runner](test/migrate-from-jest.md)
- [Mock functions in `bun test`](test/mock-functions.md)
- [Re-run tests multiple times with the Bun test runner](test/rerun-each.md)
- [Run tests in watch mode with Bun](test/watch-mode.md)
- [Run your tests with the Bun test runner](test/run-tests.md)
- [Selectively run tests concurrently with glob patterns](test/concurrent-test-glob.md): Set a glob pattern to decide which tests from which files run in parallel
- [Set a code coverage threshold with the Bun test runner](test/coverage-threshold.md)
- [Set a per-test timeout with the Bun test runner](test/timeout.md)
- [Set the system time in Bun's test runner](test/mock-clock.md)
- [Skip tests with the Bun test runner](test/skip-tests.md)
- [Spy on methods in `bun test`](test/spy-on.md)
- [Update snapshots in `bun test`](test/update-snapshots.md)
- [Use snapshot testing in `bun test`](test/snapshot.md)
- [Using Testing Library with Bun](test/testing-library.md)
- [Write browser DOM tests with Bun and happy-dom](test/happy-dom.md)

## Reading files

- [Check if a file exists](read-file/exists.md)
- [Get the MIME type of a file](read-file/mime.md)
- [Read a file as a ReadableStream](read-file/stream.md)
- [Read a file as a string](read-file/string.md)
- [Read a file to a Buffer](read-file/buffer.md)
- [Read a file to a Uint8Array](read-file/uint8array.md)
- [Read a file to an ArrayBuffer](read-file/arraybuffer.md)
- [Read a JSON file](read-file/json.md)
- [Watch a directory for changes](read-file/watch.md)

## Writing files

- [Append content to a file](write-file/append.md)
- [Copy a file to another location](write-file/file-cp.md)
- [Delete a file](write-file/unlink.md)
- [Write a Blob to a file](write-file/blob.md)
- [Write a file incrementally](write-file/filesink.md)
- [Write a file to stdout](write-file/cat.md)
- [Write a ReadableStream to a file](write-file/stream.md)
- [Write a Response to a file](write-file/response.md)
- [Write a string to a file](write-file/basic.md)
- [Write to stdout](write-file/stdout.md)

## HTMLRewriter

- [Extract links from a webpage using HTMLRewriter](html-rewriter/extract-links.md)
- [Extract social share images and Open Graph tags](html-rewriter/extract-social-meta.md)

## Binary data

- [Convert a Blob to a DataView](binary/blob-to-dataview.md)
- [Convert a Blob to a ReadableStream](binary/blob-to-stream.md)
- [Convert a Blob to a string](binary/blob-to-string.md)
- [Convert a Blob to a Uint8Array](binary/blob-to-typedarray.md)
- [Convert a Blob to an ArrayBuffer](binary/blob-to-arraybuffer.md)
- [Convert a Buffer to a blob](binary/buffer-to-blob.md)
- [Convert a Buffer to a ReadableStream](binary/buffer-to-readablestream.md)
- [Convert a Buffer to a string](binary/buffer-to-string.md)
- [Convert a Buffer to a Uint8Array](binary/buffer-to-typedarray.md)
- [Convert a Buffer to an ArrayBuffer](binary/buffer-to-arraybuffer.md)
- [Convert a DataView to a string](binary/dataview-to-string.md)
- [Convert a Uint8Array to a Blob](binary/typedarray-to-blob.md)
- [Convert a Uint8Array to a Buffer](binary/typedarray-to-buffer.md)
- [Convert a Uint8Array to a DataView](binary/typedarray-to-dataview.md)
- [Convert a Uint8Array to a ReadableStream](binary/typedarray-to-readablestream.md)
- [Convert a Uint8Array to a string](binary/typedarray-to-string.md)
- [Convert a Uint8Array to an ArrayBuffer](binary/typedarray-to-arraybuffer.md)
- [Convert an ArrayBuffer to a Blob](binary/arraybuffer-to-blob.md)
- [Convert an ArrayBuffer to a Buffer](binary/arraybuffer-to-buffer.md)
- [Convert an ArrayBuffer to a string](binary/arraybuffer-to-string.md)
- [Convert an ArrayBuffer to a Uint8Array](binary/arraybuffer-to-typedarray.md)
- [Convert an ArrayBuffer to an array of numbers](binary/arraybuffer-to-array.md)

## Streams

- [Convert a Node.js Readable to a Blob](streams/node-readable-to-blob.md)
- [Convert a Node.js Readable to a string](streams/node-readable-to-string.md)
- [Convert a Node.js Readable to an ArrayBuffer](streams/node-readable-to-arraybuffer.md)
- [Convert a Node.js Readable to an Uint8Array](streams/node-readable-to-uint8array.md)
- [Convert a Node.js Readable to JSON](streams/node-readable-to-json.md)
- [Convert a ReadableStream to a Blob](streams/to-blob.md)
- [Convert a ReadableStream to a Buffer](streams/to-buffer.md)
- [Convert a ReadableStream to a string](streams/to-string.md)
- [Convert a ReadableStream to a Uint8Array](streams/to-typedarray.md)
- [Convert a ReadableStream to an array of chunks](streams/to-array.md)
- [Convert a ReadableStream to an ArrayBuffer](streams/to-arraybuffer.md)
- [Convert a ReadableStream to JSON](streams/to-json.md)
