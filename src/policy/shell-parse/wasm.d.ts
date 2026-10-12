// `import x from "….wasm" with { type: "file" }` gives the file's path (embedded in the binary when compiled).
declare module "*.wasm" {
  const path: string;
  export default path;
}
