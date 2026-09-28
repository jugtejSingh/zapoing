import addressparser from 'nodemailer/lib/addressparser';
import type { EmailDirection } from '$lib/types';

/** The stored fields a reply is addressed from. */
export type AnswerableEmail = {
	direction: EmailDirection;
	from: string;
	to: string;
	cc: string;
	replyTo: string | null;
};

export type ReplyRecipients = {
	to: string;
	cc: string;
};

/** Bare addresses for the SMTP envelope; display names belong only in the headers. */
export function bareAddresses(text: string): string[] {
	const addresses: string[] = [];

	for (const entry of addressparser(text, { flatten: true })) {
		if (entry.address) {
			addresses.push(entry.address);
		}
	}

	return addresses;
}

/** Re-joins the addresses in `text`, leaving out any in `excluded` (lowercased) and duplicates. */
function joinWithout(text: string, excluded: Set<string>): string {
	const parts: string[] = [];

	for (const entry of addressparser(text, { flatten: true })) {
		if (!entry.address) {
			continue;
		}

		const key = entry.address.toLowerCase();

		if (excluded.has(key)) {
			continue;
		}

		excluded.add(key);

		if (entry.name) {
			parts.push('"' + entry.name.replace(/"/g, '') + '" <' + entry.address + '>');
		} else {
			parts.push(entry.address);
		}
	}

	return parts.join(', ');
}

/**
 * Who a reply goes to. A received message is answered to its Reply-To (else its
 * From); a sent one goes to its To again, as a follow-up. Cc is everyone else on
 * the original, minus the user's own address.
 */
export function replyRecipients(message: AnswerableEmail, ownAddress: string): ReplyRecipients {
	let to = message.to;
	let others = message.cc;

	if (message.direction === 'in') {
		if (message.replyTo && message.replyTo.trim().length > 0) {
			to = message.replyTo;
		} else {
			to = message.from;
		}

		others = message.to + ', ' + message.cc;
	}

	const excluded = new Set<string>();
	excluded.add(ownAddress.toLowerCase());

	for (const address of bareAddresses(to)) {
		excluded.add(address.toLowerCase());
	}

	return { to, cc: joinWithout(others, excluded) };
}
