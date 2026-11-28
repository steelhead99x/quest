import { describe, expect, test } from "vitest";

import { REVIEW_MARK } from "../src/core";
import { GitHubReader } from "../src/github/client";
import { main } from "../src/cli/main";
import { statusLines } from "../src/cli/status";
import { pullRequestStatus, requiredOf } from "../src/github/status";
import { attestation } from "../src/github/review-trust";
import {
	A,
	baseTree,
	B,
	pr,
	URL_,
	type Node,
	page,
	CI,
	pull,
	run,
	review,
	thread,
	setup,
	reviewStatus,
	MERGE_BASE,
	RISK_BLOB,
	RISK_ID,
} from "./status-fakes";

test("reports checks by requiredness, each reviewer's latest review against the head, and open threads", async () => {
	const fixture = setup(
		[
			pull({
				checks: page([
					run("lint", "COMPLETED", "FAILURE", true),
					run("docs", "COMPLETED", "CANCELLED", false),
					run("test", "IN_PROGRESS", null, true),
					run("build", "COMPLETED", "SUCCESS", true),
					run("publish", "COMPLETED", "SKIPPED", false),
					{
						__typename: "StatusContext",
						context: "ci/legacy",
						state: "ERROR",
						targetUrl: null,
						isRequired: false,
					},
					{
						__typename: "StatusContext",
						context: "deploy",
						state: "EXPECTED",
						targetUrl: "",
						isRequired: true,
					},
				]),
				reviews: page([
					review("alice", "APPROVED", B, 1),
					review("bob", "CHANGES_REQUESTED", B, 2),
					review("alice", "COMMENTED", A, 3, [
						{ content: "THUMBS_UP", createdAt: "2026-10-07T12:04:00Z", user: { login: "codex[bot]" } },
					]),
					review("viewer", "PENDING", A, 4),
					review("gone", "COMMENTED", null, 5),
				]),
				threads: page([thread("T1", true), thread("T2", false), thread("T3", false, null, "author")]),
				reactions: [{ content: "EYES", createdAt: "2026-10-07T12:00:00Z", user: null }],
			}),
		],
		{ runs: [] },
	);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(fixture.queries).toHaveLength(1);
	expect(fixture.holdQueries).toHaveLength(1);
	expect(fixture.queries[0]).toMatchObject({ number: 1, moreChecks: true, moreReviews: true, moreThreads: true });
	expect(statusLines(status)).toEqual([
		`url ${URL_}`,
		"state open",
		"draft false",
		`head ${A}`,
		"mergeable mergeable",
		"merge-state blocked",
		"review-decision review_required",
		"review-record -",
		"risk -",
		"class -",
		"auto-merge -",
		"merge-queue -",
		"landing-stopped -",
		"checks failure passed=2 failing=3 pending=2",
		"check failing required failure https://github.com/example/project/actions/runs/1/job/lint lint",
		"check failing optional cancelled https://github.com/example/project/actions/runs/1/job/docs docs",
		"check failing optional error - ci/legacy",
		"check pending required in_progress https://github.com/example/project/actions/runs/1/job/test test",
		"check pending required expected - deploy",
		`review stale changes_requested bob 2026-10-07T12:02:00Z ${URL_}#pullrequestreview-2`,
		`review current commented alice 2026-10-07T12:03:00Z ${URL_}#pullrequestreview-3`,
		`review stale commented gone 2026-10-07T12:05:00Z ${URL_}#pullrequestreview-5`,
		`reacted:eyes - 2026-10-07T12:00:00Z ${URL_}`,
		`reacted:thumbs_up codex[bot] 2026-10-07T12:04:00Z ${URL_}#pullrequestreview-3`,
		`thread T2 current reviewer ${URL_}#discussion_rT2 src/a.ts:3`,
		`thread T3 outdated author ${URL_}#discussion_rT3 src/a.ts:2`,
		"hold -",
	]);
});

test("lists the signals that hold the head: required reviewers' unanswered findings and newer maintainer decisions", async () => {
	const body = pull({ checks: null, reviews: page([]), threads: page([]) });
	const decision = `${URL_}#issuecomment-9`;
	const review = (id: string, login: string, finding: string) => ({
		id,
		url: `${URL_}#pullrequestreview-${id}`,
		author: { __typename: "Bot", login },
		body: finding,
		submittedAt: "2026-10-16T00:30:00Z",
		commit: { oid: body.data.repository.pullRequest.headRefOid },
	});
	const status = await pullRequestStatus(
		pr,
		setup([body], {
			// Only frog posts a check the base requires; rabbit's finding is a suggestion.
			requiredBy: ["frog[bot]"],
			signals: {
				reviews: page([review("1", "rabbit", "[P2] Rename it"), review("2", "frog", "[P1] Drops a frame")]),
				comments: page([
					{
						author: { __typename: "User", login: "kixelated" },
						authorAssociation: "OWNER",
						body: "Maintainer decision: raise the timeout.",
						createdAt: "2026-10-16T01:00:00Z",
						url: decision,
					},
				]),
			},
		}).deps,
	);
	expect(statusLines(status).filter((line) => line.startsWith("signal "))).toEqual([
		`signal finding ${URL_}#pullrequestreview-2 frog[bot]: drops a frame`,
		`signal decision ${decision} kixelated: Maintainer decision: raise the timeout.`,
	]);
});

test("a queued PR with auto-merge and no checks reports both, and JSON is deterministic", async () => {
	const body = pull({
		state: "OPEN",
		isDraft: true,
		reviewDecision: null,
		autoMergeRequest: {
			enabledAt: "2026-10-07T12:00:00Z",
			mergeMethod: "SQUASH",
			enabledBy: { login: "kixelated" },
		},
		mergeQueueEntry: { state: "AWAITING_CHECKS", position: 2, enqueuedAt: "2026-10-07T12:01:00Z" },
		checks: null,
		reviews: page([]),
		threads: page([]),
	});
	const status = await pullRequestStatus(pr, setup([body]).deps);
	expect(statusLines(status).slice(2, 14)).toEqual([
		"draft true",
		`head ${A}`,
		"mergeable mergeable",
		"merge-state blocked",
		"review-decision -",
		"review-record -",
		"risk -",
		"class -",
		"auto-merge squash kixelated 2026-10-07T12:00:00Z -",
		"merge-queue awaiting_checks 2 2026-10-07T12:01:00Z",
		"landing-stopped -",
		"checks - passed=0 failing=0 pending=0",
	]);
	expect(JSON.stringify(await pullRequestStatus(pr, setup([body]).deps))).toBe(JSON.stringify(status));
	expect(status.mergeQueue).toEqual({ state: "awaiting_checks", position: 2, enqueuedAt: "2026-10-07T12:01:00Z" });
});

