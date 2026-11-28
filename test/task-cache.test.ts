// The task cache's inputs: the files Git would store, and each Cargo crate's closure.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { DIRTY, cargoWorkspace, inputFiles, nixSystem, treeFiles, workspaceManifest } from "../src/cli/task-cache";
import type { ManifestTask } from "../src/core";
import { initRepository, tempDir } from "./fixture";

const posix = process.platform !== "win32";

/** A repository holding a file, an executable, and a symlink, uncommitted. */
function files(): string {
	const dir = initRepository(tempDir());
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "a.rs"), "fn a() {}\n");
	writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
	chmodSync(join(dir, "run.sh"), 0o755);
	symlinkSync("src/a.rs", join(dir, "link"));
	writeFileSync(join(dir, ".gitignore"), "target/\n");
	mkdirSync(join(dir, "target"));
	writeFileSync(join(dir, "target", "out"), "built");
	return dir;
}

test.runIf(posix)("a checkout's files hash the same committed, modified, or untracked", () => {
	const untracked = files();
	const committed = files();
	execFileSync("git", ["-C", committed, "add", "-A"], { stdio: "ignore" });
	execFileSync("git", ["-C", committed, "commit", "-q", "-m", "files"], { stdio: "ignore" });
	const clean = treeFiles(committed);
	expect(clean.map(({ path, mode }) => `${mode} ${path}`)).toEqual([
		"100644 .gitignore",
		"120000 link",
		"100755 run.sh",
		"100644 src/a.rs",
	]);
	expect(treeFiles(untracked)).toEqual(clean);

	// A modification counts as it is, and a deleted file is gone.
	writeFileSync(join(committed, "src", "a.rs"), "fn b() {}\n");
	rmSync(join(committed, "run.sh"));
	writeFileSync(join(untracked, "src", "a.rs"), "fn b() {}\n");
	rmSync(join(untracked, "run.sh"));
	const modified = treeFiles(committed);
	expect(modified.map(({ path }) => path)).toEqual([".gitignore", "link", "src/a.rs"]);
	expect(modified.find(({ path }) => path === "src/a.rs")!.oid).not.toBe(
		clean.find(({ path }) => path === "src/a.rs")!.oid,
	);
	expect(treeFiles(untracked)).toEqual(modified);
});

test("a crate's closure takes every kind of its own dependencies, and only what its dependencies build with", () => {
	const top = "/repo";
	const id = (name: string) => `path+file:///repo/${name}#${name}@0.1.0`;
	const serde = "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0";
	const output = JSON.stringify({
		workspace_root: top,
		workspace_members: [id("app"), id("lib"), id("fixtures")],
		packages: [
			{ id: id("app"), name: "app", version: "0.1.0", source: null, manifest_path: "/repo/app/Cargo.toml" },
			{ id: id("lib"), name: "lib", version: "0.1.0", source: null, manifest_path: "/repo/lib/Cargo.toml" },
			{
				id: id("fixtures"),
				name: "fixtures",
				version: "0.1.0",
				source: null,
				manifest_path: "/repo/lib/fixtures/Cargo.toml",
			},
			{
				id: serde,
				name: "serde",
				version: "1.0.0",
				source: "registry+https://github.com/rust-lang/crates.io-index",
				manifest_path: "/registry/serde/Cargo.toml",
			},
		],
		resolve: {
			nodes: [
				{ id: id("app"), features: [], deps: [{ pkg: id("lib"), dep_kinds: [{ kind: null }] }] },
				{
					id: id("lib"),
					features: [],
					deps: [
						{ pkg: serde, dep_kinds: [{ kind: "build" }] },
						{ pkg: id("fixtures"), dep_kinds: [{ kind: "dev" }] },
					],
				},
				{ id: id("fixtures"), features: [], deps: [] },
				{ id: serde, features: ["std", "derive"], deps: [] },
			],
		},
	});
	const workspace = cargoWorkspace(output, top);
	expect(workspace.dirs.sort()).toEqual(["app", "lib", "lib/fixtures"]);
	expect(workspace.crates).toEqual([
		// lib's dev-dependency builds only lib's tests.
		{
			name: "app",
			dirs: ["app", "lib"],
			packages: ["serde 1.0.0 registry+https://github.com/rust-lang/crates.io-index [derive,std]"],
			names: ["app", "lib", "serde"],
			unlisted: [],
		},
		{ name: "fixtures", dirs: ["lib/fixtures"], packages: [], names: ["fixtures"], unlisted: [] },
		{
			name: "lib",
			dirs: ["lib", "lib/fixtures"],
			packages: ["serde 1.0.0 registry+https://github.com/rust-lang/crates.io-index [derive,std]"],
			names: ["fixtures", "lib", "serde"],
			unlisted: [],
		},
	]);

	expect(() => cargoWorkspace(output, "/elsewhere")).toThrow(
		"cargo = true needs the Cargo workspace at the repository root",
	);
	const outside = output.replace("/repo/lib/fixtures/Cargo.toml", "/vendor/fixtures/Cargo.toml");
	expect(() => cargoWorkspace(outside, top)).toThrow("crate fixtures is a path dependency outside the repository");
});

