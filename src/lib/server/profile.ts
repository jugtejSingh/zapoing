import { readFile, writeFile } from 'node:fs/promises';
import { userProfilePath } from '$lib/server/storage/paths';

export type WritingStyle = {
	tone: string;
	length: string;
	phrasesUse: string[];
	phrasesAvoid: string[];
};

export type BrandingSettings = {
	font: string;
	primaryColor: string;
	headerText: string;
	footerText: string;
};

/** Who the user is and how they write. Every drafting prompt is built on top of this. */
export type UserProfile = {
	name: string;
	role: string;
	company: string;
	companyDescription: string;
	signature: string;
	signOff: string;
	writingStyle: WritingStyle;
	timezone: string;
	workingHours: string;
	standingRules: string[];
	/** The look of the documents the AI makes. The logo is a file, see branding.ts. */
	branding: BrandingSettings;
};

export function emptyProfile(): UserProfile {
	return {
		name: '',
		role: '',
		company: '',
		companyDescription: '',
		signature: '',
		signOff: '',
		writingStyle: { tone: '', length: '', phrasesUse: [], phrasesAvoid: [] },
		timezone: '',
		workingHours: '',
		standingRules: [],
		branding: { font: '', primaryColor: '', headerText: '', footerText: '' }
	};
}

/** ponytail: one profile file, because the app has one user. Key it by user id if that changes. */
export async function readProfile(): Promise<UserProfile> {
	const file = await userProfilePath();
	let text: string;

	try {
		text = await readFile(file, 'utf8');
	} catch {
		return emptyProfile();
	}

	const stored = JSON.parse(text) as Partial<UserProfile>;
	const profile = emptyProfile();

	/** Fields added later fall back to the defaults instead of coming back undefined. */
	Object.assign(profile, stored);
	profile.writingStyle = Object.assign(emptyProfile().writingStyle, stored.writingStyle);
	profile.branding = Object.assign(emptyProfile().branding, stored.branding);

	return profile;
}

export async function saveProfile(profile: UserProfile): Promise<void> {
	const file = await userProfilePath();
	await writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
}