describe("the head auto-merge was enabled on", () => {
	const ENABLED = "2026-10-07T12:00:00Z";
	const push = (after: string, timestamp: string, activity_type = "push") => ({ after, timestamp, activity_type });
	const enabled = async (
		request: Node,
		activity: { rows: Node[]; next?: string; status?: number }[] = [],
		head = B,
		warnings?: string[],
	): Promise<{ line: string | undefined; requests: string[] }> => {
		const body = pull({
			head,
			checks: null,
			reviews: page([]),
			threads: page([]),
			headRefName: "feature/x",
			headRepository: { nameWithOwner: "fork/project" },
			autoMergeRequest: {
				enabledAt: ENABLED,
				mergeMethod: "MERGE",
				enabledBy: { login: "kixelated" },
				...request,
			},
		});
		const fixture = setup([body], { activity, warnings });
		const status = await pullRequestStatus(pr, fixture.deps);
		return {
			line: statusLines(status).find((line) => line.startsWith("auto-merge ")),
			requests: fixture.activityRequests,
		};
	};

	test("is the head a quest land pin names, without reading activity", async () => {
		const result = await enabled({ commitBody: `Quest-Land-Head: ${A}` });
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${A}`);
		expect(result.requests).toEqual([]);
	});

	test("is otherwise the last push before it was enabled, paging the head branch's activity", async () => {
		const result = await enabled({ commitBody: null }, [
			{
				rows: [push(B, "2026-10-07T12:05:00Z")],
				next: "https://api.github.com/repos/fork/project/activity?page=2",
			},
			{ rows: [push(A, "2026-10-07T11:59:00Z", "force_push"), push("c".repeat(40), "2026-10-07T11:00:00Z")] },
		]);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${A}`);
		expect(result.requests).toEqual([
			"/repos/fork/project/activity?ref=feature%2Fx&per_page=100",
			"/repos/fork/project/activity?page=2",
		]);
	});

	test("counts a merge into the head branch as moving its head", async () => {
		const result = await enabled({}, [
			{
				rows: [
					push(B, "2026-10-07T12:05:00Z", "pr_merge"),
					push(A, "2026-10-07T11:59:00Z", "merge_queue_merge"),
				],
			},
		]);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${A}`);
	});

	test("matches the head when no push followed", async () => {
		const result = await enabled({ commitBody: "" }, [{ rows: [push(B, "2026-10-07T11:59:59Z")] }]);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} ${B}`);
	});

	test("is unknown until GitHub lists the current head's push, or when a push shares the second", async () => {
		expect((await enabled({}, [{ rows: [push(A, "2026-10-07T11:59:00Z")] }])).line).toBe(
			`auto-merge merge kixelated ${ENABLED} -`,
		);
		expect((await enabled({}, [{ rows: [push(B, ENABLED), push(A, "2026-10-07T11:59:00Z")] }])).line).toBe(
			`auto-merge merge kixelated ${ENABLED} -`,
		);
		// A head repository the token cannot see.
		expect((await enabled({}, [])).line).toBe(`auto-merge merge kixelated ${ENABLED} -`);
	});

	test("is unknown, with a warning, when the token may not read the activity, and status still prints", async () => {
		const warnings: string[] = [];
		const result = await enabled({}, [{ rows: [], status: 403 }], B, warnings);
		expect(result.line).toBe(`auto-merge merge kixelated ${ENABLED} -`);
		expect(warnings).toEqual([
			"cannot read fork/project's push activity, so the head auto-merge was enabled on is unknown: GitHub HTTP 403 for /repos/fork/project/activity; Resource not accessible by integration",
		]);
	});
});

test("reports why the latest landing stopped, from a merge queue or auto-merge", async () => {
	const stopped = async (node: Node) => {
		const body = pull({ checks: null, reviews: page([]), threads: page([]), timelineItems: { nodes: [node] } });
		return statusLines(await pullRequestStatus(pr, setup([body]).deps)).find((line) =>
			line.startsWith("landing-stopped "),
		);
	};
	expect(
		await stopped({
			createdAt: "2026-10-07T12:00:00Z",
			reason: "MERGE_CONFLICT",
			actor: { login: "github-merge-queue" },
		}),
	).toBe("landing-stopped merge_conflict github-merge-queue 2026-10-07T12:00:00Z");
	expect(
		await stopped({
			createdAt: "2026-10-07T12:01:00Z",
			reasonCode: "manually_disabled",
			actor: { login: "kixelated" },
		}),
	).toBe("landing-stopped manually_disabled kixelated 2026-10-07T12:01:00Z");
});

test("reports quest land's ejection after the auto-merge it disabled, ignoring other comments", async () => {
	const comment = (body: string, author: Node, authorAssociation = "NONE") => ({
		__typename: "IssueComment",
		createdAt: "2026-10-07T12:02:00Z",
		body,
		authorAssociation,
		author,
	});
	const ejected =
		"quest land removed this pull request from the queue: it conflicts.\n\n<!-- quest land: merge_conflict -->";
	const nodes = [
		{
			__typename: "AutoMergeDisabledEvent",
			createdAt: "2026-10-07T12:01:00Z",
			reasonCode: "manually_disabled",
			actor: { login: "gate[bot]" },
		},
		comment(ejected, { __typename: "Bot", login: "gate" }),
		comment("Thanks!", { __typename: "User", login: "kixelated" }, "OWNER"),
		comment(ejected, { __typename: "User", login: "drive-by" }),
	];
	const body = pull({ checks: null, reviews: page([]), threads: page([]), timelineItems: { nodes } });
	const status = await pullRequestStatus(pr, setup([body]).deps);
	expect(status.landingStopped).toEqual({ reason: "merge_conflict", actor: "gate", at: "2026-10-07T12:02:00Z" });
});

test("drops the landing exit once the PR enters the merge queue or auto-merge again", async () => {
	const disabled = {
		__typename: "AutoMergeDisabledEvent",
		createdAt: "2026-10-07T12:01:00Z",
		reasonCode: "manually_disabled",
		actor: { login: "kixelated" },
	};
	const removed = {
		__typename: "RemovedFromMergeQueueEvent",
		createdAt: "2026-10-07T12:01:00Z",
		reason: "MERGE_CONFLICT",
		actor: { login: "github-merge-queue" },
	};
	const ejected = {
		__typename: "IssueComment",
		createdAt: "2026-10-07T12:01:00Z",
		body: "quest land removed this pull request from the queue: it conflicts.\n\n<!-- quest land: merge_conflict -->",
		authorAssociation: "NONE",
		author: { __typename: "Bot", login: "gate" },
	};
	const autoMerge = (enabledAt: string) => ({ enabledAt, mergeMethod: "SQUASH", enabledBy: { login: "kixelated" } });
	const queue = (enqueuedAt: string) => ({ state: "QUEUED", position: 1, enqueuedAt });
	const stopped = async (node: Node, fields: Node) => {
		const body = pull({
			checks: null,
			reviews: page([]),
			threads: page([]),
			timelineItems: { nodes: [node] },
			...fields,
		});
		return (await pullRequestStatus(pr, setup([body]).deps)).landingStopped?.reason ?? null;
	};
	// `quest merge --land` disables auto-merge and enables it again, often within the same second.
	expect(await stopped(disabled, { autoMergeRequest: autoMerge("2026-10-07T12:01:00Z") })).toBeNull();
	expect(await stopped(ejected, { autoMergeRequest: autoMerge("2026-10-07T12:05:00Z") })).toBeNull();
	expect(await stopped(removed, { mergeQueueEntry: queue("2026-10-07T12:05:00Z") })).toBeNull();
	// An entry that began before the exit is not a new one.
	expect(await stopped(removed, { autoMergeRequest: autoMerge("2026-10-07T12:00:00Z") })).toBe("merge_conflict");
	expect(await stopped(ejected, { mergeQueueEntry: queue("2026-10-07T12:00:59Z") })).toBe("merge_conflict");
});

