// Dovet addition (not from pi-tui): replaces the Windows part of pi-tui's native platform addon (ADR-5, SPIKE-4).
import { dlopen, FFIType, ptr } from "bun:ffi";

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

/**
 * Add ENABLE_VIRTUAL_TERMINAL_INPUT to the console input mode through kernel32, so modified keys
 * (Shift+Tab as \x1b[Z) arrive as VT sequences. Returns false when stdin is not a console.
 */
export function enableWindowsVirtualTerminalInput(): boolean {
	const kernel32 = dlopen("kernel32.dll", {
		GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
		GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	});
	try {
		const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
		if (handle === null) return false;
		const mode = new Uint32Array(1);
		if (kernel32.symbols.GetConsoleMode(handle, ptr(mode)) === 0) return false;
		return kernel32.symbols.SetConsoleMode(handle, ((mode[0] ?? 0) | ENABLE_VIRTUAL_TERMINAL_INPUT) >>> 0) !== 0;
	} finally {
		kernel32.close();
	}
}
