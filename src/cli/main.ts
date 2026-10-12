// Dovet's entry point and composition root: the only file that touches `process.*` (architecture "Modules").
import pkg from "../../package.json";

process.stdout.write(`dovet ${pkg.version}\n`);
