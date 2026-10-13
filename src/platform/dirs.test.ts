// Per-OS config/data/cache directories (cli-config "Directories"). Pure: the environment is passed in.
import { describe, expect, test } from "bun:test";
import { resolveDirs } from "./dirs.ts";

describe("resolveDirs", () => {
  test("linux follows XDG, with the home-relative defaults", () => {
    expect(resolveDirs({ os: "linux", home: "/home/ann", env: {} })).toEqual({
      config: "/home/ann/.config/dovet",
      data: "/home/ann/.local/share/dovet",
      cache: "/home/ann/.cache/dovet",
    });
    expect(
      resolveDirs({
        os: "linux",
        home: "/home/ann",
        env: { XDG_CONFIG_HOME: "/x/c", XDG_DATA_HOME: "/x/d", XDG_CACHE_HOME: "/x/k" },
      }),
    ).toEqual({ config: "/x/c/dovet", data: "/x/d/dovet", cache: "/x/k/dovet" });
  });

  test("a relative or empty XDG value is ignored, as the XDG spec says", () => {
    const dirs = resolveDirs({ os: "linux", home: "/home/ann", env: { XDG_CONFIG_HOME: "rel", XDG_DATA_HOME: "" } });
    expect(dirs.config).toBe("/home/ann/.config/dovet");
    expect(dirs.data).toBe("/home/ann/.local/share/dovet");
  });

  test("macOS keeps config under ~/.config and data and cache under Library", () => {
    expect(resolveDirs({ os: "darwin", home: "/Users/ann", env: { XDG_CONFIG_HOME: "/ignored" } })).toEqual({
      config: "/Users/ann/.config/dovet",
      data: "/Users/ann/Library/Application Support/dovet",
      cache: "/Users/ann/Library/Caches/dovet",
    });
  });

  test("Windows uses APPDATA and LOCALAPPDATA, with the cache under the data directory", () => {
    expect(
      resolveDirs({
        os: "win32",
        home: "C:\\Users\\ann",
        env: { APPDATA: "D:\\Roam", LOCALAPPDATA: "D:\\Local" },
      }),
    ).toEqual({ config: "D:\\Roam\\dovet", data: "D:\\Local\\dovet", cache: "D:\\Local\\dovet\\cache" });
    expect(resolveDirs({ os: "win32", home: "C:\\Users\\ann", env: {} })).toEqual({
      config: "C:\\Users\\ann\\AppData\\Roaming\\dovet",
      data: "C:\\Users\\ann\\AppData\\Local\\dovet",
      cache: "C:\\Users\\ann\\AppData\\Local\\dovet\\cache",
    });
  });

  test("a Windows APPDATA without a drive letter is ignored", () => {
    const dirs = resolveDirs({ os: "win32", home: "C:\\Users\\ann", env: { APPDATA: "\\Roam" } });
    expect(dirs.config).toBe("C:\\Users\\ann\\AppData\\Roaming\\dovet");
  });

  test("DOVET_CONFIG_DIR and DOVET_DATA_DIR override; the cache then lives under the data override", () => {
    const dirs = resolveDirs({
      os: "linux",
      home: "/home/ann",
      env: { DOVET_CONFIG_DIR: "/portable/config", DOVET_DATA_DIR: "/portable/data" },
    });
    expect(dirs).toEqual({ config: "/portable/config", data: "/portable/data", cache: "/portable/data/cache" });
  });

  test("a relative override is an error that names the variable", () => {
    expect(() => resolveDirs({ os: "linux", home: "/h", env: { DOVET_DATA_DIR: "rel/data" } })).toThrow(
      /DOVET_DATA_DIR/,
    );
  });
});
