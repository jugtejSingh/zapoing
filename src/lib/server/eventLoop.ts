/**
 * Hands the event loop back so a pending HTTP request can run. better-sqlite3 is
 * synchronous, so long background work has to be cut into chunks with this between them.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
