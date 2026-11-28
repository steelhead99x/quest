// An exclusive OS lock on a file, which the kernel drops once every process holding it has exited, however it
// exited, so a killed holder leaves no claim behind to judge stale. Node has no file lock, so Bun's FFI calls the
// system's own: flock(2) from libc on Linux and macOS, and on Windows a CreateFileW handle that shares nothing.
import { FFIType, dlopen, ptr, read } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

/** A held lock, and the descriptor a child process may inherit to keep holding it, or null where none is needed. */
export interface FileLock {
	fd: number | null;
	release(): void;
}

type Locker = (path: string) => FileLock | null;

let locker: Locker | undefined;

/** Lock `path`, creating it, or return null while another process holds it. */
export function tryLock(path: string): FileLock | null {
	locker ??= native(process.platform);
	return locker(path);
}

/** The locker for `platform`, loaded once, failing on a platform with none rather than running unlocked. */
function native(platform: NodeJS.Platform): Locker {
	if (platform === "linux") return flock("libc.so.6", "__errno_location", 11);
	if (platform === "darwin") return flock("libc.dylib", "__error", 35);
	if (platform === "win32") return windows();
	throw new Error(`no file lock on ${platform}`);
}

/**
 * flock(2) on a descriptor of `path`. The lock belongs to the open file, so a child that inherits the descriptor
 * holds it too, until the last holder closes it. `errno` names the function returning errno's address, and
 * `wouldBlock` is EWOULDBLOCK, the code for a lock another holds.
 */
function flock(library: string, errno: string, wouldBlock: number): Locker {
	const { symbols } = dlopen(library, {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		[errno]: { args: [], returns: FFIType.ptr },
	});
	const LOCK_EX = 2;
	const LOCK_NB = 4;
	return (path) => {
		const fd = openSync(path, "a");
		if (symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return { fd, release: () => closeSync(fd) };
		const code = read.i32(symbols[errno]!()!, 0);
		closeSync(fd);
		if (code === wouldBlock) return null;
		throw new Error(`cannot lock ${path}: flock failed with errno ${code}`);
	};
}

/**
 * A handle on `path` that shares nothing, so every other open fails until it closes. No child needs it: every
 * process a Windows run starts ends with it, through libuv's kill-on-close job (see job.ts).
 */
function windows(): Locker {
	const { symbols } = dlopen("kernel32.dll", {
		CreateFileW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.i64,
		},
		CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	const GENERIC_WRITE = 0x40000000;
	const OPEN_ALWAYS = 4;
	const FILE_ATTRIBUTE_NORMAL = 0x80;
	const ERROR_SHARING_VIOLATION = 32;
	return (path) => {
		const name = Buffer.from(`${path}\0`, "utf16le");
		const handle = symbols.CreateFileW(ptr(name), GENERIC_WRITE, 0, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
		// INVALID_HANDLE_VALUE, which Bun returns as a number or a bigint.
		if (Number(handle) !== -1) return { fd: null, release: () => void symbols.CloseHandle(handle) };
		const code = symbols.GetLastError();
		if (code === ERROR_SHARING_VIOLATION) return null;
		throw new Error(`cannot lock ${path}: CreateFileW failed with Windows error ${code}`);
	};
}
