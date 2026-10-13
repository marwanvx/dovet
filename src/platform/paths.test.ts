// Path canonicalization, refusal of network and device paths, and case-aware comparison (platforms "Windows specifics").
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempProject } from "../../test/helpers/index.ts";
import { canonicalizePath, isWithin, lexicalPath, PathRefused, pathKey } from "./paths.ts";

describe("lexicalPath on Windows", () => {
  // spec: AC-PLAT-03
  test("a Git Bash path /c/Users/x/a.txt becomes C:\\Users\\x\\a.txt", () => {
    expect(lexicalPath("/c/Users/x/a.txt", "D:\\work", "win32")).toBe("C:\\Users\\x\\a.txt");
    expect(lexicalPath("/C/Users/x", "D:\\work", "win32")).toBe("C:\\Users\\x");
    expect(lexicalPath("/d", "C:\\work", "win32")).toBe("D:\\");
  });

  test("C:\\ and C:/ forms and relative paths resolve", () => {
    expect(lexicalPath("C:/Users/x/../y.txt", "D:\\work", "win32")).toBe("C:\\Users\\y.txt");
    expect(lexicalPath("src\\a.ts", "D:\\work", "win32")).toBe("D:\\work\\src\\a.ts");
    expect(lexicalPath("..\\a.ts", "D:\\work\\p", "win32")).toBe("D:\\work\\a.ts");
  });

  test("a long-path prefix on a drive path is dropped", () => {
    expect(lexicalPath("\\\\?\\C:\\deep\\a.txt", "D:\\work", "win32")).toBe("C:\\deep\\a.txt");
  });

  // spec: AC-PLAT-05
  test.each([
    ["\\\\127.0.0.1\\c$\\x", "UNC"],
    ["//server/share/x", "UNC with forward slashes"],
    ["\\\\?\\UNC\\server\\share\\x", "long UNC"],
    ["\\??\\C:\\x", "NT object path"],
    ["\\\\.\\pipe\\secret", "device path"],
    ["\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x", "volume GUID path"],
  ])("%s (%s) is refused", (input) => {
    expect(() => lexicalPath(input, "C:\\work", "win32")).toThrow(PathRefused);
  });

  test("Git Bash paths that aren't drives (/tmp, /usr) are refused rather than guessed", () => {
    expect(() => lexicalPath("/tmp/foo", "C:\\work", "win32")).toThrow(/Git Bash/);
    expect(() => lexicalPath("/", "C:\\work", "win32")).toThrow(PathRefused);
  });

  test("a UNC working directory is refused too", () => {
    expect(() => lexicalPath("a.txt", "\\\\server\\share\\dir", "win32")).toThrow(PathRefused);
  });

  test("a drive-relative path (C:foo) is refused: its meaning depends on a per-drive cwd", () => {
    expect(() => lexicalPath("C:foo", "C:\\work", "win32")).toThrow(PathRefused);
  });
});

describe("lexicalPath on Linux and macOS", () => {
  test("resolves against the working directory and leaves backslashes alone", () => {
    expect(lexicalPath("src/../a.ts", "/work/p", "linux")).toBe("/work/p/a.ts");
    expect(lexicalPath("/c/Users/x", "/work", "darwin")).toBe("/c/Users/x");
    expect(lexicalPath("\\\\server\\x", "/work", "linux")).toBe("/work/\\\\server\\x");
  });
});

describe("pathKey and isWithin", () => {
  test("case is folded on macOS and Windows, never on Linux (SPIKE-10)", () => {
    expect(pathKey("/Users/Ann/Proj", "darwin")).toBe(pathKey("/users/ann/proj", "darwin"));
    expect(pathKey("C:\\Users\\Ann", "win32")).toBe(pathKey("c:/users/ann", "win32"));
    expect(pathKey("/home/Ann", "linux")).not.toBe(pathKey("/home/ann", "linux"));
  });

  test("isWithin matches whole path segments, not string prefixes", () => {
    expect(isWithin("/p/src/a.ts", "/p", "linux")).toBe(true);
    expect(isWithin("/p", "/p", "linux")).toBe(true);
    expect(isWithin("/pp/a.ts", "/p", "linux")).toBe(false);
    expect(isWithin("/P/SRC/a.ts", "/p", "darwin")).toBe(true);
    expect(isWithin("C:\\Proj\\a.ts", "c:\\proj", "win32")).toBe(true);
    expect(isWithin("C:\\Proj2\\a.ts", "C:\\Proj", "win32")).toBe(false);
  });

  test("a long-path prefix on a drive path doesn't change the key", () => {
    expect(pathKey("\\\\?\\C:\\Proj\\bin", "win32")).toBe(pathKey("c:\\proj\\bin", "win32"));
  });
});

describe("canonicalizePath on Windows, with a fake file system", () => {
  // spec: AC-PLAT-05
  test("a link inside a local drive that points at a share is refused", () => {
    const realpath = (p: string): string =>
      p.startsWith("C:\\proj\\docs") ? p.replace("C:\\proj\\docs", "\\\\attacker\\share") : p;
    expect(() => canonicalizePath("docs\\x.txt", "C:\\proj", "win32", realpath)).toThrow(PathRefused);
  });

  test("a mapped network drive keeps its drive letter", () => {
    const realpath = (p: string): string => (p.startsWith("Z:\\") ? p.replace("Z:\\", "\\\\srv\\share\\") : p);
    expect(canonicalizePath("Z:\\work\\a.txt", "C:\\proj", "win32", realpath)).toBe("Z:\\work\\a.txt");
  });
});

describe("canonicalizePath on this machine", () => {
  const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

  test("an existing file is its real path", async () => {
    const project = await tempProject({ "a.txt": "x" });
    try {
      expect(canonicalizePath("a.txt", project.root, os)).toBe(realpathSync.native(join(project.root, "a.txt")));
    } finally {
      await project.dispose();
    }
  });

  test("a symlinked directory resolves to its target; a missing tail is kept as written", async () => {
    const project = await tempProject();
    try {
      mkdirSync(join(project.root, "real"));
      writeFileSync(join(project.root, "real", "f.txt"), "x");
      let linked = true;
      try {
        symlinkSync(join(project.root, "real"), join(project.root, "link"), "junction");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        linked = false;
      }
      if (linked) {
        expect(canonicalizePath("link/f.txt", project.root, os)).toBe(
          realpathSync.native(join(project.root, "real", "f.txt")),
        );
      }
      expect(canonicalizePath("real/new/deeper.txt", project.root, os)).toBe(
        join(realpathSync.native(join(project.root, "real")), "new", "deeper.txt"),
      );
    } finally {
      await project.dispose();
    }
  });

  // spec: SPIKE-10
  test("the assumed case behaviour matches this machine's default volume", async () => {
    const project = await tempProject({ "Probe.txt": "x" });
    try {
      const sameFile = await Bun.file(join(project.root, "pROBE.txt")).exists();
      expect(sameFile).toBe(os !== "linux");
    } finally {
      await project.dispose();
    }
  });
});