test("drops a cancelled check a newer run of its workflow replaced, as on kixelated/token-max#78", async () => {
	const job = (name: string, conclusion: string, databaseId: number, suite: number) => ({
		...run(name, "COMPLETED", conclusion, false),
		databaseId,
		checkSuite: {
			databaseId: suite,
			app: { databaseId: 15368 },
			workflowRun: { file: { path: CI, repositoryName: "example/project" } },
		},
	});
	const runs = (started: string) => [
		{ id: 1, workflow_id: 7, check_suite_id: 10, run_started_at: "2026-11-12T23:42:53Z" },
		{ id: 2, workflow_id: 7, check_suite_id: 20, run_started_at: started },
	];
	const checks = () =>
		page([job("Tests (${{ matrix.os }})", "CANCELLED", 1, 10), job("Tests (macos-15)", "SUCCESS", 2, 20)]);
	const fixture = setup([pull({ checks: checks(), reviews: page([]), threads: page([]) })], {
		runs: runs("2026-11-12T23:42:56Z"),
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks).toEqual({ state: "success", passed: 1, failing: [], pending: [] });
	// A rerun of the cancelled run started later, so its run is the newest and its cancellation counts.
	const rerun = setup([pull({ checks: checks(), reviews: page([]), threads: page([]) })], {
		runs: runs("2026-11-12T23:40:00Z"),
	});
	expect((await pullRequestStatus(pr, rerun.deps)).checks.state).toBe("failure");
});

test("a required check or workflow nothing reports is pending, except the gate's own check", async () => {
	const job = (name: string, workflow: string) => ({
		...run(name, "COMPLETED", "SUCCESS", false),
		databaseId: 1,
		checkSuite: {
			databaseId: 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path: workflow, repositoryName: "example/project" } },
		},
	});
	const rules = [
		{
			type: "required_status_checks",
			parameters: {
				required_status_checks: [{ context: "test" }, { context: "lint" }, { context: "quest land" }],
			},
		},
		{
			type: "workflows",
			parameters: {
				workflows: [
					{ path: CI, repository_id: 1 },
					{ path: ".github/workflows/pr.yml", repository_id: 1 },
				],
			},
		},
	];
	const fixture = setup([pull({ checks: page([job("test", CI)]), reviews: page([]), threads: page([]) })], {
		rules,
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(statusLines(status).filter((line) => line.startsWith("check"))).toEqual([
		"checks pending passed=1 failing=0 pending=2",
		"check pending required expected - lint",
		"check pending required expected - example/project:.github/workflows/pr.yml",
	]);
	// With no checks on the head at all, the requirements still leave it pending.
	const empty = setup([pull({ checks: null, reviews: page([]), threads: page([]) })], { rules });
	expect((await pullRequestStatus(pr, empty.deps)).checks.state).toBe("pending");
});

test("a base's requirements read once give the status a read of its own would, and another base's are refused", async () => {
	const rules = [
		{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "lint" }] } },
		{ type: "workflows", parameters: { workflows: [{ path: ".github/workflows/pr.yml", repository_id: 1 }] } },
	];
	const body = () =>
		pull({ checks: page([run("test", "COMPLETED", "SUCCESS", false)]), reviews: page([]), threads: page([]) });
	/** The fixture, recording each request for the base's rules. */
	const counted = () => {
		const fixture = setup([body()], { rules });
		const reads: string[] = [];
		const fetch = fixture.deps.fetch;
		fixture.deps.fetch = (url, init) => {
			const path = new URL(String(url)).pathname;
			if (/\/(branches|rules\/branches|repositories)\//.test(path)) reads.push(path);
			return fetch(url, init);
		};
		return { deps: fixture.deps, reads };
	};
	const own = counted();
	const expected = await pullRequestStatus(pr, own.deps);
	expect(own.reads).not.toEqual([]);

	const shared = counted();
	const needs = await requiredOf(new GitHubReader(shared.deps), pr, "main");
	const before = shared.reads.length;
	expect(await pullRequestStatus(pr, shared.deps, { ...pr, branch: "main", needs })).toEqual(expected);
	expect(shared.reads).toHaveLength(before);
	expect(expected.checks.pending.map((check) => check.name)).toEqual([
		"lint",
		"example/project:.github/workflows/pr.yml",
	]);

	// The PR moved to another base after its requirements were read.
	await expect(pullRequestStatus(pr, counted().deps, { ...pr, branch: "release", needs })).rejects.toThrow(
		"the PR's base is main, not the release whose requirements were read",
	);
	// Another repository's requirements are refused, whatever their branch; names ignore case.
	const other = counted();
	await expect(
		pullRequestStatus(pr, other.deps, { owner: "example", repo: "policies", branch: "main", needs }),
	).rejects.toThrow("the requirements passed for example/project#1 were read for example/policies");
	expect(other.reads).toEqual([]);
	expect(
		await pullRequestStatus(pr, counted().deps, { owner: "Example", repo: "Project", branch: "main", needs }),
	).toEqual(expected);
});

test("a required check from another app than its requirement names stays pending, and a closed PR reads no requirements", async () => {
	const rules = [
		{
			type: "required_status_checks",
			parameters: { required_status_checks: [{ context: "test", integration_id: 99 }] },
		},
	];
	const test = {
		...run("test", "COMPLETED", "SUCCESS", false),
		databaseId: 1,
		checkSuite: {
			databaseId: 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path: CI, repositoryName: "example/project" } },
		},
	};
	const open = setup([pull({ checks: page([test]), reviews: page([]), threads: page([]) })], { rules });
	expect(statusLines(await pullRequestStatus(pr, open.deps)).filter((line) => line.startsWith("check"))).toEqual([
		"checks pending passed=1 failing=0 pending=1",
		"check pending required expected - test (from app 99)",
	]);
	// A merged PR's base may be gone, and nothing it requires can change the PR anymore.
	const merged = setup([pull({ state: "MERGED", checks: page([test]), reviews: page([]), threads: page([]) })], {
		rules: undefined,
		noBase: true,
	});
	expect((await pullRequestStatus(pr, merged.deps)).checks.state).toBe("success");
});

test("a replacing run that has not started yet stands in by its creation time", async () => {
	const job = {
		...run("Tests (${{ matrix.os }})", "COMPLETED", "CANCELLED", false),
		databaseId: 1,
		checkSuite: {
			databaseId: 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path: CI, repositoryName: "example/project" } },
		},
	};
	const fixture = setup([pull({ checks: page([job]), reviews: page([]), threads: page([]) })], {
		runs: [
			{ id: 1, workflow_id: 7, check_suite_id: 10, run_started_at: "2026-11-12T23:42:53Z" },
			{ id: 2, workflow_id: 7, check_suite_id: 20, run_started_at: null, created_at: "2026-11-12T23:42:56Z" },
		],
	});
	expect((await pullRequestStatus(pr, fixture.deps)).checks).toEqual({
		state: "success",
		passed: 0,
		failing: [],
		pending: [],
	});
});

