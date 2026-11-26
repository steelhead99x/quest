// The GitHub read client: what it can never do, and how it takes its host's dependencies.
import { describe, expect, test } from "vitest";

import { GitHubWrites } from "../src/cli/writes";
import { GitHub, type GitHubDependencies, GitHubReader, mutates, reading } from "../src/github/client";

/** The person's dependencies, recording each GitHub request with its token. */
function world() {
	const github: { method: string; path: string; token: string | null }[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
		github.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, token });
		return Response.json([]);
	};
	const person = (): GitHubDependencies => ({
		fetch: fetch as typeof globalThis.fetch,
		now: () => 0,
		sleep: async () => {},
		token: "person-token",
		quota: "fail",
		warn: () => {},
	});
	return { github, person };
}

describe("read client", () => {
	test("a read client cannot write: not in its types, and not at run time for a mutation", async () => {
		const w = world();
		const reader = new GitHubReader({ ...reading(w.person()), readToken: "installation" });
		// @ts-expect-error a read has no method or body
		const request = () => reader.request("/repos/example/project/pulls/7", { method: "PATCH", body: {} });
		void request;
		// @ts-expect-error a write takes the person's token, not read dependencies
		const write = () => new GitHub({ ...reading(w.person()), readToken: "installation" });
		void write;
		// @ts-expect-error a client that writes is not made from a reader's dependencies
		const forge = () => new GitHubWrites(reading(w.person()), null as never);
		void forge;
		await expect(reader.graphql("mutation { x }", {})).rejects.toThrow("cannot run a mutation");
		await expect(reader.graphql("# note\nmutation { x }", {})).rejects.toThrow("cannot run a mutation");
		await expect(reader.graphql(",mutation { x }", {})).rejects.toThrow("cannot run a mutation");
		// The word in a string, a block string, a comment, an alias, or a variable is no mutation.
		for (const query of [
			'query { search(query: "mutation } mutation") { x } }',
			'query { search(query: """a \\""" } mutation""") { x } } # mutation',
			"query($mutation: String) { mutation: search(query: $mutation) { x } }",
		])
			expect(mutates(query)).toBe(false);
		await expect(reader.graphql("fragment f on X { y }\nmutation { x { ...f } }", {})).rejects.toThrow(
			"cannot run a mutation",
		);
		expect(w.github).toEqual([]);
	});

	test("a host whose members are a class's methods keeps them as read dependencies", async () => {
		const w = world();
		const person = w.person();
		class Host {
			token = "person-token";
			quota = "fail" as const;
			fetch = person.fetch;
			now() {
				return person.now();
			}
			sleep(milliseconds: number) {
				return person.sleep(milliseconds);
			}
			warn(message: string) {
				person.warn(message);
			}
		}
		await new GitHub(new Host()).request("/repos/example/project/pulls");
		expect(w.github).toEqual([{ method: "GET", path: "/repos/example/project/pulls", token: "person-token" }]);
	});
});
