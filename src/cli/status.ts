// `quest status`, `quest pr view`, and `quest pr list`: a pull request's state, discussion, and files, as stable plain lines.
import type { Check, Comment, PullFiles, PullView, Status } from "../core";

/** Stable plain lines: a record type, then space-separated fields, with any free text last. */
export function statusLines(status: Status): string[] {
	const dash = (value: string | number | null) => (value === null ? "-" : String(value));
	const check = (kind: string, c: Check) =>
		`check ${kind} ${c.required ? "required" : "optional"} ${c.result} ${dash(c.url)} ${c.name}`;
	return [
		`url ${status.url}`,
		`state ${status.state}`,
		`draft ${status.draft}`,
		`head ${status.head}`,
		`mergeable ${status.mergeable}`,
		`merge-state ${status.mergeState}`,
		`review-decision ${dash(status.reviewDecision)}`,
		status.reviewRecord === null
			? "review-record -"
			: `review-record ${status.reviewRecord.state} ${status.reviewRecord.head} ${status.reviewRecord.localReview ? "local-review" : "no-local-review"}`,
		status.risk === null
			? "risk -"
			: status.risk.state === "malformed"
				? `risk - malformed - ${status.risk.error}`
				: `risk ${status.risk.tier} ${status.risk.state} ${dash(status.risk.classified)} ${dash(status.risk.reason)}`,
		`class ${dash(status.risk === null || status.risk.state === "malformed" ? null : status.risk.class)}`,
		status.autoMerge === null
			? "auto-merge -"
			: `auto-merge ${status.autoMerge.method} ${status.autoMerge.enabledBy} ${status.autoMerge.enabledAt} ${dash(status.autoMerge.head)}`,
		status.mergeQueue === null
			? "merge-queue -"
			: `merge-queue ${status.mergeQueue.state} ${status.mergeQueue.position} ${status.mergeQueue.enqueuedAt}`,
		status.landingStopped === null
			? "landing-stopped -"
			: `landing-stopped ${status.landingStopped.reason} ${status.landingStopped.actor} ${status.landingStopped.at}`,
		`checks ${dash(status.checks.state)} passed=${status.checks.passed} failing=${status.checks.failing.length} pending=${status.checks.pending.length}`,
		...status.checks.failing.map((c) => check("failing", c)),
		...status.checks.pending.map((c) => check("pending", c)),
		...status.reviews.map(
			(r) => `review ${r.current ? "current" : "stale"} ${r.state} ${r.reviewer} ${r.submittedAt} ${r.url}`,
		),
		...status.checkpoints.map((c) => `checkpoint ${c.reviewer} round ${c.round} ${c.url}`),
		...status.reactions.map((r) => `reacted:${r.content} ${r.actor} ${r.createdAt} ${r.url}`),
		...status.threads.map(
			(t) =>
				`thread ${t.id} ${t.outdated ? "outdated" : "current"} ${t.lastAuthor} ${t.url} ${t.path}:${dash(t.line)}`,
		),
		...status.signals.map((s) => `signal ${s.kind} ${s.url} ${s.author}: ${s.text}`),
		...(status.holds.length
			? status.holds.map(
					(hold) =>
						`hold ${hold.label} ${dash(hold.token)} ${dash(hold.takenAt)} ${dash(hold.eventUrl)} ${hold.age ?? "unknown age"}`,
				)
			: ["hold -"]),
		...(status.starterHold
			? [
					`starter-hold ${status.starterHold.lastActive} ${status.starterHold.url} last active ${status.starterHold.age}`,
				]
			: []),
		...status.duplicates.map((d) => `duplicate ${d.path} ${d.url} ${d.other}`),
	];
}

/**
 * A PR's title, body, and discussion as plain text: `field value` lines, then the body, then each comment and review
 * by time and each review thread with its comments, every post after a `--` line and a header line.
 */
export function viewLines(view: PullView): string[] {
	const post = (header: string, body: string) => ["--", header, ...(body === "" ? [] : [body])];
	const comment = (c: Comment) => post(`comment ${c.author} ${c.createdAt} ${c.url}`, c.body);
	const dated = [
		...view.comments.map((c) => ({ at: c.createdAt, lines: comment(c) })),
		...view.reviews.map((r) => ({
			at: r.submittedAt,
			lines: post(`review ${r.state} ${r.reviewer} ${r.submittedAt} ${r.url}`, r.body),
		})),
	].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	return [
		`url ${view.url}`,
		`state ${view.state}`,
		`draft ${view.draft}`,
		`author ${view.author}`,
		`title ${view.title}`,
		...post("body", view.body),
		...dated.flatMap((item) => item.lines),
		...view.threads.flatMap((t) => [
			"--",
			`thread ${t.id} ${t.outdated ? "outdated" : "current"} ${t.resolved ? "resolved" : "unresolved"} ${t.path}:${t.line ?? "-"}`,
			...t.comments.flatMap(comment),
		]),
	];
}

/** One `file <url> <path>` line per changed path of each PR, so a `grep` for a path names the PRs changing it. */
export function pullFileLines(pulls: PullFiles[]): string[] {
	return pulls.flatMap((pull) => pull.files.map((path) => `file ${pull.url} ${path}`));
}