test("a required workflow matches its repository as well as its path", async () => {
	const build = {
		...run("build", "COMPLETED", "SUCCESS", false),
		databaseId: 1,
		checkSuite: {
			databaseId: 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path: CI, repositoryName: "example/project" } },
		},
	};
	// The rule requires example/policies's ci.yml, which the local ci.yml at the same path does not satisfy.
	const fixture = setup([pull({ checks: page([build]), reviews: page([]), threads: page([]) })], {
		rules: [{ type: "workflows", parameters: { workflows: [{ path: CI, repository_id: 2 }] } }],
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks.state).toBe("pending");
	expect(status.checks.pending.map((check) => check.name)).toEqual([`example/policies:${CI}`]);
});

test("a required workflow counts as reported when another workflow's same-named job is the newer one", async () => {
	const build = (databaseId: number, path: string) => ({
		...run("build", "COMPLETED", "SUCCESS", false),
		databaseId,
		checkSuite: {
			databaseId: databaseId * 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path, repositoryName: "example/project" } },
		},
	});
	const fixture = setup(
		[
			pull({
				checks: page([build(1, CI), build(2, ".github/workflows/docs.yml")]),
				reviews: page([]),
				threads: page([]),
			}),
		],
		{ rules: [{ type: "workflows", parameters: { workflows: [{ path: CI, repository_id: 1 }] } }] },
	);
	expect((await pullRequestStatus(pr, fixture.deps)).checks.state).toBe("success");
});

test("a required workflow's failed job still fails when another workflow's same-named job passed later", async () => {
	const build = (databaseId: number, path: string, conclusion: string) => ({
		...run("build", "COMPLETED", conclusion, false),
		databaseId,
		checkSuite: {
			databaseId: databaseId * 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path, repositoryName: "example/project" } },
		},
	});
	const fixture = setup(
		[
			pull({
				checks: page([build(1, CI, "FAILURE"), build(2, ".github/workflows/docs.yml", "SUCCESS")]),
				reviews: page([]),
				threads: page([]),
			}),
		],
		{ rules: [{ type: "workflows", parameters: { workflows: [{ path: CI, repository_id: 1 }] } }] },
	);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks.state).toBe("failure");
	expect(status.checks.failing.map((check) => [check.name, check.required])).toEqual([["build", true]]);
});

test("a required workflow whose only job a queued run replaced is pending", async () => {
	const build = {
		...run("build", "COMPLETED", "CANCELLED", false),
		databaseId: 1,
		checkSuite: {
			databaseId: 10,
			app: { databaseId: 15368 },
			workflowRun: { file: { path: CI, repositoryName: "example/project" } },
		},
	};
	const fixture = setup([pull({ checks: page([build]), reviews: page([]), threads: page([]) })], {
		rules: [{ type: "workflows", parameters: { workflows: [{ path: CI, repository_id: 1 }] } }],
		runs: [
			{ id: 1, workflow_id: 7, check_suite_id: 10, run_started_at: "2026-11-12T23:42:53Z" },
			{ id: 2, workflow_id: 7, check_suite_id: 20, run_started_at: null, created_at: "2026-11-12T23:42:56Z" },
		],
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks.state).toBe("pending");
	expect(status.checks.pending.map((check) => check.name)).toEqual([`example/project:${CI}`]);
});

test("a job in a required workflow counts as required", async () => {
	const fixture = setup(
		[
			pull({
				checks: page([
					{
						...run("build", "COMPLETED", "FAILURE", false),
						databaseId: 1,
						checkSuite: {
							databaseId: 10,
							app: { databaseId: 15368 },
							workflowRun: { file: { path: CI, repositoryName: "example/project" } },
						},
					},
				]),
				reviews: page([]),
				threads: page([]),
			}),
		],
		{ rules: [{ type: "workflows", parameters: { workflows: [{ path: CI, repository_id: 1 }] } }] },
	);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.checks.failing.map((check) => [check.name, check.required])).toEqual([["build", true]]);
});

