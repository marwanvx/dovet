import { expect, test } from "bun:test";
import { commandEnv } from "./shell-env.ts";

// spec: AC-PLAT-06
test("Git Bash gets LANG=C.UTF-8 unless the user set one", () => {
  expect(commandEnv({ os: "win32", launch: {}, snapshot: null }).env.LANG).toBe("C.UTF-8");
  expect(commandEnv({ os: "win32", launch: { LANG: "de_DE.UTF-8" }, snapshot: null }).env.LANG).toBe("de_DE.UTF-8");
  expect(commandEnv({ os: "linux", launch: {}, snapshot: null }).env.LANG).toBeUndefined();
});