test("the root manifest a crate reads keeps only the workspace dependencies its closure uses", () => {
	const base =
		'[workspace]\nmembers = ["a"]\n\n[workspace.dependencies]\nserde = "1"\njson = { package = "serde_json", version = "1" }\nb = { path = "b" }\n\n[profile.release]\nlto = true\n';
	const read = (text: string) => workspaceManifest(text, ["a", "serde_json"]);
	// serde and b are outside a's closure; serde_json is in it under another name.
	expect(read(base)).toBe(read(base.replace('serde = "1"', 'serde = "2"').replace('path = "b"', 'path = "b2"')));
	expect(read(base)).not.toBe(read(base.replace('version = "1" }', 'version = "1", features = ["std"] }')));
	expect(read(base)).not.toBe(read(base.replace("lto = true", "lto = false")));
});

test("a declared path dependency the resolve graph has no edge to still joins the closure", () => {
	const top = "/repo";
	const id = (name: string) => `path+file:///repo/${name}#${name}@0.1.0`;
	const crate = (name: string, dependencies: unknown[] = []) => ({
		id: id(name),
		name,
		version: "0.1.0",
		source: null,
		manifest_path: `/repo/${name}/Cargo.toml`,
		dependencies,
	});
	// b, outside the workspace, has an optional c that only a task's --features b/extra enables on b, and that
	// d's own dependency on it resolves.
	const output = JSON.stringify({
		workspace_root: top,
		workspace_members: [id("a"), id("d")],
		packages: [
			crate("a", [{ kind: null, path: "/repo/b" }]),
			crate("b", [{ kind: null, path: "/repo/c" }]),
			crate("c"),
			crate("d", [{ kind: null, path: "/repo/c" }]),
		],
		resolve: {
			nodes: [
				{ id: id("a"), features: [], deps: [{ pkg: id("b"), dep_kinds: [{ kind: null }] }] },
				{ id: id("b"), features: [], deps: [] },
				{ id: id("c"), features: [], deps: [] },
				{ id: id("d"), features: [], deps: [{ pkg: id("c"), dep_kinds: [{ kind: null }] }] },
			],
		},
	});
	expect(cargoWorkspace(output, top).crates[0]).toMatchObject({ dirs: ["a", "b", "c"], unlisted: [] });

	// With nothing else needing c, Cargo lists it nowhere, as it does b's dev-dependency e, which b builds only for
	// its own tests.
	const alone = JSON.stringify({
		workspace_root: top,
		workspace_members: [id("a")],
		packages: [
			crate("a", [{ kind: null, path: "/repo/b" }]),
			crate("b", [
				{ kind: null, path: "/repo/c" },
				{ kind: "dev", path: "/repo/e" },
			]),
		],
		resolve: {
			nodes: [
				{ id: id("a"), features: [], deps: [{ pkg: id("b"), dep_kinds: [{ kind: null }] }] },
				{ id: id("b"), features: [], deps: [] },
			],
		},
	});
	expect(cargoWorkspace(alone, top).crates[0]).toMatchObject({ dirs: ["a", "b"], unlisted: ["c"] });
});

test("a crate inside a submodule reads the submodule's commit", () => {
	const crate = { name: "a", dirs: ["a", "vendor/lib"], packages: [], names: ["a", "lib"], unlisted: [] };
	const workspace = { crates: [crate], dirs: ["a", "vendor/lib"] };
	const task = { paths: null, inputs: [], exclude: [] } as unknown as ManifestTask;
	const files = [
		{ path: "a/src/lib.rs", mode: "100644", oid: "1" },
		{ path: "other", mode: "160000", oid: "2" },
		{ path: "vendor", mode: "160000", oid: DIRTY },
		{ path: "vendor-lib", mode: "160000", oid: "3" },
	];
	expect(inputFiles(task, files, [], { crate, workspace }).map(({ path }) => path)).toEqual([
		"a/src/lib.rs",
		"vendor",
	]);
});

test("a crate reads shared Cargo files and the task's selected files even where a root package owns them", () => {
	const crate = { name: "a", dirs: ["a"], packages: [], names: ["a"], unlisted: [] };
	const workspace = { crates: [crate], dirs: ["", "a"] };
	const task = { paths: ["rs/", "Cargo.*", "tests/"], inputs: [], exclude: [] } as unknown as ManifestTask;
	const files = [
		"Cargo.lock",
		"Cargo.toml",
		".cargo/config.toml",
		".config/nextest.toml",
		"a/src/lib.rs",
		"src/main.rs",
		"tests/vectors",
	].map((path) => ({ path, mode: "100644", oid: path }));
	expect(inputFiles(task, files, [], { crate, workspace }).map(({ path }) => path)).toEqual([
		".cargo/config.toml",
		".config/nextest.toml",
		"a/src/lib.rs",
		"tests/vectors",
	]);
});

