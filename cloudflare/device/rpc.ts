// A JSON-RPC client over one WebSocket, as both the Chrome DevTools Protocol
// and the WebKit inspector protocol speak. Every call and wait has a deadline,
// and a device that stops answering fails the run rather than hanging it.

/** One inspector protocol message from the device. */
export interface Message {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string; code?: number };
}

/** The most bytes one message may hold; a screenshot of a large iPad fits well inside. */
export const MAX_MESSAGE = 64 * 1024 * 1024;

/** A connected inspector session. */
export class Rpc {
	private next = 1;
	private readonly calls = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(m: Message) => void>();
	private closed: Error | null = null;

	private constructor(
		private readonly socket: WebSocket,
		private readonly timeout: number,
	) {
		socket.addEventListener("message", (event) => this.receive(event.data));
		socket.addEventListener("close", () => this.fail(new Error("the device closed the inspector connection")));
		socket.addEventListener("error", () => this.fail(new Error("the inspector connection failed")));
	}

	/** Connect to `url`, failing after `timeout` milliseconds. */
	static connect(url: string, timeout: number): Promise<Rpc> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`no inspector answered at ${url} within ${timeout} ms`));
			}, timeout);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve(new Rpc(socket, timeout));
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error(`could not connect to the inspector at ${url}`));
			});
		});
	}

	/** Call `method` and return its result, throwing the protocol's error. */
	async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		if (this.closed) throw this.closed;
		const id = this.next++;
		const reply = await new Promise<Message>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.calls.delete(id);
				reject(new Error(`${method} got no answer within ${this.timeout} ms`));
			}, this.timeout);
			this.calls.set(id, {
				resolve: (m) => (clearTimeout(timer), resolve(m)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
		if (reply.error) throw new Error(`${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
		return reply.result ?? {};
	}

	/** Wait for the first event `method` that `match` accepts. */
	event(method: string, match: (params: Record<string, unknown>) => boolean = () => true): Promise<Message> {
		if (this.closed) return Promise.reject(this.closed);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new Error(`no ${method} event within ${this.timeout} ms`));
			}, this.timeout);
			const listener = (m: Message) => {
				if (m.method === "__closed") {
					clearTimeout(timer);
					this.listeners.delete(listener);
					reject(this.closed!);
				} else if (m.method === method && match(m.params ?? {})) {
					clearTimeout(timer);
					this.listeners.delete(listener);
					resolve(m);
				}
			};
			this.listeners.add(listener);
		});
	}

	/** Receive every event, until the returned function stops it. */
	listen(listener: (m: Message) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Close the connection. */
	close(): void {
		this.socket.close();
	}

	private receive(data: unknown): void {
		const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
		if (text.length > MAX_MESSAGE)
			return this.fail(new Error(`an inspector message exceeded ${MAX_MESSAGE} bytes`));
		let message: Message;
		try {
			message = JSON.parse(text) as Message;
		} catch {
			return this.fail(new Error("the inspector sent a message that is not JSON"));
		}
		if (typeof message !== "object" || message === null)
			return this.fail(new Error("the inspector sent a message that is not an object"));
		if (typeof message.id === "number") {
			const call = this.calls.get(message.id);
			this.calls.delete(message.id);
			call?.resolve(message);
			return;
		}
		for (const listener of [...this.listeners]) listener(message);
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		for (const call of this.calls.values()) call.reject(error);
		this.calls.clear();
		for (const listener of [...this.listeners]) listener({ method: "__closed" });
	}
}
