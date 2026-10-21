import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getSubagentEvidencePaths } from "../artifact-storage.ts";
import { ACTIVITY_FILE_ENV, ACTIVITY_RUN_ENV } from "./activity.ts";

export interface SubagentEvidence {
	runId: string;
	activityFile: string;
	resultFile: string;
	cwd?: string;
	error?: string;
	finalized?: boolean;
}

interface EvidenceIdentity {
	cwd: string;
	sessionFile: string;
	id: string;
	name: string;
	agent?: string;
	task: string;
}

export interface SubagentEvidenceOutcome {
	status: "completed" | "failed" | "cancelled" | "pinged" | "detached";
	id?: string;
	name: string;
	task: string;
	agent?: string;
	sessionFile?: string;
	exitCode?: number;
	elapsed?: number;
	summary?: string;
	error?: string;
	errorMessage?: string;
	timedOut?: string;
	timedOutAfter?: number;
	ping?: { name: string; message: string };
}

function limit(value: string | undefined, max = 8000): string | undefined {
	return value && value.length > max
		? `${value.slice(0, max)}\n[truncated]`
		: value;
}

function writeSnapshot(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function createSubagentEvidence(
	options: EvidenceIdentity,
): SubagentEvidence {
	const evidence: SubagentEvidence = {
		runId: options.id,
		cwd: options.cwd,
		...getSubagentEvidencePaths(options.cwd, options.sessionFile, options.id),
	};
	try {
		writeSnapshot(evidence.resultFile, {
			version: 1,
			runId: options.id,
			name: options.name,
			agent: options.agent,
			task: limit(options.task),
			cwd: options.cwd,
			status: "pending",
			terminal: false,
			updatedAt: new Date().toISOString(),
			activityFile: evidence.activityFile,
		});
		writeFileSync(evidence.activityFile, "", { flag: "a", mode: 0o600 });
	} catch (error) {
		evidence.error = String(error);
	}
	return evidence;
}

export function getSubagentEvidenceEnv(
	evidence?: SubagentEvidence,
): Record<string, string> {
	return {
		[ACTIVITY_FILE_ENV]: evidence?.activityFile ?? "",
		[ACTIVITY_RUN_ENV]: evidence?.runId ?? "",
	};
}

function readRecentActivity(file: string): unknown[] {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = statSync(file).size;
		const start = Math.max(0, size - 16000);
		const buffer = Buffer.alloc(size - start);
		const read = readSync(fd, buffer, 0, buffer.length, start);
		const lines = buffer.subarray(0, read).toString("utf8").split("\n");
		if (start) lines.shift();
		return lines
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			})
			.slice(-8);
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function recordSubagentOutcome(
	evidence: SubagentEvidence | undefined,
	outcome: SubagentEvidenceOutcome,
): void {
	if (!evidence || evidence.finalized) return;
	try {
		writeSnapshot(evidence.resultFile, {
			version: 1,
			runId: evidence.runId,
			name: outcome.name,
			agent: outcome.agent,
			task: limit(outcome.task),
			cwd: evidence.cwd,
			status: outcome.status,
			terminal: outcome.status !== "detached",
			updatedAt: new Date().toISOString(),
			exitCode: outcome.exitCode,
			elapsed: outcome.elapsed,
			error: limit(outcome.errorMessage ?? outcome.error),
			timedOut: outcome.timedOut,
			timedOutAfter: outcome.timedOutAfter,
			summary: limit(outcome.summary, 16000),
			sessionFile: outcome.sessionFile,
			ping: outcome.ping
				? { name: outcome.ping.name, message: limit(outcome.ping.message) }
				: undefined,
			activityFile: evidence.activityFile,
			previousActivityFile: existsSync(`${evidence.activityFile}.previous`)
				? `${evidence.activityFile}.previous`
				: undefined,
			recentActivity: readRecentActivity(evidence.activityFile),
		});
		evidence.error = undefined;
		evidence.finalized = outcome.status !== "detached";
	} catch (error) {
		evidence.error = String(error);
	}
}

export function formatSubagentEvidence(evidence?: SubagentEvidence): string {
	if (!evidence) return "";
	return (
		`\n\nActivity: ${evidence.activityFile}\nRun evidence: ${evidence.resultFile}` +
		(evidence.error ? `\nEvidence write failed: ${evidence.error}` : "") +
		"\nRead these on demand for progress or failure diagnosis; activity is evidence, not a completion verdict."
	);
}
