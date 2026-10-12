// Loads the tree-sitter runtime and the Bash and PowerShell grammars (permissions §4.0, ADR-9).
// The three .wasm files are imported as files, so `bun build --compile` embeds them in the binary and they load from
// its embedded filesystem: nothing is read from node_modules or the install directory at run time (SPIKE-15).

import bashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };
import powershellWasm from "tree-sitter-powershell/tree-sitter-powershell.wasm" with { type: "file" };
import { LANGUAGE_VERSION, Language, MIN_COMPATIBLE_VERSION, Parser } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };

export type ShellLanguage = "bash" | "powershell";

export type ParsedCommand = {
  /** Type of the root node (`program` for both grammars). */
  root: string;
  /** True when the tree holds an ERROR or MISSING node: the command was not fully understood. */
  hasError: boolean;
  /** The tree as an S-expression, for tests and debugging. */
  tree: string;
};

export type ShellParsers = {
  /** ABI versions: the runtime's supported range and each grammar's own. */
  abi: { runtime: number; minCompatible: number; bash: number; powershell: number };
  /** Where the three .wasm files were loaded from: inside the binary's embedded filesystem when compiled. */
  files: { runtime: string; bash: string; powershell: string };
  parse(language: ShellLanguage, command: string): ParsedCommand;
};

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/**
 * Starts the runtime and loads both grammars. Rejects if a .wasm file is missing or a grammar's ABI is unsupported.
 * Call it once per process and keep the result: web-tree-sitter holds one runtime instance per process, and a second
 * call replaces it under the parsers the first call returned.
 */
export async function loadShellParsers(): Promise<ShellParsers> {
  // `wasmBinary` hands the runtime its own .wasm directly, so it never looks for the file next to its JS.
  await Parser.init({ wasmBinary: await bytes(runtimeWasm) });
  const languages: Record<ShellLanguage, Language> = {
    bash: await Language.load(await bytes(bashWasm)),
    powershell: await Language.load(await bytes(powershellWasm)),
  };
  const parsers: Record<ShellLanguage, Parser> = {
    bash: new Parser().setLanguage(languages.bash),
    powershell: new Parser().setLanguage(languages.powershell),
  };
  return {
    abi: {
      runtime: LANGUAGE_VERSION,
      minCompatible: MIN_COMPATIBLE_VERSION,
      bash: languages.bash.abiVersion,
      powershell: languages.powershell.abiVersion,
    },
    files: { runtime: runtimeWasm, bash: bashWasm, powershell: powershellWasm },
    parse(language, command) {
      const tree = parsers[language].parse(command);
      if (!tree) throw new Error(`tree-sitter returned no tree for a ${language} command`);
      try {
        return { root: tree.rootNode.type, hasError: tree.rootNode.hasError, tree: tree.rootNode.toString() };
      } finally {
        tree.delete();
      }
    },
  };
}