test("counts only each check's newest run from its app", async () => {
	const rerun = (name: string, conclusion: string, databaseId: number, app = 15368) => ({
		...run(name, "COMPLETED", conclusion, true),
		databaseId,
		checkSuite: { app: { databaseId: app } },
	});
	const fixture = setup([
		pull({
			checks: page([
				rerun("build", "SUCCESS", 7),
				rerun("build", "CANCELLED", 3),
				rerun("test", "SUCCESS", 4),
				rerun("test", "FAILURE", 8),
				rerun("lint", "SUCCESS", 5),
				rerun("lint", "FAILURE", 2, 99),
			]),
			reviews: page([]),
			threads: page([]),
		}),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	// The fixture answers whatever is asked, so the query must ask for what tells runs apart.
	expect(fixture.texts[0].replace(/\s+/g, " ")).toContain(
		"... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { databaseId app { databaseId } workflowRun { file { path repositoryName } } } }",
	);
	expect(status.checks.passed).toBe(2);
	expect(status.checks.failing.map((check) => check.name)).toEqual(["test", "lint"]);
	expect(status.checks.pending).toEqual([]);
});

test("judges checks by their latest runs, not the rollup's state, as on moq-dev/moq#7325", async () => {
	// A cancelled run's gate failed on purpose; the newer run of the same workflow passed, and GitHub's
	// merge state counted the pass while its rollup state stayed FAILURE.
	const latest = (name: string, conclusion: string, databaseId: number) => ({
		...run(name, "COMPLETED", conclusion, name === "Release gate"),
		databaseId,
		checkSuite: { app: { databaseId: 15368 } },
	});
	const body = pull({
		checks: page([
			latest("Scope", "CANCELLED", 1),
			latest("Release gate", "FAILURE", 2),
			latest("Scope", "SUCCESS", 3),
			latest("Release gate", "SUCCESS", 4),
		]),
		reviews: page([]),
		threads: page([]),
	});
	const fixture = setup([body]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(statusLines(status)).toContain("checks success passed=2 failing=0 pending=0");
	expect(fixture.texts[0].replace(/\s+/g, " ")).toContain("... on StatusContext { context state createdAt targetUrl");
});

test("long lists page only the connections that have more, keeping the first page's PR fields", async () => {
	const fixture = setup([
		pull({
			checks: page([run("one", "COMPLETED", "FAILURE", true)], "c1"),
			reviews: page([review("alice", "APPROVED", B, 1)], "r1"),
			threads: page([thread("T1", false)]),
			reactions: [{ content: "HEART", createdAt: "2026-10-07T12:00:00Z", user: { login: "x" } }],
		}),
		pull({
			checks: page([run("two", "QUEUED", null, false)]),
			reviews: page([review("alice", "APPROVED", A, 2)], "r2"),
			reactions: [{ content: "HEART", createdAt: "2026-10-07T12:00:00Z", user: { login: "x" } }],
		}),
		pull({ reviews: page([review("bob", "COMMENTED", A, 3)]) }),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(
		fixture.queries.map(({ checks, reviews, threads, moreChecks, moreReviews, moreThreads }) => ({
			checks,
			reviews,
			threads,
			moreChecks,
			moreReviews,
			moreThreads,
		})),
	).toEqual([
		{ checks: null, reviews: null, threads: null, moreChecks: true, moreReviews: true, moreThreads: true },
		{ checks: "c1", reviews: "r1", threads: null, moreChecks: true, moreReviews: true, moreThreads: false },
		{ checks: null, reviews: "r2", threads: null, moreChecks: false, moreReviews: true, moreThreads: false },
	]);
	expect(status.checks.failing.map((check) => check.name)).toEqual(["one"]);
	expect(status.checks.pending.map((check) => check.name)).toEqual(["two"]);
	expect(status.reviews.map((r) => [r.reviewer, r.current])).toEqual([
		["alice", true],
		["bob", true],
	]);
	expect(status.reactions).toHaveLength(1);
	expect(status.threads.map((t) => t.id)).toEqual(["T1"]);
});

test("a push between pages, a GraphQL error, or a missing PR fails instead of mixing heads", async () => {
	const moved = setup([
		pull({ checks: page([], "c1"), reviews: page([]), threads: page([]) }),
		pull({ head: B, checks: page([]) }),
	]);
	await expect(pullRequestStatus(pr, moved.deps)).rejects.toThrow("head changed");
	const errored = setup([{ errors: [{ message: "Field 'isRequired' is missing" }] }]);
	await expect(pullRequestStatus(pr, errored.deps)).rejects.toThrow("GitHub GraphQL error: Field 'isRequired'");
	const missing = setup([{ data: { repository: { pullRequest: null } } }]);
	await expect(pullRequestStatus(pr, missing.deps)).rejects.toThrow("is not a pull request");
});

test("an invalid PR argument is a usage error before authentication", () => {
	const errors: string[] = [];
	const output = { stdout: () => {}, stderr: (text: string) => errors.push(text) };
	expect(main(["status", "https://evil.example/example/project/pull/1"], output)).toBe(2);
	expect(errors.join("")).toContain("GitHub pull request URL");
});

const holdEvent = (id: string, label: string, at = "2026-10-07T11:00:00Z") => ({
	__typename: "LabeledEvent",
	id,
	createdAt: at,
	label: { name: label },
});

test("reports the latest acquisition, age, and verified paged event URL for each hold label", async () => {
	const label = "quest:active";
	const body = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		labels: { nodes: [{ name: "bug" }, { name: label }] },
	});
	const eventUrl = "https://api.github.com/repos/example/project/issues/events/23";
	const next = "https://api.github.com/repos/example/project/issues/1/events?per_page=100&page=2";
	const fixture = setup([body], {
		now: Date.parse("2026-10-07T12:00:00Z"),
		holdFields: { timelineItems: { nodes: [holdEvent("old", label), holdEvent("new", label)] } },
		eventPages: [
			{ rows: [{ node_id: "old", event: "labeled", label: { name: label }, url: "old-url" }], next },
			{ rows: [{ node_id: "new", event: "labeled", label: { name: label }, url: eventUrl }] },
		],
	});
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.holds).toEqual([
		{ label, token: "new", takenAt: "2026-10-07T11:00:00.000Z", age: "1 hour ago", eventUrl },
	]);
	expect(statusLines(status)).toContain(`hold ${label} new 2026-10-07T11:00:00.000Z ${eventUrl} 1 hour ago`);
	expect(fixture.eventRequests).toHaveLength(2);
	expect(status.starterHold).toBeNull();
});

test("retains a hold fact when its acquisition is outside the available timeline", async () => {
	const fixture = setup([
		pull({ checks: null, reviews: page([]), threads: page([]), labels: { nodes: [{ name: "quest:active" }] } }),
	]);
	const status = await pullRequestStatus(pr, fixture.deps);
	expect(status.holds).toEqual([{ label: "quest:active", token: null, takenAt: null, age: null, eventUrl: null }]);
	expect(statusLines(status)).toContain("hold quest:active - - - unknown age");
	expect(fixture.eventRequests).toEqual([]);
});

test("never attaches a URL from a different label or event to a hold token", async () => {
	const body = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		// Older quest versions' quest:merge holds nothing, so it reports no hold.
		labels: { nodes: [{ name: "quest:merge" }, { name: "quest:active" }] },
	});
	const fixture = setup([body], {
		holdFields: { timelineItems: { nodes: [holdEvent("token", "quest:active")] } },
		eventPages: [{ rows: [{ node_id: "token", event: "labeled", label: { name: "bug" }, url: "wrong" }] }],
	});
	const { holds } = await pullRequestStatus(pr, fixture.deps);
	expect(holds.map((hold) => [hold.label, hold.eventUrl])).toEqual([["quest:active", null]]);
});

test("reports draft starter ownership as last activity, and does not invent its acquisition time", async () => {
	const draft = pull({
		checks: null,
		reviews: page([]),
		threads: page([]),
		isDraft: true,
		updatedAt: "2026-10-07T11:00:00Z",
	});
	const status = await pullRequestStatus(pr, setup([draft], { now: Date.parse("2026-10-07T12:00:00Z") }).deps);
	expect(status.starterHold).toEqual({ lastActive: "2026-10-07T11:00:00Z", age: "1 hour ago", url: URL_ });
	expect(statusLines(status)).toContain(`starter-hold 2026-10-07T11:00:00Z ${URL_} last active 1 hour ago`);
	for (const change of [{ body: "## Waiting\n\nChoose one." }, { state: "CLOSED" }, { state: "MERGED" }]) {
		const copy = structuredClone(draft);
		Object.assign(copy.data.repository.pullRequest, change);
		expect((await pullRequestStatus(pr, setup([copy]).deps)).starterHold).toBeNull();
	}
});

test("refuses a head moved between the paged state and ownership read", async () => {
	const fixture = setup([pull({ checks: null, reviews: page([]), threads: page([]) })], {
		holdFields: { headRefOid: B },
	});
	await expect(pullRequestStatus(pr, fixture.deps)).rejects.toThrow("head changed while reading its holds");
});

describe("the review record", () => {
	const C = "c".repeat(40);
	const RISK = `\n- Risk: low, \`docs only\`\n- Classified: low by default\n- Risk file: ${RISK_ID}`;
	// The maintainer's passing status on `sha`, attesting the record above.
	const on = (sha: string) => ({
		statuses: { [sha]: reviewStatus("SUCCESS", `Risk low, risk file ${RISK_ID}: passed`, sha) },
	});
	const RECORD = `## Review\n\n${REVIEW_MARK}\n\n`;
	const line = async (body: string, options: Parameters<typeof setup>[1] = {}) => {
		const fixture = setup([pull({ body, checks: null, reviews: page([]), threads: page([]) })], options);
		return statusLines(await pullRequestStatus(pr, fixture.deps)).find((l) => l.startsWith("review-record "));
	};

	test("is current when the section's last full SHA is the head, without comparing", async () => {
		expect(await line(`${RECORD}- Head: ${A}${RISK}`)).toBe(`review-record current ${A} local-review`);
	});

	test("carries across a head whose diff from the base matches the reviewed head's, and not otherwise", async () => {
		const body = `${RECORD}- Head: ${B}${RISK}`;
		expect(await line(body, { ...on(B), diffs: { [A]: "same", [B]: "same" } })).toBe(
			`review-record diff-identical ${B} local-review`,
		);
		expect(await line(body, { ...on(B), diffs: { [A]: "new", [B]: "old" } })).toBe(
			`review-record stale ${B} local-review`,
		);
	});

	test("is unknown, with a warning, when GitHub cannot compare a head", async () => {
		for (const status of [406, 403]) {
			const warnings: string[] = [];
			expect(await line(`${RECORD}- Head: ${B}${RISK}`, { ...on(B), diffs: { [A]: status }, warnings })).toBe(
				`review-record unknown ${B} local-review`,
			);
			expect(warnings).toHaveLength(1);
		}
	});

	test("reads only the Review section, so a SHA elsewhere names no review", async () => {
		expect(await line(`Fixes ${A}.\n\n## Review\n\nSkipped.\n\n## Models\n\n${C}`)).toBe("review-record -");
	});

	test("names no review for a section `quest review` never wrote, such as a skip naming the head", async () => {
		expect(await line(`## Review\n\nSkipped as trivial at ${A}.`)).toBe("review-record -");
	});
});

