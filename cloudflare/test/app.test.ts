import { describe, expect, test } from "vitest";
import { CALLBACK, manifest, PERMISSIONS, registered } from "../src/github/app.ts";

describe("manifest", () => {
	test("points every URL at the deploy and asks only for the read and re-run permissions", () => {
		const m = manifest("https://quest.example.dev", "http://localhost:8788/callback", "Quest example");
		expect(m.url).toBe("https://quest.example.dev");
		expect(m.callback_urls).toEqual(["https://quest.example.dev" + CALLBACK]);
		expect(m.redirect_url).toBe("http://localhost:8788/callback");
		expect(m.request_oauth_on_install).toBe(false);
		expect(m.hook_attributes.active).toBe(false);
		expect(m.default_events).toEqual([]);
		expect(m.default_permissions).toEqual(PERMISSIONS);
		const writes = Object.entries(m.default_permissions).filter(([, level]) => level !== "read");
		expect(writes).toEqual([["actions", "write"]]);
	});

	test("accepts localhost over http for development", () => {
		expect(manifest("http://localhost:8787", "http://localhost:8788/callback", "Quest dev").url).toBe(
			"http://localhost:8787",
		);
	});

	test.each([
		["http://quest.example.dev", "must be https"],
		["https://quest.example.dev/sub", "must be an origin"],
		["https://quest.example.dev/?x=1", "must be an origin"],
	])("refuses %s", (origin, message) => {
		expect(() => manifest(origin, "http://localhost:8788/callback", "Quest")).toThrow(message);
	});

	test("refuses a name GitHub would reject", () => {
		expect(() => manifest("https://q.dev", "http://localhost:1/callback", "")).toThrow("1 to 34");
		expect(() => manifest("https://q.dev", "http://localhost:1/callback", "x".repeat(35))).toThrow("1 to 34");
	});
});

describe("registered", () => {
	const body = {
		id: 42,
		slug: "quest-example",
		client_id: "Iv23abc",
		client_secret: "s3cret",
		html_url: "https://github.com/apps/quest-example",
		pem: "unused",
	};

	test("keeps what the Worker needs", () => {
		expect(registered(body)).toEqual({
			id: 42,
			slug: "quest-example",
			clientId: "Iv23abc",
			clientSecret: "s3cret",
			htmlUrl: "https://github.com/apps/quest-example",
		});
	});

	test.each([
		["no object", null],
		["a missing secret", { ...body, client_secret: undefined }],
		["an empty client id", { ...body, client_id: "" }],
		["a fractional id", { ...body, id: 1.5 }],
		["a slug with a path", { ...body, slug: "../x" }],
		["an oversized field", { ...body, client_secret: "x".repeat(513) }],
	])("refuses %s", (_, value) => {
		expect(() => registered(value)).toThrow();
	});
});
