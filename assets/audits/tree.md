# Tree audit

The goal is a quest tree that agrees with itself and the code, with each quest in the milestone its priority calls for.
The scope is every outstanding quest.

Look for:

- Disagreements: quests whose goals or plans contradict each other, the code, or the repository's docs.
- Conflicts: quests that would change the same code or interface incompatibly, or that must land in order without a `Required` link.
- Misaligned priorities: a quest whose milestone no longer matches its urgency, or that depends on later-milestone work without a `Required` link saying so (`quest check` already rejects a `Required` link to a later milestone).
- Stale plans: work already done, blockers that have cleared, or references to code that no longer exists.
- Obsolete quests: a problem that is no longer real, or a plan a later change or decision has made the wrong solution.

Where the tree is too large for one reader, split the reading across parallel sub-agents, each given a slice of the scope and returning its findings with evidence (a path, line, or commit).

Apply factual corrections and changes the maintainer has already decided.
Moving a quest between milestones, deleting one whose problem is still real, and any unresolved scope, priority, or API choice are the maintainer's decisions, never factual corrections; recommendations are not decisions.

Move and delete quests with `quest mv` and `quest rm`, which update the links to them; edit any mentions they report.
Report each change with its evidence.