describe("whose review record counts", () => {
	const C = "c".repeat(40);
	const RISK = `\n- Risk: low, \`docs only\`\n- Classified: low by default\n- Risk file: ${RISK_ID}`;
	const record = (head: string, risk = RISK) =>
		`Fixes it.\n\n## Review\n\n${REVIEW_MARK}\n\n- Head: ${head}${risk}\n\n## Models\n\nSize: S`;
	const permissions = { maintainer: "admin", writer: "write", alice: "read" };
	const passed = (sha: string, login?: string) =>
		reviewStatus("SUCCESS", `Risk low, risk file ${RISK_ID}: passed`, sha, login);
	const read = async (body: string, options: Parameters<typeof setup>[1] = {}) => {
		const warnings: string[] = [];
		const fixture = setup([pull({ body, checks: null, reviews: page([]), threads: page([]) })], {
			warnings,
			permissions,
			...options,
		});
		const lines = statusLines(await pullRequestStatus(pr, fixture.deps));
		const line = (type: string) => lines.find((l) => l.startsWith(`${type} `));
		return { record: line("review-record"), risk: line("risk"), warnings, fixture };
	};
	const untrusted = (why: string) => [`example/project#1's ## Review record does not count: ${why}`];

	test("counts a record a writer's passing status attests on the head it names", async () => {
		for (const login of ["maintainer", "writer"]) {
			const attested = await read(record(A), { statuses: { [A]: passed(A, login) } });
			expect(attested).toMatchObject({
				record: `review-record current ${A} local-review`,
				risk: "risk low current low docs only",
				warnings: [],
			});
			expect(attested.fixture.statusQueries).toEqual([A]);
			expect(attested.fixture.permissionRequests).toEqual([login]);
		}
	});

	test("carries an attested record to a head with the same diff, reading the status of the head it names", async () => {
		const carried = await read(record(B), { statuses: { [B]: passed(B) }, diffs: { [A]: "same", [B]: "same" } });
		expect(carried).toMatchObject({ record: `review-record diff-identical ${B} local-review`, warnings: [] });
		expect(carried.fixture.statusQueries).toEqual([B]);
	});

	test("counts no record without a passing status from a user who can write, and hides its risk", async () => {
		const cases: [Record<string, ReturnType<typeof reviewStatus> | null>, string][] = [
			[{}, `${A} has no quest review status`],
			[{ [A]: null }, `example/project has no commit ${A}`],
			[
				{ [A]: reviewStatus("FAILURE", "Risk low: findings open", A) },
				`the quest review status on ${A} is failure, not success`,
			],
			[
				{ [A]: passed(B) },
				`the quest review status on ${A} attests another diff than main's, from ${MERGE_BASE}: https://github.com/example/project/compare/${MERGE_BASE}...${B}`,
			],
			// Reviewed from another merge base, as before a retarget or a base reset.
			[
				{ [A]: { ...passed(A), targetUrl: `https://github.com/example/project/compare/${C}...${A}` } },
				`the quest review status on ${A} attests another diff than main's, from ${MERGE_BASE}: https://github.com/example/project/compare/${C}...${A}`,
			],
			[
				{ [A]: passed(A, "alice") },
				`alice, who set the quest review status on ${A}, has read access to example/project, not write`,
			],
			[
				{ [A]: passed(A, "stranger") },
				`stranger, who set the quest review status on ${A}, has no access to example/project, not write`,
			],
			[
				{ [A]: reviewStatus("SUCCESS", "Risk low: passed", A, "github-actions", "Bot") },
				`github-actions, who set the quest review status on ${A}, is a Bot, not a user`,
			],
			[
				{ [A]: { ...passed(A), creator: null as unknown as ReturnType<typeof passed>["creator"] } },
				`the account that set the quest review status on ${A} is gone`,
			],
			[
				{ [A]: reviewStatus("SUCCESS", "looks good", A) },
				`the quest review status on ${A} names no risk: looks good`,
			],
		];
		for (const [statuses, why] of cases)
			expect(await read(record(A), { statuses })).toMatchObject({
				record: "review-record -",
				risk: "risk -",
				warnings: untrusted(why),
			});
		const hidden = await read(record(A), { statuses: { [A]: passed(A) }, permissions: { maintainer: 403 } });
		expect(hidden.warnings).toEqual(
			untrusted(
				`cannot read the permission of maintainer, who set the quest review status on ${A}: Must have push access`,
			),
		);
	});

	test("counts a record whose risk, class, and risk file are the ones its status attests, and hides a forged one", async () => {
		const risk = `${RISK.replace("by default", "by Claude Code, m, low effort, session `s`")}\n- Class: \`test\``;
		const attest = (description: string) => ({ statuses: { [A]: reviewStatus("SUCCESS", description, A) } });
		// Whether a local reviewer ran comes from the status alone, whatever the body claims.
		for (const [outcome, review] of [
			["passed", "local-review"],
			["findings accepted", "local-review"],
			["passed with no local reviewer", "no-local-review"],
		] as const)
			expect(
				await read(
					record(A, risk),
					attest(attestation({ tier: "low", class: "test", riskFile: RISK_ID }, outcome)),
				),
			).toMatchObject({
				record: `review-record current ${A} ${review}`,
				risk: "risk low current low docs only",
				warnings: [],
			});
		for (const description of [
			"Risk high, class test: passed",
			"Risk low: passed",
			"Risk low, class chore: passed",
			// So a body edited to name the base's current risk file still reads as the file the classifier read.
			"Risk low, class test: passed",
			"Risk low, class test, risk file none: passed",
			`Risk low, class test, risk file ${"0".repeat(12)}: passed`,
		])
			expect(await read(record(A, risk), attest(description))).toMatchObject({
				record: "review-record -",
				risk: "risk -",
				warnings: untrusted(`its risk differs from the quest review status on ${A}: ${description}`),
			});
		// A record whose risk was deleted after the status attested one counts for nothing either.
		expect((await read(record(A, ""), attest("Risk high: passed"))).warnings).toEqual(
			untrusted(`it names no risk, which the quest review status on ${A} attests`),
		);
	});

	test("reads the status of the last full SHA, so a land fixer's head or a hand-written line needs its own", async () => {
		const open = `Fixes it.\n\n## Review\n\nmechanical fix by codex: merged (head ${A})\n\n${REVIEW_MARK}\n\n- Head: ${B.slice(0, 12)}, named in full once no reviewer reports a finding${RISK}`;
		expect(await read(open, { statuses: { [B]: passed(B) } })).toMatchObject({
			record: "review-record -",
			warnings: untrusted(`${A} has no quest review status`),
		});
		const added = record(B, `${RISK}\n- Low findings fixed at ${C}`);
		expect((await read(added, { statuses: { [B]: passed(B) } })).warnings).toEqual(
			untrusted(`${C} has no quest review status`),
		);
	});

	test("counts no record GitHub cannot compare with its base, still reading the PR", async () => {
		for (const status of [403, 404, 422]) {
			const unread = await read(record(A), { mergeBase: status });
			expect(unread.record).toBe("review-record -");
			expect(unread.warnings).toHaveLength(1);
			expect(unread.warnings[0]).toMatch(
				new RegExp(
					`^example/project#1's ## Review record does not count: GitHub cannot compare ${A} with main`,
				),
			);
		}
	});

	test("reads no status for a section that names no full SHA, only the head's own", async () => {
		const skipped = await read("## Review\n\nSkipped.", { statuses: {} });
		expect(skipped.fixture.statusQueries).toEqual([A]);
		expect(skipped.fixture.permissionRequests).toEqual([]);
		expect(skipped.record).toBe("review-record -");
	});

	test("counts a writer's passing status on the head by itself when the body holds no record", async () => {
		// As on a fork PR Kixel Quest does not serve, whose review only its status records.
		expect(await read("Fixes it.", { statuses: { [A]: passed(A) } })).toMatchObject({
			record: `review-record current ${A} local-review`,
			risk: "risk low current low the quest review status on the head attests it",
			warnings: [],
		});
		const high = reviewStatus("SUCCESS", `Risk high, class test, risk file ${RISK_ID}: passed`, A);
		expect((await read("Fixes it.", { statuses: { [A]: high } })).risk).toMatch(/^risk high current high /);
		// The same checks as the land gate's: a failing status, a reader's, or one against another risk file counts for nothing.
		for (const status of [
			reviewStatus("FAILURE", `Risk low, risk file ${RISK_ID}: findings open`, A),
			passed(A, "reader"),
			reviewStatus("SUCCESS", `Risk low, risk file ${"0".repeat(12)}: passed`, A),
		])
			expect(await read("Fixes it.", { statuses: { [A]: status } })).toMatchObject({
				record: "review-record -",
				risk: "risk -",
			});
	});
});

