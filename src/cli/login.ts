// `quest login`: this host gets a token to post with once a person signed in at Kixel Quest approves the code it shows,
// as OAuth's device authorization grant (RFC 8628) does, which Kixel Quest's `/login/device` and `/login/token` serve.
import { kixelUrl, removeLogin, saveLogin } from "./tokens";

/** What signing in needs from its host. */
export interface LoginDependencies {
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	now(): number;
	sleep(ms: number): Promise<unknown>;
	/** The name the token carries on Kixel Quest's Tokens page. */
	hostname: string;
	/** Asks the person `question`, answering their line, or null once their input ends. */
	ask(question: string): Promise<string | null>;
	say(line: string): void;
}

/** What `quest login` tells the person before they choose whether to upload transcripts. */
export const TRANSCRIPTS_QUESTION =
	"Upload this host's agent transcripts with its session records? A transcript holds everything a session saw, which " +
	"can include pasted secrets and file contents, and the maintainers of the repository it worked on can read it. [y/N] ";

/** The URL signed in to and the name its token carries, once Kixel Quest issued a token and it is stored. */
export interface SignedIn {
	url: string;
	label: string;
	transcripts: boolean;
}

/**
 * Ask whether to upload transcripts, show a code to approve at Kixel Quest, wait for the approval, and store the token
 * it issues, replacing this host's earlier one.
 */
export async function login(deps: LoginDependencies): Promise<SignedIn> {
	const url = kixelUrl(deps.env);
	const transcripts = await askTranscripts(deps);
	const label = deps.hostname;
	const code = parseCode(await post(deps, url, "/login/device", { label }), url);
	deps.say(`Open ${code.verification_uri}, sign in with GitHub, and enter the code ${code.user_code}.`);
	deps.say(`Waiting for its approval; the code expires in ${Math.round(code.expires_in / 60)} minutes.`);
	const deadline = deps.now() + code.expires_in * 1000;
	for (;;) {
		await deps.sleep(code.interval * 1000);
		if (deps.now() >= deadline) throw new Error(expired);
		const answer = await post(deps, url, "/login/token", { device_code: code.device_code });
		const token = issued(answer, url);
		if (token === null) continue;
		saveLogin(url, { token, transcripts }, deps.env);
		return { url, label, transcripts };
	}
}

/** Forget this host's token for the Kixel Quest `env` names, returning its URL and whether there was one. */
export function logout(env: NodeJS.ProcessEnv): { url: string; removed: boolean } {
	const url = kixelUrl(env);
	return { url, removed: removeLogin(url, env) };
}

const expired = "the code expired before anyone approved it; run `quest login` again for a new one";

/** Whether the person agrees to upload transcripts: only a yes does, as `[y/N]` says. */
async function askTranscripts(deps: LoginDependencies): Promise<boolean> {
	const answer = await deps.ask(TRANSCRIPTS_QUESTION);
	if (answer === null) throw new Error("no answer to whether to upload transcripts, so this host is not signed in");
	return ["y", "yes"].includes(answer.trim().toLowerCase());
}

/** What Kixel Quest answered a request: its status and parsed JSON body. */
interface Answer {
	path: string;
	status: number;
	body: Record<string, unknown>;
}

async function post(deps: LoginDependencies, url: string, path: string, body: unknown): Promise<Answer> {
	let response: Response;
	let text: string;
	try {
		response = await deps.fetch(`${url}${path}`, {
			method: "POST",
			// The answer carries a token, which is Kixel Quest's alone, so it follows no redirect elsewhere.
			redirect: "error",
			headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "quest" },
			body: JSON.stringify(body),
		});
		text = await response.text();
	} catch (error) {
		throw new Error(`${url}${path} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${url}${path} answered HTTP ${response.status}, not a JSON object: ${text.slice(0, 200)}`);
	return { path, status: response.status, body: parsed as Record<string, unknown> };
}

/** RFC 8628's device authorization response, as `/login/device` answers it. */
interface Code {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

function parseCode(answer: Answer, url: string): Code {
	const { body } = answer;
	const malformed = (why: string) => new Error(`${url}${answer.path} answered HTTP ${answer.status}: ${why}`);
	if (answer.status !== 200) throw malformed(String(body.error ?? "no error named"));
	for (const field of ["device_code", "user_code", "verification_uri"] as const)
		if (typeof body[field] !== "string" || body[field] === "") throw malformed(`${field} is not a string`);
	for (const field of ["expires_in", "interval"] as const) {
		const value = body[field];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
			throw malformed(`${field} is not a positive whole number`);
	}
	return body as unknown as Code;
}

/** The token an approved code earns, or null while its approval is pending. */
function issued(answer: Answer, url: string): string | null {
	const { status, body } = answer;
	if (status === 200) {
		if (typeof body.access_token !== "string" || body.access_token === "" || body.token_type !== "Bearer")
			throw new Error(`${url}${answer.path} answered no bearer access_token`);
		return body.access_token;
	}
	if (status === 400 && body.error === "authorization_pending") return null;
	if (status === 400 && body.error === "expired_token") throw new Error(expired);
	throw new Error(`${url}${answer.path} answered HTTP ${status}: ${String(body.error ?? "no error named")}`);
}
