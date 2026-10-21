import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ACTIVITY_FILE_ENV,
	ACTIVITY_RUN_ENV,
} from "../../src/runtime/activity.ts";
import {
	createSubagentEvidence,
	formatSubagentEvidence,
	getSubagentEvidenceEnv,
	recordSubagentOutcome,
} from "../../src/runtime/activity-evidence.ts";
import { assert, describe, it } from "../support/index.ts";

function withEvidence(test: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "subagent-evidence-"));
	const previous = process.env.PI_ARTIFACT_PROJECT_ROOT;
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(root, "history");
	try {
		test(root);
	} finally {
		if (previous === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		else process.env.PI_ARTIFACT_PROJECT_ROOT = previous;
		rmSync(root, { recursive: true, force: true });
	}
}

function create(root: string, id = "run-1") {
	return createSubagentEvidence({
		cwd: join(root, "project"),
		sessionFile: join(root, "sessions", "parent.jsonl"),
		id,
		name: "reviewer",
		agent: "reviewer",
		task: "Inspect failure",
	});
}

function snapshot(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf8"));
}

describe("subagent activity evidence", () => {
	it("writes a non-terminal pending snapshot before a subagent finishes", () =>
		withEvidence((root) => {
			const evidence = create(root);
			const initial = snapshot(evidence.resultFile);

			assert.equal(initial.status, "pending");
			assert.equal(initial.terminal, false);
			assert.equal(initial.activityFile, evidence.activityFile);
		}));

	it("persists failed outcome details for a failed child", () =>
		withEvidence((root) => {
			const evidence = create(root);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				agent: "reviewer",
				task: "Inspect failure",
				status: "failed",
				exitCode: 1,
				error: "test failed",
			});
			const result = snapshot(evidence.resultFile);

			assert.equal(result.status, "failed");
			assert.equal(result.terminal, true);
			assert.equal(result.error, "test failed");
			assert.equal(result.cwd, join(root, "project"));
		}));

	it("persists cancelled outcome details for a cancelled child", () =>
		withEvidence((root) => {
			const evidence = create(root);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "cancelled",
				error: "cancelled",
			});

			assert.equal(snapshot(evidence.resultFile).status, "cancelled");
		}));

	it("persists pinged outcome details for a child requesting help", () =>
		withEvidence((root) => {
			const evidence = create(root);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "pinged",
				ping: { name: "reviewer", message: "Need parent input" },
			});

			assert.deepEqual(snapshot(evidence.resultFile).ping, {
				name: "reviewer",
				message: "Need parent input",
			});
		}));

	it("keeps detached evidence non-terminal and eligible for later finalization", () =>
		withEvidence((root) => {
			const evidence = create(root);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "detached",
			});
			const detached = snapshot(evidence.resultFile);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "completed",
				summary: "done",
			});

			assert.equal(detached.terminal, false);
			assert.equal(snapshot(evidence.resultFile).status, "completed");
		}));

	it("does not overwrite a finalized outcome when finalization repeats", () =>
		withEvidence((root) => {
			const evidence = create(root);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "failed",
				error: "first error",
			});
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "completed",
				summary: "late result",
			});

			const result = snapshot(evidence.resultFile);
			assert.equal(result.status, "failed");
			assert.equal(result.error, "first error");
		}));

	it("isolates artifacts for distinct runs resumed from the same parent session", () =>
		withEvidence((root) => {
			const first = create(root, "run-one");
			const second = create(root, "run-two");
			recordSubagentOutcome(first, {
				name: "reviewer",
				task: "Inspect failure",
				status: "failed",
				error: "first",
			});
			recordSubagentOutcome(second, {
				name: "reviewer",
				task: "Inspect failure",
				status: "completed",
				summary: "second",
			});

			assert.notEqual(first.resultFile, second.resultFile);
			assert.equal(snapshot(first.resultFile).status, "failed");
			assert.equal(snapshot(second.resultFile).status, "completed");
		}));

	it("does not expose a session path when a final outcome does not provide one", () =>
		withEvidence((root) => {
			const evidence = create(root);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "failed",
				error: "no session reference",
			});

			assert.equal(
				Object.hasOwn(snapshot(evidence.resultFile), "sessionFile"),
				false,
			);
		}));

	it("keeps valid recent activity when the activity file ends with partial JSON", () =>
		withEvidence((root) => {
			const evidence = create(root);
			writeFileSync(
				evidence.activityFile,
				`${JSON.stringify({ kind: "tool_end", text: "useful failure" })}\n{"kind":`,
			);
			recordSubagentOutcome(evidence, {
				name: "reviewer",
				task: "Inspect failure",
				status: "failed",
				error: "failed",
			});

			assert.deepEqual(snapshot(evidence.resultFile).recentActivity, [
				{ kind: "tool_end", text: "useful failure" },
			]);
		}));

	it("returns evidence environment variables for child recording", () =>
		withEvidence((root) => {
			const evidence = create(root);

			assert.deepEqual(getSubagentEvidenceEnv(evidence), {
				[ACTIVITY_FILE_ENV]: evidence.activityFile,
				[ACTIVITY_RUN_ENV]: evidence.runId,
			});
		}));

	it("records evidence write failures without throwing to the caller", () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-evidence-"));
		const previous = process.env.PI_ARTIFACT_PROJECT_ROOT;
		const blockedRoot = join(root, "blocked");
		writeFileSync(blockedRoot, "not a directory");
		process.env.PI_ARTIFACT_PROJECT_ROOT = blockedRoot;
		try {
			const evidence = create(root);

			assert.ok(evidence.error);
			assert.match(formatSubagentEvidence(evidence), /Evidence write failed:/);
			assert.equal(existsSync(evidence.resultFile), false);
		} finally {
			if (previous === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
			else process.env.PI_ARTIFACT_PROJECT_ROOT = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