describe("the risk tier", () => {
	const risk = async (body: string, options: Parameters<typeof setup>[1] = {}) => {
		const fixture = setup([pull({ body, checks: null, reviews: page([]), threads: page([]) })], options);
		const status = await pullRequestStatus(pr, fixture.deps);
		return { line: statusLines(status).find((l) => l.startsWith("risk ")), risk: status.risk };
	};
	const record = (head: string, file: string | null = RISK_ID) =>
		`## Review\n\n${REVIEW_MARK}\n\n- Head: ${head}\n- Base: origin/main at bbbbbbbbbbbb\n- Risk: high, \`it rewrites the wire format\`\n` +
		`- Classified: medium by Claude Code, claude-haiku-5-5, low effort, session \`s-1\`` +
		(file === null ? "" : `\n- Risk file: ${file}`);

	test("names the record's tier, the classifier's, and whether it covers the head", async () => {
		expect(await risk(record(A))).toEqual({
			line: "risk high current medium it rewrites the wire format",
			risk: {
				tier: "high",
				reason: "it rewrites the wire format",
				classified: "medium",
				class: null,
				state: "current",
			},
		});
		// A record with an open finding names its head by 12 characters, and no full SHA, so no status attests its risk.
		expect(
			(
				await risk(record(A.slice(0, 12)), {
					statuses: { [A]: reviewStatus("FAILURE", `Risk high, risk file ${RISK_ID}: findings open`, A) },
				})
			).line,
		).toBe("risk -");
	});

	test("carries to a later head as the review record does", async () => {
		const statuses = { [B]: reviewStatus("SUCCESS", `Risk high, risk file ${RISK_ID}: passed`, B) };
		expect((await risk(record(B), { statuses, diffs: { [A]: "same", [B]: "same" } })).line).toMatch(
			/^risk high diff-identical /,
		);
		expect((await risk(record(B), { statuses, diffs: { [A]: "new", [B]: "old" } })).line).toMatch(
			/^risk high stale /,
		);
	});

	test("is stale with its review record once the base's risk file is not the one it was classified against", async () => {
		const base = (file: { oid: string } | null) => ({ baseRef: baseTree(file) });
		const read = async (body: string, fields: Node, state = "OPEN", statuses?: Record<string, Node>) => {
			const warnings: string[] = [];
			const fixture = setup(
				[pull({ body, state, checks: null, reviews: page([]), threads: page([]), ...fields })],
				{ warnings, ...(statuses && { statuses }) },
			);
			const status = await pullRequestStatus(pr, fixture.deps);
			return { risk: status.risk?.state, record: status.reviewRecord?.state, warnings };
		};
		const stale = (why: string) => ({
			risk: "stale",
			record: "stale",
			warnings: [
				`example/project#1's ## Review record ${why}, so it covers the head no longer: run quest review again`,
			],
		});
		const current = { risk: "current", record: "current", warnings: [] };
		// The base changed RISK.md after the review, so it may no longer hold the tier or offer the class, and the tier
		// decided how much review the head got.
		expect(await read(record(A), base({ oid: "0".repeat(40) }))).toEqual(
			stale(`was classified against RISK.md ${RISK_ID}, but the base's is ${"0".repeat(12)}`),
		);
		expect(await read(record(A, "none"), base(null))).toEqual(current);
		expect(await read(record(A, "none"), base({ oid: RISK_BLOB }))).toEqual(
			stale(`was classified when the base had no RISK.md, but the base's is ${RISK_ID}`),
		);
		expect(await read(record(A), base(null))).toEqual(
			stale(`was classified against RISK.md ${RISK_ID}, but the base has none`),
		);
		// A record and status from before the risk file line name none, so they cover a base that has none.
		const before = { [A]: reviewStatus("SUCCESS", "Risk high: passed", A) };
		expect(await read(record(A, null), base(null), "OPEN", before)).toEqual(current);
		expect(await read(record(A, null), {}, "OPEN", before)).toEqual(
			stale(`was classified when the base had no RISK.md, but the base's is ${RISK_ID}`),
		);
		// A closed PR cannot land, and its base may be gone, so only its head is compared.
		expect(await read(record(A), { baseRef: null }, "MERGED")).toEqual(current);
	});

	test("is absent from a record without one, and marks a malformed one without failing the read", async () => {
		expect((await risk(`## Review\n\n${REVIEW_MARK}\n\n- Head: ${A}`)).line).toBe("risk -");
		// Read beside a well-formed PR, as a reader of many PRs does: only the malformed one's risk is marked.
		const [malformed, sound] = await Promise.all([
			risk(`## Review\n\n${REVIEW_MARK}\n\n- Head: ${A}\n- Risk:dire`),
			risk(record(A)),
		]);
		expect(malformed).toEqual({
			line: "risk - malformed - the ## Review record's risk is malformed: dire",
			risk: { state: "malformed", error: "the ## Review record's risk is malformed: dire" },
		});
		expect(sound.line).toBe("risk high current medium it rewrites the wire format");
	});
});

