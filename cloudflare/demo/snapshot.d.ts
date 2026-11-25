// The snapshot demo/snapshot.ts writes, a module of its JSON.
declare module "*/snapshot.gen.js" {
	const snapshot: import("./github.ts").Snapshot;
	export default snapshot;
}
