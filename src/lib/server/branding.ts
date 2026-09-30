import { readFile, rm, writeFile } from 'node:fs/promises';
import { readProfile } from '$lib/server/profile';
import { brandingLogoPath } from '$lib/server/storage/paths';

export type Logo = {
	data: Buffer;
	type: 'png' | 'jpg';
	width: number;
	height: number;
};

/** What the renderers apply to a generated document. Every part is optional: empty means off. */
export type Branding = {
	font: string;
	primaryColor: string;
	headerText: string;
	footerText: string;
	logo: Logo | null;
};

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** The font name ends up in CSS and HTML, so only plain name characters get through. */
const FONT_PATTERN = /^[A-Za-z0-9 \-]{1,60}$/;

export function cleanColor(value: string): string {
	if (COLOR_PATTERN.test(value)) {
		return value;
	}

	return '';
}

export function cleanFont(value: string): string {
	if (FONT_PATTERN.test(value)) {
		return value;
	}

	return '';
}

/** Width and height from a PNG header, or null when it is not a PNG. */
function pngSize(data: Buffer): { width: number; height: number } | null {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	if (data.length < 24 || !data.subarray(0, 8).equals(signature)) {
		return null;
	}

	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Width and height from the first JPEG frame header, or null when it is not a JPEG. */
function jpegSize(data: Buffer): { width: number; height: number } | null {
	if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
		return null;
	}

	let offset = 2;

	while (offset + 9 < data.length) {
		if (data[offset] !== 0xff) {
			return null;
		}

		const marker = data[offset + 1];
		const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

		if (isFrame) {
			return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
		}

		offset += 2 + data.readUInt16BE(offset + 2);
	}

	return null;
}

/** Reads a PNG or JPEG's type and size; null for anything else or an empty image. */
export function readLogo(data: Buffer): Logo | null {
	if (data.length === 0 || data.length > MAX_LOGO_BYTES) {
		return null;
	}

	const png = pngSize(data);

	if (png !== null && png.width > 0 && png.height > 0) {
		return { data, type: 'png', ...png };
	}

	const jpg = jpegSize(data);

	if (jpg !== null && jpg.width > 0 && jpg.height > 0) {
		return { data, type: 'jpg', ...jpg };
	}

	return null;
}

/** Saves the uploaded logo over the old one. False when the file is not a usable PNG or JPEG. */
export async function saveLogo(data: Buffer): Promise<boolean> {
	const logo = readLogo(data);

	if (logo === null) {
		return false;
	}

	await removeLogo();
	await writeFile(await brandingLogoPath(logo.type), data);

	return true;
}

export async function removeLogo(): Promise<void> {
	await rm(await brandingLogoPath('png'), { force: true });
	await rm(await brandingLogoPath('jpg'), { force: true });
}

async function findLogo(): Promise<Logo | null> {
	for (const type of ['png', 'jpg'] as const) {
		try {
			return readLogo(await readFile(await brandingLogoPath(type)));
		} catch {
			continue;
		}
	}

	return null;
}

export async function hasLogo(): Promise<boolean> {
	return (await findLogo()) !== null;
}

/** The user's font, colour, header, footer and logo, whichever of them are set. */
export async function readBranding(): Promise<Branding> {
	const profile = await readProfile();

	return {
		font: cleanFont(profile.branding.font),
		primaryColor: cleanColor(profile.branding.primaryColor),
		headerText: profile.branding.headerText,
		footerText: profile.branding.footerText,
		logo: await findLogo()
	};
}

export function hasHeader(branding: Branding): boolean {
	return branding.logo !== null || branding.headerText.length > 0;
}

export function hasFooter(branding: Branding): boolean {
	return branding.footerText.length > 0;
}