describe("checkpoint", () => {
	const C = "c".repeat(40);
	const bot = (login: string, state: string, commit: string, minute: number) => ({
		author: { __typename: "Bot", login },
		state,
		submittedAt: `2026-10-07T12:${String(minute).padStart(2, "0")}:00Z`,
		url: `${URL_}#pullrequestreview-${minute}`,
		commit: { oid: commit },
		reactions: { nodes: [] },
	});
	// Both bots post a check the base requires unless a test names fewer.
	const line = async (reviews: Node[], requiredBy = ["pullfrog[bot]", "other[bot]"]) =>
		statusLines(
			await pullRequestStatus(
				pr,
				setup(
					[
						pull({
							checks: null,
							reviews: page(reviews),
							threads: page([]),
						}),
					],
					{ requiredBy },
				).deps,
			),
		).filter((entry) => entry.startsWith("checkpoint "));

	test("falls due when an approving reviewer's third round leaves findings on the head", async () => {
		const rounds = [
			bot("pullfrog", "CHANGES_REQUESTED", B, 1),
			bot("pullfrog", "CHANGES_REQUESTED", C, 2),
			bot("pullfrog", "CHANGES_REQUESTED", A, 3),
		];
		expect(await line(rounds)).toEqual([`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-3`]);
		// An approval or a dismissed review of the head, a second review of one commit, or an unreviewed head is none.
		expect(await line([...rounds.slice(0, 2), bot("pullfrog", "APPROVED", A, 3)])).toEqual([]);
		expect(await line([...rounds.slice(0, 2), bot("pullfrog", "DISMISSED", A, 3)])).toEqual([]);
		expect(await line([...rounds.slice(0, 2), bot("pullfrog", "CHANGES_REQUESTED", C, 3)])).toEqual([]);
		expect(await line([...rounds, bot("pullfrog", "COMMENTED", A, 4)])).toEqual([
			`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-4`,
		]);
		// A reviewer whose only approval a push dismissed still gates, and a comment after approving the head is none.
		const dismissed = [
			bot("pullfrog", "DISMISSED", B, 1),
			bot("pullfrog", "COMMENTED", C, 2),
			bot("pullfrog", "COMMENTED", A, 3),
		];
		expect(await line(dismissed)).toEqual([`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-3`]);
		expect(
			await line([...rounds.slice(0, 2), bot("pullfrog", "APPROVED", A, 3), bot("pullfrog", "COMMENTED", A, 4)]),
		).toEqual([]);
		// The latest verdict on the head wins: a change request after an approval of it is due.
		expect(
			await line([
				...rounds.slice(0, 2),
				bot("pullfrog", "APPROVED", A, 3),
				bot("pullfrog", "CHANGES_REQUESTED", A, 4),
			]),
		).toEqual([`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-4`]);
		// Every reviewer due on the head is named.
		const other = [B, C, A].map((commit, index) => bot("other", "CHANGES_REQUESTED", commit, index + 5));
		expect(await line([...rounds, ...other])).toEqual([
			`checkpoint pullfrog round 3 ${URL_}#pullrequestreview-3`,
			`checkpoint other round 3 ${URL_}#pullrequestreview-7`,
		]);
	});

	test("ignores a reviewer the base does not require", async () => {
		const rounds = [B, C, A].map((commit, index) => bot("pullfrog", "CHANGES_REQUESTED", commit, index + 1));
		const other = [B, C, A].map((commit, index) => bot("other", "CHANGES_REQUESTED", commit, index + 5));
		expect(await line([...rounds, ...other], ["other[bot]"])).toEqual([
			`checkpoint other round 3 ${URL_}#pullrequestreview-7`,
		]);
		expect(await line(rounds, [])).toEqual([]);
	});

	test("ignores reviewers that only comment, and people", async () => {
		const commented = [B, C, A].map((commit, index) => bot("coderabbitai", "COMMENTED", commit, index + 1));
		expect(await line(commented)).toEqual([]);
		const person = [B, C, A].map((commit, index) => ({
			...bot("alice", "CHANGES_REQUESTED", commit, index + 1),
			author: { __typename: "User", login: "alice" },
		}));
		expect(await line(person)).toEqual([]);
	});
});

describe("duplicate quests", () => {
	const other = "https://github.com/example/project/pull/2";
	const third = "https://github.com/example/project/pull/3";
	const files = (paths: [string, string][], more = false) => ({
		pageInfo: { hasNextPage: more },
		nodes: paths.map(([path, changeType]) => ({ path, changeType })),
	});

	test("reports each quest the PR adds that another open PR adds at its path or under its title", async () => {
		const body = pull({ checks: null, reviews: page([]), threads: page([]) });
		const status = await pullRequestStatus(
			pr,
			setup([body], {
				open: {
					pulls: [
						{
							number: 1,
							url: URL_,
							headRefOid: A,
							files: files([
								["quest/m0/hang.md", "ADDED"],
								["quest/m1/fips.md", "ADDED"],
								["quest/m0/edited.md", "MODIFIED"],
								["quest/AGENTS.md", "ADDED"],
								["src/a.ts", "ADDED"],
							]),
						},
						{
							number: 2,
							url: other,
							headRefOid: B,
							files: files([
								["quest/m0/hang.md", "ADDED"],
								["quest/m0/edited.md", "ADDED"],
							]),
						},
						{
							number: 3,
							url: third,
							headRefOid: "c".repeat(40),
							// Over 100 files, so REST lists them.
							files: files([["quest/m0/edited.md", "MODIFIED"]], true),
						},
					],
					files: {
						3: [
							{ filename: "quest/m0/fips-hang.md", status: "added" },
							{ filename: "quest/m0/edited.md", status: "modified" },
						],
					},
					blobs: {
						[`${A}:quest/m0/hang.md`]: "# [S] Dart iOS hang\n\n## Goal\n\nx\n",
						[`${A}:quest/m1/fips.md`]: "# [M] Fix the  FIPS fork-test hang\n\n## Goal\n\nx\n",
						[`${B}:quest/m0/hang.md`]: "# [S] Something else\n\n## Goal\n\nx\n",
						[`${B}:quest/m0/edited.md`]: "# [S] Edited\n\n## Goal\n\nx\n",
						[`${"c".repeat(40)}:quest/m0/fips-hang.md`]:
							"# [S] fix the fips fork-test hang\n\n## Goal\n\nx\n",
					},
				},
			}).deps,
		);
		expect(status.duplicates).toEqual([
			{ path: "quest/m0/hang.md", url: other, other: "quest/m0/hang.md" },
			{ path: "quest/m1/fips.md", url: third, other: "quest/m0/fips-hang.md" },
		]);
		expect(statusLines(status).filter((line) => line.startsWith("duplicate "))).toEqual([
			`duplicate quest/m0/hang.md ${other} quest/m0/hang.md`,
			`duplicate quest/m1/fips.md ${third} quest/m0/fips-hang.md`,
		]);
	});

	test("a PR that adds no quest reads no titles, and a closed one reads no open PRs", async () => {
		const open = {
			pulls: [
				{ number: 1, url: URL_, headRefOid: A, files: files([["quest/m0/a.md", "MODIFIED"]]) },
				{ number: 2, url: other, headRefOid: B, files: files([["quest/m0/a.md", "ADDED"]]) },
			],
		};
		const body = pull({ checks: null, reviews: page([]), threads: page([]) });
		expect((await pullRequestStatus(pr, setup([body], { open }).deps)).duplicates).toEqual([]);
		const closed = pull({ checks: null, reviews: page([]), threads: page([]), state: "CLOSED" });
		const opened = { pulls: [{ ...open.pulls[0]!, files: files([["quest/m0/a.md", "ADDED"]]) }, open.pulls[1]!] };
		expect((await pullRequestStatus(pr, setup([closed], { open: opened }).deps)).duplicates).toEqual([]);
	});
});
