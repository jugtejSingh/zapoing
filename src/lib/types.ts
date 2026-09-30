export type EmailAttachment = {
	filename: string;
	contentType: string;
	size: number;
};

/** Gmail's tab categories. Null means the primary inbox. */
/** 'in' came from INBOX, 'out' from the Sent folder. */
export type EmailDirection = 'in' | 'out';

/** One row in the list pane: the newest message of a thread, plus its size. */
export type ThreadSummary = {
	/** Row id of the message the row links to, i.e. the newest one in the thread. */
	id: string;
	threadId: string;
	accountId: string;
	/** The account's label, or its username when it has none. */
	accountLabel: string;
	from: string;
	subject: string;
	date: Date | null;
	snippet: string;
	attachmentCount: number;
	messageCount: number;
	/** Pending drafts on the thread's unanswered emails. */
	draftCount: number;
};

/** A page of the combined inbox, plus whether another page follows. */
export type ThreadPage = {
	threads: ThreadSummary[];
	hasMore: boolean;
};

export type Email = {
	uid: number;
	threadId: string;
	from: string;
	to: string;
	/** Display text, empty when there is none. */
	cc: string;
	replyTo: string | null;
	messageId: string | null;
	references: string[];
	subject: string;
	date: Date | null;
	text: string;
	html: string | null;
	attachments: EmailAttachment[];
};

/** An `Email` as read back from the cache, which also has a stable row id. */
export type CachedEmail = Email & {
	id: string;
	accountId: string;
	mailbox: string;
	direction: EmailDirection;
};

/** Background sync progress for one account, as the sidebar shows it. */
export type SyncStatus = {
	accountId: string;
	syncing: boolean;
	/** Messages stored so far in the folder being synced. */
	done: number;
	/** Messages the server says that folder holds. */
	total: number;
	error: string | null;
};

/** One email on a person's page. */
export type PersonEmail = {
	id: string;
	from: string;
	subject: string;
	date: Date | null;
	snippet: string;
	direction: EmailDirection;
	attachments: EmailAttachment[];
};

/** A page of a contact's emails, plus whether another page follows. */
export type PersonEmailPage = {
	emails: PersonEmail[];
	hasMore: boolean;
};

/** A file the document agent made for a draft: sent with the reply unless it failed or was removed. */
export type DraftFile = {
	id: string;
	filename: string;
	change: string;
	changeNote: string;
	error: string | null;
	isNewDocument: boolean;
	/** [[fields]] still in the file; the reply cannot be sent until they are filled. */
	placeholders: string[];
	/** A Word file that goes out converted to PDF. */
	sendAsPdf: boolean;
};

/** One message in the chat between the user and the planner. */
export type DraftChatMessage = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
};

/** The drafts waiting on a thread's unanswered emails, for the thread page. */
export type ThreadDrafts = {
	/** The newest pending draft; it prefills the reply box. */
	active: {
		id: string;
		body: string;
		messages: DraftChatMessage[];
		files: DraftFile[];
		/** Where the resources disagreed; the newest was used. */
		conflicts: string[];
	} | null;
	/** Why the latest email was skipped, when nothing is pending. */
	skippedReason: string | null;
	pendingCount: number;
	/** The newest unanswered email, which "Draft anyway" and "Merge" act on. */
	latestWaitingId: string | null;
	/** Drafts are only written for tracked people. */
	canDraft: boolean;
};

/** A reference file on the resources page. */
export type ResourceSummary = {
	id: string;
	name: string;
	filename: string;
	updatedAt: Date;
	/** What the AI wrote about the file once it read it. */
	description: string;
	/** Whether the AI has read the file yet. */
	indexStatus: 'pending' | 'ready' | 'failed';
	indexError: string | null;
};

/** A tracked person's document and its stored versions, newest first. */
export type PersonDocument = {
	id: string;
	name: string;
	versions: {
		id: string;
		version: number;
		filename: string;
		sender: string;
		receivedAt: Date | null;
		size: number;
		/** False for files outside the allowlist; those are never sent to the model. */
		readable: boolean;
		emailId: string | null;
	}[];
};

/** A template on the settings page. `found` is 0 for a field the model named but could not place. */
export type TemplateSummary = {
	id: string;
	name: string;
	description: string;
	filename: string;
	format: 'docx' | 'xlsx' | 'pdf';
	status: 'processing' | 'ready' | 'failed';
	error: string | null;
	fields: { name: string; description: string; found: number }[];
};