test.runIf(posix)("a file whose bytes differ from its commit's only by Git's filters still changes its id", () => {
	const dir = initRepository(tempDir());
	writeFileSync(join(dir, ".gitattributes"), "*.sh text eol=lf\n");
	writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
	execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-q", "-m", "lf"], { stdio: "ignore" });
	const clean = treeFiles(dir).find(({ path }) => path === "run.sh")!.oid;
	writeFileSync(join(dir, "run.sh"), "#!/bin/sh\r\n");
	expect(treeFiles(dir).find(({ path }) => path === "run.sh")!.oid).not.toBe(clean);
});

test.runIf(posix)("a clean file that checkout writes with CRLF endings counts as its own bytes", () => {
	const dir = initRepository(tempDir());
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
	writeFileSync(join(dir, ".gitattributes"), "*.sh text\n*.lf text eol=lf\n*.bin -text\n");
	for (const name of ["run.sh", "keep.lf", "data.bin", "plain"]) writeFileSync(join(dir, name), "#!/bin/sh\n");
	git("add", "-A");
	git("commit", "-q", "-m", "lf");
	const oids = () => Object.fromEntries(treeFiles(dir).map(({ path, oid }) => [path, oid]));
	const lf = oids();
	const crlf = execFileSync("git", ["hash-object", "--stdin"], { input: "#!/bin/sh\r\n" }).toString().trim();
	const checkout = (...config: string[]) => {
		for (const [key, value] of config.map((each) => each.split("="))) git("config", key!, value!);
		for (const name of ["run.sh", "keep.lf", "data.bin", "plain"]) rmSync(join(dir, name));
		git("checkout", "--", ".");
	};
	// Git calls each checkout clean, yet a CRLF shebang runs differently.
	checkout("core.eol=crlf");
	expect(oids()).toEqual({ ...lf, "run.sh": crlf });
	checkout("core.eol=lf", "core.autocrlf=true");
	expect(oids()).toEqual({ ...lf, "run.sh": crlf, plain: crlf });
	checkout("core.autocrlf=input");
	expect(oids()).toEqual(lf);
});

test.runIf(posix)(
	"a submodule with uncommitted changes has no id, and an untracked nested repository is left out",
	() => {
		const inner = initRepository(tempDir());
		writeFileSync(join(inner, "file"), "1");
		execFileSync("git", ["-C", inner, "add", "-A"], { stdio: "ignore" });
		execFileSync("git", ["-C", inner, "commit", "-q", "-m", "inner"], { stdio: "ignore" });
		const outer = initRepository(tempDir());
		execFileSync("git", ["-C", outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"], {
			stdio: "ignore",
		});
		execFileSync("git", ["-C", outer, "commit", "-q", "-m", "outer"], { stdio: "ignore" });
		expect(treeFiles(outer).map(({ path, mode }) => `${mode} ${path}`)).toEqual([
			"100644 .gitmodules",
			"160000 sub",
		]);
		writeFileSync(join(outer, "sub", "file"), "2");
		initRepository(join(outer, "agent"));
		writeFileSync(join(outer, "agent", "file"), "");
		expect(treeFiles(outer).map(({ path, oid }) => (path === "sub" ? oid : path))).toEqual([".gitmodules", DIRTY]);
	},
);

test("the Nix system names the host's CPU and OS as flakes do", () => {
	expect(nixSystem("linux", "x64")).toBe("x86_64-linux");
	expect(nixSystem("darwin", "arm64")).toBe("aarch64-darwin");
	expect(() => nixSystem("win32", "x64")).toThrow("not x64 win32");
});

test.runIf(posix)("a clean file a checkout filter or encoding converts counts as its own bytes", () => {
	const dir = initRepository(tempDir());
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
	const hash = (bytes: Buffer) =>
		execFileSync("git", ["hash-object", "--no-filters", "--stdin"], { input: bytes }).toString().trim();
	// A filter driver standing in for Git LFS: what checkout writes is not the blob.
	git("config", "filter.up.clean", "tr A-Z a-z");
	git("config", "filter.up.smudge", "tr a-z A-Z");
	writeFileSync(join(dir, ".gitattributes"), "*.dat filter=up\n*.txt working-tree-encoding=UTF-16LE\n");
	writeFileSync(join(dir, "fixture.dat"), "abc\n");
	const utf16 = Buffer.from("hi\n", "utf16le");
	writeFileSync(join(dir, "note.txt"), utf16);
	git("add", "-A");
	git("commit", "-q", "-m", "filtered");
	const oid = (path: string) => treeFiles(dir).find((file) => file.path === path)!.oid;
	const checkout = () => {
		rmSync(join(dir, "fixture.dat"));
		git("checkout", "--", "fixture.dat");
	};
	checkout();
	expect(oid("fixture.dat")).toBe(hash(Buffer.from("ABC\n")));
	expect(oid("note.txt")).toBe(hash(utf16));
	// A checkout that skips the smudge, as GIT_LFS_SKIP_SMUDGE=1 leaves pointer files, holds the blob's own bytes.
	git("config", "filter.up.smudge", "cat");
	checkout();
	expect(oid("fixture.dat")).toBe(hash(Buffer.from("abc\n")));
});
