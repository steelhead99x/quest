// The demo build: the Worker's static assets, then the snapshot its stand-in GitHub serves.
await import("../scripts/build.ts");
await import("./snapshot.ts");

export {};
