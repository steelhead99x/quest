// The part of Bun's FFI that file-lock.ts calls. Bun's own types (@types/bun) replace Node's globals, such as fetch,
// for the whole program, so only this module is declared.
declare module "bun:ffi" {
	type Native = number | bigint | null;
	export const FFIType: { i32: number; u32: number; i64: number; ptr: number };
	export function dlopen<Symbols extends Record<string, { args: number[]; returns: number }>>(
		path: string,
		symbols: Symbols,
	): { symbols: { [Name in keyof Symbols]: (...args: Native[]) => Native } };
	export function ptr(view: ArrayBufferView): number;
	export const read: { i32(pointer: Native, offset: number): number };
}
