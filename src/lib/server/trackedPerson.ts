import { and, asc, eq } from 'drizzle-orm';
import { writeFile } from 'node:fs/promises';
import { db } from '$lib/server/db';
import { contact } from '$lib/server/db/schema';
import { enqueueJob } from '$lib/server/jobs/worker';
import { contactProfilePath } from '$lib/server/storage/paths';

export type TrackedPerson = {
	id: string;
	email: string;
	createdAt: Date;
};

type ContactRow = typeof contact.$inferSelect;

function primaryEmail(row: ContactRow): string {
	if (row.emails.length > 0) {
		return row.emails[0];
	}

	return '';
}

/** Mirrors the contact row to data/contacts/<id>/profile.json so the agents can read it off disk. */
async function writeContactProfile(row: ContactRow): Promise<void> {
	const file = await contactProfilePath(row.id);
	const profile = {
		id: row.id,
		name: row.name,
		company: row.company,
		emails: row.emails,
		tracked: row.tracked
	};

	await writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
}

export async function listTrackedPeople(userId: string): Promise<TrackedPerson[]> {
	const rows = await db
		.select()
		.from(contact)
		.where(and(eq(contact.userId, userId), eq(contact.tracked, true)))
		.orderBy(asc(contact.createdAt));

	const people: TrackedPerson[] = [];

	for (const row of rows) {
		people.push({ id: row.id, email: primaryEmail(row), createdAt: row.createdAt });
	}

	return people;
}

/** ponytail: scans the user's contacts in JS for the address. Fine for hundreds; add a contact_email table if it grows. */
export async function findContactByEmail(userId: string, address: string): Promise<ContactRow | null> {
	const wanted = address.trim().toLowerCase();
	const rows = await db.select().from(contact).where(eq(contact.userId, userId));

	for (const row of rows) {
		if (row.emails.includes(wanted)) {
			return row;
		}
	}

	return null;
}

export async function getContact(userId: string, id: string): Promise<ContactRow | null> {
	const rows = await db
		.select()
		.from(contact)
		.where(and(eq(contact.id, id), eq(contact.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

/** Stores the files of mail already exchanged with the person; new mail is ingested as it syncs. */
async function queueAttachmentBackfill(saved: ContactRow): Promise<void> {
	await enqueueJob('attachments.backfill', { userId: saved.userId, contactId: saved.id });
}

export async function addTrackedPerson(userId: string, email: string): Promise<void> {
	const address = email.trim().toLowerCase();
	const existing = await findContactByEmail(userId, address);
	let saved: ContactRow;

	if (existing) {
		const updated = await db
			.update(contact)
			.set({ tracked: true })
			.where(eq(contact.id, existing.id))
			.returning();
		saved = updated[0];
	} else {
		const inserted = await db
			.insert(contact)
			.values({ userId, emails: [address], tracked: true })
			.returning();
		saved = inserted[0];
	}

	await writeContactProfile(saved);
	await queueAttachmentBackfill(saved);
}

export async function setTracked(userId: string, id: string, tracked: boolean): Promise<void> {
	const updated = await db
		.update(contact)
		.set({ tracked })
		.where(and(eq(contact.id, id), eq(contact.userId, userId)))
		.returning();

	if (updated.length > 0) {
		await writeContactProfile(updated[0]);

		if (tracked) {
			await queueAttachmentBackfill(updated[0]);
		}
	}
}

export async function removeTrackedPerson(userId: string, id: string): Promise<void> {
	await setTracked(userId, id, false);
}

export async function isTrackedPerson(userId: string, email: string): Promise<boolean> {
	const found = await findContactByEmail(userId, email);

	if (found && found.tracked) {
		return true;
	}

	return false;
}
