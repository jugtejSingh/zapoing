/**
 * An in-memory IMAP server plus a stand-in for imapflow's ImapFlow, for tests.
 * Only covers what mailSync calls. It follows the IMAP rules that matter for
 * sync: uids only ever go up, deletes leave gaps, `n:*` always includes the
 * newest message, and CONDSTORE `changedSince` returns only changed messages.
 */

export type FakeMessage = {
	uid: number;
	source: Buffer;
	threadId: string | undefined;
	labels: Set<string> | undefined;
	modseq: bigint;
};

export type FakeFolder = {
	path: string;
	specialUse: string | undefined;
	uidValidity: bigint;
	uidNext: number;
	highestModseq: bigint;
	noModseq: boolean;
	messages: FakeMessage[];
};

export type FakeServer = {
	folders: Map<string, FakeFolder>;
	/** Makes the uid search fail (imapflow returns false). */
	searchFails: boolean;
	/** Throws mid-fetch after this many messages, like a dropped connection. */
	failAfterMessages: number | null;
	/** Every fetch as `range` or `range changedSince=n`. */
	fetchLog: string[];
};

export type NewMessage = {
	subject: string;
	from?: string;
	to?: string;
	cc?: string;
	replyTo?: string;
	date?: Date;
	body?: string;
	threadId?: string;
	/** Gmail labels, e.g. '\\CategoryPromotions'. Leave out for a non-Gmail server. */
	labels?: string[];
	/** File attachments; the message becomes multipart/mixed. */
	attachments?: { filename: string; contentType: string; content: string }[];
};

const servers = new Map<string, FakeServer>();

export function resetFakeServers(): void {
	servers.clear();
}

/** A new, empty server for this login, with an INBOX. */
export function createFakeServer(username: string): FakeServer {
	const server: FakeServer = {
		folders: new Map(),
		searchFails: false,
		failAfterMessages: null,
		fetchLog: []
	};

	addFolder(server, 'INBOX', undefined);
	servers.set(username, server);

	return server;
}

export function addFolder(
	server: FakeServer,
	path: string,
	specialUse: string | undefined
): FakeFolder {
	const folder: FakeFolder = {
		path,
		specialUse,
		uidValidity: 1n,
		uidNext: 1,
		highestModseq: 1n,
		noModseq: false,
		messages: []
	};

	server.folders.set(path, folder);

	return folder;
}

export function folderOf(server: FakeServer, path: string): FakeFolder {
	const folder = server.folders.get(path);

	if (!folder) {
		throw new Error('No folder ' + path);
	}

	return folder;
}

function rawSource(message: NewMessage): Buffer {
	let from = 'Sender <sender@example.com>';

	if (message.from) {
		from = message.from;
	}

	let to = 'Reader <reader@example.com>';

	if (message.to) {
		to = message.to;
	}

	let date = new Date('2026-01-01T00:00:00Z');

	if (message.date) {
		date = message.date;
	}

	let body = 'Body of ' + message.subject;

	if (message.body) {
		body = message.body;
	}

	const lines = [
		'From: ' + from,
		'To: ' + to,
		'Subject: ' + message.subject,
		'Date: ' + date.toUTCString(),
		'Message-ID: <' + crypto.randomUUID() + '@example.com>'
	];

	if (message.cc) {
		lines.push('Cc: ' + message.cc);
	}

	if (message.replyTo) {
		lines.push('Reply-To: ' + message.replyTo);
	}

	if (!message.attachments || message.attachments.length === 0) {
		lines.push('Content-Type: text/plain; charset=utf-8', '', body, '');

		return Buffer.from(lines.join('\r\n'));
	}

	const boundary = 'fake-boundary-' + crypto.randomUUID();
	lines.push('MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="' + boundary + '"', '');
	lines.push('--' + boundary, 'Content-Type: text/plain; charset=utf-8', '', body, '');

	for (const attachment of message.attachments) {
		lines.push(
			'--' + boundary,
			'Content-Type: ' + attachment.contentType + '; name="' + attachment.filename + '"',
			'Content-Disposition: attachment; filename="' + attachment.filename + '"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(attachment.content).toString('base64'),
			''
		);
	}

	lines.push('--' + boundary + '--', '');

	return Buffer.from(lines.join('\r\n'));
}

/** Delivers a message; it gets the next uid, as on a real server. Returns that uid. */
export function deliver(folder: FakeFolder, message: NewMessage): number {
	const uid = folder.uidNext;
	folder.uidNext = folder.uidNext + 1;
	folder.highestModseq = folder.highestModseq + 1n;

	let labels: Set<string> | undefined = undefined;

	if (message.labels) {
		labels = new Set(message.labels);
	}

	folder.messages.push({
		uid,
		source: rawSource(message),
		threadId: message.threadId,
		labels,
		modseq: folder.highestModseq
	});

	return uid;
}

/** Expunges a message. Its uid is never handed out again. */
export function expunge(folder: FakeFolder, uid: number): void {
	const kept: FakeMessage[] = [];

	for (const message of folder.messages) {
		if (message.uid !== uid) {
			kept.push(message);
		}
	}

	folder.messages = kept;
	folder.highestModseq = folder.highestModseq + 1n;
}

