# Bun Runtime

> Execute JavaScript/TypeScript files, package.json scripts, and executable packages with Bun's fast runtime.

The Bun Runtime is designed to start fast and run fast.

Bun uses the [JavaScriptCore engine](https://developer.apple.com/documentation/javascriptcore), developed by Apple for Safari. JavaScriptCore usually starts and runs faster than V8, the engine used by Node.js and Chromium-based browsers. Bun's transpiler and runtime are written in Rust. On Linux, Bun starts [4x faster](https://twitter.com/jarredsumner/status/1499225725492076544) than Node.js.

| Command         | Time     |
| --------------- | -------- |
| `bun hello.js`  | `5.2ms`  |
| `node hello.js` | `25.1ms` |

The benchmark runs a Hello World script on Linux.

## Run a file

Use `bun run` to execute a source file.

```bash terminal icon="terminal"
bun run index.js
```

Bun supports TypeScript and JSX with no configuration. Bun transpiles every file on the fly with its native [transpiler](/runtime/transpiler) before running it.

```bash terminal icon="terminal"
bun run index.js
bun run index.jsx
bun run index.ts
bun run index.tsx
```

Alternatively, you can omit the `run` keyword and use the "naked" command; it behaves identically.

```bash terminal icon="terminal"
bun index.tsx
bun index.js
```

### `--watch`

To run a file in watch mode, use the `--watch` flag.

```bash terminal icon="terminal"
bun --watch run index.tsx
```

<Note>
When using `bun run`, put Bun flags like `--watch` immediately after `bun`.

```bash
bun --watch run dev # ✔️ do this
bun run dev --watch # ❌ don't do this
```

`bun` ignores flags at the end of the command and passes them through to the `"dev"` script itself.

</Note>

### `--check`

Bun runs TypeScript files without checking their types. To type check a file and everything it imports before Bun runs it, use the `--check` flag.

```bash terminal icon="terminal"
bun --check index.tsx
```

If there is a type error, Bun prints it, exits with code `1`, and does not run the file. See [`bun check`](/runtime/check#check-before-you-run-build-or-test).

## Run a `package.json` script

<Note>
Compare to `npm run <script>` or `yarn <script>`
</Note>

```sh
bun [bun flags] run <script> [script flags]
```

Your `package.json` can define named `"scripts"` that correspond to shell commands.

```json package.json icon="file-json"
{
  // ... other fields
  "scripts": {
    "clean": "rm -rf dist && echo 'Done.'",
    "dev": "bun server.ts"
  }
}
```

Use `bun run <script>` to execute these scripts.

```bash terminal icon="terminal"
bun run clean
rm -rf dist && echo 'Done.'
```

```txt
Done.
```

Bun executes the script command in a subshell. On Linux & macOS, it checks for the following shells in order, using the first one it finds: `bash`, `sh`, `zsh`. On Windows, it uses the [Bun Shell](/runtime/shell) to support bash-like syntax and many common commands.

<Note>⚡️ The startup time for `npm run` on Linux is roughly 170ms; with Bun it is `6ms`.</Note>

You can also run scripts with the shorter command `bun <script>`. If a built-in `bun` command has the same name, the built-in command takes precedence; use the explicit `bun run <script>` to run your package script instead.

```bash terminal icon="terminal"
bun run dev
```

To see a list of available scripts, run `bun run` without any arguments.

```bash terminal icon="terminal"
bun run
```

```txt
...
package.json scripts (2 found):
  $ bun run clean
    rm -rf dist && echo 'Done.'

  $ bun run dev
    bun server.ts
```

Bun respects lifecycle hooks. For instance, `bun run clean` runs `preclean` and `postclean`, if defined. If the `pre<script>` fails, Bun does not run the script itself.

### `--bun`

It's common for `package.json` scripts to reference locally-installed CLIs like `vite` or `next`. These CLIs are often JavaScript files marked with a [shebang](<https://en.wikipedia.org/wiki/Shebang_(Unix)>) to indicate that they should be executed with `node`.

```js cli.js icon="/icons/javascript.svg"
#!/usr/bin/env node

// do stuff
```

By default, Bun respects this shebang and executes the script with `node`. The `--bun` flag overrides it: the CLI runs with Bun instead of Node.js.

```bash terminal icon="terminal"
bun run --bun vite
```

### Filtering

In a monorepo, the `--filter` argument runs a script in many packages at once.

`bun run --filter <pattern> <script>` executes `<script>` in every package selected by `<pattern>`. The pattern can be a package name glob, a `./path`, a `{dir}` directory or a dependency relation like `foo...`.
For example, if you have subdirectories containing packages named `foo`, `bar` and `baz`, running

```bash terminal icon="terminal"
bun run --filter 'ba*' <script>
```

executes `<script>` in both `bar` and `baz`, but not in `foo`.

See [`--filter`](/pm/filter#running-scripts-with-filter).

## `bun run -` to pipe code from stdin

`bun run -` reads JavaScript, TypeScript, TSX, or JSX from stdin and executes it without writing to a temporary file first.

```bash terminal icon="terminal"
echo "console.log('Hello')" | bun run -
```

```txt
Hello
```

You can also use `bun run -` to redirect files into Bun. For example, to run a `.js` file as if it were a `.ts` file:

```bash terminal icon="terminal"
echo "console.log!('This is TypeScript!' as any)" > secretly-typescript.js
bun run - < secretly-typescript.js
```

```txt
This is TypeScript!
```

`bun run -` treats all input as TypeScript with JSX support.

## `bun run --console-depth`

Control the depth of object inspection in console output with the `--console-depth` flag.

```bash terminal icon="terminal"
bun --console-depth 5 run index.tsx
```

`--console-depth` sets how deeply Bun displays nested objects in `console.log()` output. The default depth is `2`. Higher values show more nested properties but may produce verbose output for complex objects.

```ts console.ts icon="/icons/typescript.svg"
const nested = { a: { b: { c: { d: "deep" } } } };
console.log(nested);
// With --console-depth 2 (default): { a: { b: { c: [Object] } } }
// With --console-depth 4: { a: { b: { c: { d: 'deep' } } } }
```

## `bun run --smol`

In memory-constrained environments, use the `--smol` flag to reduce memory usage at a cost to performance.

```bash terminal icon="terminal"
bun --smol run index.tsx
```

`--smol` makes the garbage collector run more frequently, which can slow down execution. Bun adjusts the garbage collector's heap size based on the available memory (accounting for cgroups and other memory limits) with and without the `--smol` flag. The flag is therefore mostly useful when you want the heap to grow more slowly.

## Resolution order

Bun always executes absolute paths and paths starting with `./` or `.\\` as source files. Unless you use `bun run`, a name with an allowed extension resolves to the file rather than a `package.json` script.

When a `package.json` script and a file have the same name, `bun run` prefers the script. The full resolution order is:

1. `package.json` scripts: `bun run build`
2. Source files: `bun run src/main.js`
3. Binaries from project packages: `bun add eslint && bun run eslint`
4. (`bun run` only) System commands: `bun run ls`

---

# CLI Usage

```bash
bun run <file or script>
```

### General Execution Options

<ParamField path="--silent" type="boolean">
  Don't print the script command
</ParamField>

<ParamField path="--if-present" type="boolean">
  Exit without an error if the entrypoint does not exist
</ParamField>

<ParamField path="--eval" type="string">
  Evaluate argument as a script. Alias: <code>-e</code>
</ParamField>

<ParamField path="--print" type="string">
  Evaluate argument as a script and print the result. Alias: <code>-p</code>
</ParamField>

<ParamField path="--help" type="boolean">
  Display this menu and exit. Alias: <code>-h</code>
</ParamField>

### Workspace Management

<ParamField path="--elide-lines" type="number" default="0">
  Truncate each script's output to its last N lines when using --filter. Default 0 shows all lines
</ParamField>

<ParamField path="--filter" type="string">
  Run a script in all workspace packages matching the pattern. Alias: <code>-F</code>
</ParamField>

<ParamField path="--workspaces" type="boolean">
  Run a script in all workspace packages (from the <code>workspaces</code> field in <code>package.json</code>)
</ParamField>

<ParamField path="--parallel" type="boolean">
  Run multiple scripts or workspace scripts concurrently with prefixed output
</ParamField>

<ParamField path="--sequential" type="boolean">
  Run multiple scripts or workspace scripts one after another with prefixed output
</ParamField>

<ParamField path="--no-exit-on-error" type="boolean">
  When using <code>--parallel</code> or <code>--sequential</code>, continue running other scripts when one fails
</ParamField>

### Runtime &amp; Process Control

<ParamField path="--bun" type="boolean">
  Force a script or package to use Bun's runtime instead of Node.js (via symlinking node). Alias: <code>-b</code>
</ParamField>

<ParamField path="--shell" type="string">
  Control the shell used for <code>package.json</code> scripts. Supports either <code>bun</code> or <code>system</code>
</ParamField>

<ParamField path="--interactive" type="boolean">
  Open the Node.js-compatible REPL (<code>node:repl</code>). When combined with <code>-e</code>, starts the REPL and
  then evaluates the script. Under <code>--interactive</code>, <code>-e</code> is raw JavaScript (matching{" "}
  <code>node -i -e</code>). Use <code>bun repl</code> for TypeScript. Distinct from <code>bun repl</code>, which is
  Bun's native REPL.
</ParamField>

<ParamField path="--smol" type="boolean">
  Use less memory, but run garbage collection more often
</ParamField>

<ParamField path="--expose-gc" type="boolean">
  Expose <code>gc()</code> on the global object. Has no effect on <code>Bun.gc()</code>
</ParamField>

<ParamField path="--no-deprecation" type="boolean">
  Silence all deprecation warnings
</ParamField>

<ParamField path="--throw-deprecation" type="boolean">
  Throw deprecation warnings as errors
</ParamField>

<ParamField path="--title" type="string">
  Set the process title
</ParamField>

<ParamField path="--zero-fill-buffers" type="boolean">
  Force <code>Buffer.allocUnsafe(size)</code> to be zero-filled
</ParamField>

<ParamField path="--no-addons" type="boolean">
  Throw an error if <code>process.dlopen</code> or <code>bun:ffi</code> <code>cc()</code> is called, and disable export
  condition <code>node-addons</code>
</ParamField>

<ParamField path="--no-ffi-cc" type="boolean">
  Throw an error if <code>bun:ffi</code> <code>cc()</code> is called (disables the C compiler)
</ParamField>

<ParamField path="--unhandled-rejections" type="string">
  One of <code>strict</code>, <code>throw</code>, <code>warn</code>, <code>none</code>, or{" "}
  <code>warn-with-error-code</code>
</ParamField>

<ParamField path="--console-depth" type="number" default="2">
  Set the default depth for <code>console.log</code> object inspection (default: 2)
</ParamField>

### Development Workflow

<ParamField path="--check" type="boolean">
  Type check before running. Nothing runs if there are type errors. See <a href="/runtime/check">bun check</a>
</ParamField>

<ParamField path="--watch" type="boolean">
  Automatically restart the process on file change
</ParamField>

<ParamField path="--watch-kill-signal" type="string" default="SIGTERM">
  Signal whose handlers run when --watch restarts the process
</ParamField>

<ParamField path="--hot" type="boolean">
  Enable auto reload in the Bun runtime, test runner, or bundler
</ParamField>

<ParamField path="--no-clear-screen" type="boolean">
  Disable clearing the terminal screen on reload when --hot or --watch is enabled
</ParamField>

### Debugging

<ParamField path="--inspect" type="string">
  Activate Bun's debugger
</ParamField>

<ParamField path="--inspect-wait" type="string">
  Activate Bun's debugger, wait for a connection before executing
</ParamField>

<ParamField path="--inspect-brk" type="string">
  Activate Bun's debugger, set breakpoint on first line of code and wait
</ParamField>

### Dependency &amp; Module Resolution

<ParamField path="--preload" type="string">
  Import a module before Bun loads other modules. Alias: <code>-r</code>
</ParamField>

<ParamField path="--require" type="string">
  Alias of --preload, for Node.js compatibility
</ParamField>

<ParamField path="--import" type="string">
  Alias of --preload, for Node.js compatibility
</ParamField>

<ParamField path="--no-install" type="boolean">
  Disable auto install in the Bun runtime
</ParamField>

<ParamField path="--install" type="string" default="auto">
  Configure auto-install behavior. One of <code>auto</code> (default, auto-installs when no node_modules),{" "}
  <code>fallback</code> (missing packages only), <code>force</code> (always)
</ParamField>

<ParamField path="-i" type="boolean">
  Auto-install dependencies during execution. Equivalent to --install=fallback
</ParamField>

<ParamField path="--prefer-offline" type="boolean">
  Skip staleness checks for packages in the Bun runtime and resolve from disk
</ParamField>

<ParamField path="--prefer-latest" type="boolean">
  Use the latest matching versions of packages in the Bun runtime, always checking npm
</ParamField>

<ParamField path="--conditions" type="string">
  Pass custom conditions to resolve
</ParamField>

<ParamField path="--main-fields" type="string">
  Main fields to lookup in <code>package.json</code>
</ParamField>

<ParamField path="--preserve-symlinks" type="boolean">
  Preserve symlinks when resolving files
</ParamField>

<ParamField path="--preserve-symlinks-main" type="boolean">
  Preserve symlinks when resolving the main entry point
</ParamField>

<ParamField path="--extension-order" type="string" default=".tsx,.ts,.jsx,.cts,.cjs,.js,.mjs,.mts,.json,.node">
  Defaults to: <code>.tsx,.ts,.jsx,.cts,.cjs,.js,.mjs,.mts,.json,.node</code>
</ParamField>

### Transpilation &amp; Language Features

<ParamField path="--tsconfig-override" type="string">
  Specify custom <code>tsconfig.json</code>. Default <code>$cwd/tsconfig.json</code>
</ParamField>

<ParamField path="--define" type="string">
  Substitute K:V while parsing, e.g. <code>--define process.env.NODE_ENV:"development"</code>. Bun parses values as
  JSON. Alias: <code>-d</code>
</ParamField>

<ParamField path="--drop" type="string">
  Remove function calls, e.g. <code>--drop=console</code> removes all <code>console.*</code> calls
</ParamField>

<ParamField path="--loader" type="string">
  Parse files with <code>.ext:loader</code>, e.g. <code>--loader .js:jsx</code>. Valid loaders: <code>js</code>,{" "}
  <code>jsx</code>, <code>ts</code>, <code>tsx</code>, <code>json</code>, <code>toml</code>, <code>text</code>,{" "}
  <code>file</code>, <code>wasm</code>, <code>napi</code>. Alias: <code>-l</code>
</ParamField>

<ParamField path="--no-macros" type="boolean">
  Disable macro execution in the bundler, transpiler and runtime
</ParamField>

<ParamField path="--jsx-factory" type="string">
  Changes the function called when compiling JSX elements using the classic JSX runtime
</ParamField>

<ParamField path="--jsx-fragment" type="string">
  Changes the function called when compiling JSX fragments
</ParamField>

<ParamField path="--jsx-import-source" type="string" default="react">
  Declares the module specifier used to import the jsx and jsxs factory functions. Default: <code>react</code>
</ParamField>

<ParamField path="--jsx-runtime" type="string" default="automatic">
  <code>automatic</code> (default) or <code>classic</code>
</ParamField>

<ParamField path="--jsx-side-effects" type="boolean">
  Treat JSX elements as having side effects (disable pure annotations)
</ParamField>

<ParamField path="--ignore-dce-annotations" type="boolean">
  Ignore tree-shaking annotations such as <code>@__PURE__</code>
</ParamField>

### Networking &amp; Security

<ParamField path="--port" type="number">
  Set the default port for <code>Bun.serve</code>
</ParamField>

<ParamField path="--fetch-preconnect" type="string">
  Preconnect to a URL while code is loading
</ParamField>

<ParamField path="--max-http-header-size" type="number" default="16384">
  Set the maximum size of HTTP headers in bytes. Default is 16KiB
</ParamField>

<ParamField path="--dns-result-order" type="string" default="verbatim">
  Set the default order of DNS lookup results. Valid orders: <code>verbatim</code> (default), <code>ipv4first</code>,{" "}
  <code>ipv6first</code>
</ParamField>

<ParamField path="--use-system-ca" type="boolean">
  Use the system's trusted certificate authorities
</ParamField>

<ParamField path="--use-openssl-ca" type="boolean">
  Use OpenSSL's default CA store
</ParamField>

<ParamField path="--use-bundled-ca" type="boolean">
  Use bundled CA store
</ParamField>

<ParamField path="--redis-preconnect" type="boolean">
  Preconnect to <code>$REDIS_URL</code> at startup
</ParamField>

<ParamField path="--sql-preconnect" type="boolean">
  Preconnect to PostgreSQL at startup
</ParamField>

<ParamField path="--user-agent" type="string">
  Set the default User-Agent header for HTTP requests
</ParamField>

### Global Configuration &amp; Context

<ParamField path="--env-file" type="string">
  Load environment variables from the specified file(s)
</ParamField>

<ParamField path="--cwd" type="string">
  Absolute path to resolve files &amp; entrypoints from. This only changes the process' cwd
</ParamField>

<ParamField path="--config" type="string">
  Specify path to Bun config file. Default <code>$cwd/bunfig.toml</code>. Alias: <code>-c</code>
</ParamField>

## Examples

Run a JavaScript or TypeScript file:

```bash
bun run ./index.js
bun run ./index.tsx
```

Run a package.json script:

```bash
bun run dev
bun run lint
```