/** Gmail moving a message to another tab: new labels, new modseq. */
export function relabel(folder: FakeFolder, uid: number, labels: string[]): void {
	folder.highestModseq = folder.highestModseq + 1n;

	for (const message of folder.messages) {
		if (message.uid === uid) {
			message.labels = new Set(labels);
			message.modseq = folder.highestModseq;
		}
	}
}

/** The server rebuilt the folder: new UIDVALIDITY, every message renumbered from 1. */
export function renumber(folder: FakeFolder): void {
	folder.uidValidity = folder.uidValidity + 1n;
	folder.uidNext = 1;

	for (const message of folder.messages) {
		message.uid = folder.uidNext;
		folder.uidNext = folder.uidNext + 1;
	}
}

type OpenedMailbox = {
	path: string;
	uidValidity: bigint;
	exists: number;
	highestModseq: bigint | undefined;
	noModseq: boolean;
};

type FetchedMessage = {
	uid: number;
	source: Buffer;
	threadId: string | undefined;
	labels: Set<string> | undefined;
};

export class FakeImapFlow {
	mailbox: OpenedMailbox | false = false;
	private username: string;
	private server: FakeServer | null = null;

	constructor(options: { auth: { user: string } }) {
		this.username = options.auth.user;
	}

	/** ponytail: the fake never emits, so listening does nothing but createClient expects the method. */
	on(): void {}

	async connect(): Promise<void> {
		const server = servers.get(this.username);

		if (!server) {
			throw new Error('Connection refused for ' + this.username);
		}

		this.server = server;
	}

	async logout(): Promise<void> {
		this.server = null;
		this.mailbox = false;
	}

	private connected(): FakeServer {
		if (!this.server) {
			throw new Error('Not connected');
		}

		return this.server;
	}

	private openFolder(): FakeFolder {
		if (this.mailbox === false) {
			throw new Error('No mailbox open');
		}

		return folderOf(this.connected(), this.mailbox.path);
	}

	async list(): Promise<{ path: string; specialUse: string | undefined }[]> {
		const result: { path: string; specialUse: string | undefined }[] = [];

		for (const folder of this.connected().folders.values()) {
			result.push({ path: folder.path, specialUse: folder.specialUse });
		}

		return result;
	}

	async getMailboxLock(path: string): Promise<{ release: () => void }> {
		const folder = folderOf(this.connected(), path);

		let highestModseq: bigint | undefined = folder.highestModseq;

		if (folder.noModseq) {
			highestModseq = undefined;
		}

		this.mailbox = {
			path,
			uidValidity: folder.uidValidity,
			exists: folder.messages.length,
			highestModseq,
			noModseq: folder.noModseq
		};

		return {
			release: () => {
				this.mailbox = false;
			}
		};
	}

	async *fetch(
		range: string,
		query: { source?: boolean; labels?: boolean; threadId?: boolean },
		options: { uid: boolean; changedSince?: bigint }
	): AsyncGenerator<FetchedMessage> {
		const server = this.connected();
		const folder = this.openFolder();

		let logEntry = range;

		if (options.changedSince !== undefined) {
			logEntry = range + ' changedSince=' + String(options.changedSince);
		}

		server.fetchLog.push(logEntry);

		const [startText, endText] = range.split(':');
		const start = Number(startText);

		let maxUid = 0;

		for (const message of folder.messages) {
			if (message.uid > maxUid) {
				maxUid = message.uid;
			}
		}

		let end = Number(endText);

		if (endText === '*') {
			end = maxUid;
		}

		/** IMAP treats `a:b` as the same set as `b:a`, which is why `n:*` past the end still returns the newest. */
		const low = Math.min(start, end);
		const high = Math.max(start, end);

		let yielded = 0;

		for (const message of folder.messages) {
			if (message.uid < low || message.uid > high) {
				continue;
			}

			if (options.changedSince !== undefined && message.modseq <= options.changedSince) {
				continue;
			}

			if (server.failAfterMessages !== null && yielded >= server.failAfterMessages) {
				throw new Error('Connection dropped');
			}

			yielded = yielded + 1;

			const fetched: FetchedMessage = {
				uid: message.uid,
				source: message.source,
				threadId: message.threadId,
				labels: message.labels
			};

			if (!query.source) {
				fetched.source = Buffer.alloc(0);
			}

			yield fetched;
		}
	}

	/** Stores a raw message in a folder, like APPEND. Flags are ignored. */
	async append(path: string, content: Buffer | string): Promise<{ uid: number }> {
		const folder = folderOf(this.connected(), path);
		const uid = folder.uidNext;
		folder.uidNext = folder.uidNext + 1;
		folder.highestModseq = folder.highestModseq + 1n;

		folder.messages.push({
			uid,
			source: Buffer.from(content),
			threadId: undefined,
			labels: undefined,
			modseq: folder.highestModseq
		});

		return { uid };
	}

	/** Always the `{ all: true }, { uid: true }` search mailSync makes, so the arguments are ignored. */
	async search(): Promise<number[] | false> {
		const server = this.connected();
		const folder = this.openFolder();

		if (server.searchFails) {
			return false;
		}

		const uids: number[] = [];

		for (const message of folder.messages) {
			uids.push(message.uid);
		}

		return uids;
	}
}
