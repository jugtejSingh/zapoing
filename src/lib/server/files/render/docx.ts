import {
	AlignmentType,
	Document,
	Footer,
	Header,
	HeadingLevel,
	ImageRun,
	type IPropertiesOptions,
	type ISectionOptions,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType
} from 'docx';
import { Lexer, type Token, type Tokens } from 'marked';
import { hasFooter, hasHeader, type Branding } from '$lib/server/branding';

type RunStyle = {
	bold: boolean;
	italics: boolean;
	strike: boolean;
	code: boolean;
};

const PLAIN: RunStyle = { bold: false, italics: false, strike: false, code: false };

const HEADINGS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
	HeadingLevel.HEADING_5,
	HeadingLevel.HEADING_6
];

function textRun(text: string, style: RunStyle): TextRun {
	let font: string | undefined = undefined;

	if (style.code) {
		font = 'Consolas';
	}

	return new TextRun({
		text,
		bold: style.bold,
		italics: style.italics,
		strike: style.strike,
		font
	});
}

/** Every token but a few (br, space, hr) may carry text and children; marked's union hides that. */
function generic(token: Token): Tokens.Generic {
	return token as Tokens.Generic;
}

/** Inline tokens → runs. Bold, italic, strikethrough and code; links keep only their text. */
function inlineRuns(tokens: Token[], style: RunStyle): TextRun[] {
	const runs: TextRun[] = [];

	for (const token of tokens) {
		if (token.type === 'strong') {
			for (const run of inlineRuns(token.tokens ?? [], { ...style, bold: true })) {
				runs.push(run);
			}
		} else if (token.type === 'em') {
			for (const run of inlineRuns(token.tokens ?? [], { ...style, italics: true })) {
				runs.push(run);
			}
		} else if (token.type === 'del') {
			for (const run of inlineRuns(token.tokens ?? [], { ...style, strike: true })) {
				runs.push(run);
			}
		} else if (token.type === 'codespan') {
			runs.push(textRun(token.text, { ...style, code: true }));
		} else if (token.type === 'br') {
			runs.push(new TextRun({ text: '', break: 1 }));
		} else {
			const children = generic(token).tokens;
			const text = generic(token).text;

			if (children && children.length > 0) {
				for (const run of inlineRuns(children, style)) {
					runs.push(run);
				}
			} else if (typeof text === 'string') {
				runs.push(textRun(text, style));
			}
		}
	}

	return runs;
}

function tableBlock(token: Tokens.Table): Table {
	const rows: TableRow[] = [];
	const headerCells: TableCell[] = [];

	for (const cell of token.header) {
		headerCells.push(
			new TableCell({
				children: [new Paragraph({ children: inlineRuns(cell.tokens, { ...PLAIN, bold: true }) })]
			})
		);
	}

	rows.push(new TableRow({ children: headerCells, tableHeader: true }));

	for (const row of token.rows) {
		const cells: TableCell[] = [];

		for (const cell of row) {
			cells.push(
				new TableCell({ children: [new Paragraph({ children: inlineRuns(cell.tokens, PLAIN) })] })
			);
		}

		rows.push(new TableRow({ children: cells }));
	}

	return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/**
 * List items → paragraphs. ponytail: numbered lists get a typed "1." prefix
 * rather than Word numbering, which needs a numbering definition per list.
 */
function listBlock(token: Tokens.List, level: number): Paragraph[] {
	const paragraphs: Paragraph[] = [];
	let number = 1;

	if (typeof token.start === 'number') {
		number = token.start;
	}

	for (const item of token.items) {
		const runs: TextRun[] = [];
		const nested: Paragraph[] = [];

		if (token.ordered) {
			runs.push(textRun(String(number) + '. ', PLAIN));
			number = number + 1;
		}

		for (const child of item.tokens) {
			if (child.type === 'list') {
				for (const paragraph of listBlock(child as Tokens.List, level + 1)) {
					nested.push(paragraph);
				}
			} else {
				for (const run of inlineRuns(generic(child).tokens ?? [], PLAIN)) {
					runs.push(run);
				}
			}
		}

		if (token.ordered) {
			paragraphs.push(new Paragraph({ children: runs, indent: { left: 360 * (level + 1) } }));
		} else {
			paragraphs.push(new Paragraph({ children: runs, bullet: { level } }));
		}

		for (const paragraph of nested) {
			paragraphs.push(paragraph);
		}
	}

	return paragraphs;
}

function blocks(tokens: Token[]): (Paragraph | Table)[] {
	const children: (Paragraph | Table)[] = [];

	for (const token of tokens) {
		if (token.type === 'heading') {
			const level = Math.min(Math.max(token.depth, 1), 6) - 1;
			children.push(
				new Paragraph({ heading: HEADINGS[level], children: inlineRuns(token.tokens ?? [], PLAIN) })
			);
		} else if (token.type === 'paragraph') {
			children.push(new Paragraph({ children: inlineRuns(token.tokens ?? [], PLAIN) }));
		} else if (token.type === 'list') {
			for (const paragraph of listBlock(token as Tokens.List, 0)) {
				children.push(paragraph);
			}
		} else if (token.type === 'table') {
			children.push(tableBlock(token as Tokens.Table));
		} else if (token.type === 'blockquote') {
			for (const child of blocks(token.tokens ?? [])) {
				children.push(child);
			}
		} else if (token.type === 'code' || token.type === 'html') {
			children.push(new Paragraph({ children: [textRun(token.text, { ...PLAIN, code: true })] }));
		} else if (token.type === 'hr') {
			children.push(new Paragraph({ children: [] }));
		}
	}

	return children;
}

const LOGO_HEIGHT_PX = 40;

function headerParagraph(branding: Branding): Paragraph {
	const children: (ImageRun | TextRun)[] = [];

	if (branding.logo !== null) {
		const ratio = branding.logo.width / branding.logo.height;

		children.push(
			new ImageRun({
				type: branding.logo.type,
				data: branding.logo.data,
				transformation: { width: Math.round(LOGO_HEIGHT_PX * ratio), height: LOGO_HEIGHT_PX }
			})
		);
	}

	if (branding.headerText.length > 0) {
		if (branding.logo !== null) {
			children.push(new TextRun({ text: '   ' }));
		}

		children.push(new TextRun({ text: branding.headerText }));
	}

	return new Paragraph({ children });
}

function footerParagraph(branding: Branding): Paragraph {
	return new Paragraph({
		alignment: AlignmentType.CENTER,
		children: [new TextRun({ text: branding.footerText, size: 18 })]
	});
}

/** The user's font and heading colour as document defaults. Empty settings leave Word's defaults. */
function brandingStyles(branding: Branding): IPropertiesOptions['styles'] {
	let defaults: NonNullable<IPropertiesOptions['styles']>['default'] = {};

	if (branding.font.length > 0) {
		defaults = { ...defaults, document: { run: { font: branding.font } } };
	}

	if (branding.primaryColor.length > 0) {
		const run = { color: branding.primaryColor.slice(1) };
		defaults = {
			...defaults,
			heading1: { run },
			heading2: { run },
			heading3: { run },
			heading4: { run },
			heading5: { run },
			heading6: { run }
		};
	}

	return { default: defaults };
}

/**
 * Markdown → DOCX. Covers headings, paragraphs, lists, tables and bold/italic, nothing more.
 * With branding: the user's font and colour, the logo and header text on top of each page,
 * the footer text at the bottom.
 */
export async function renderDocx(source: string, branding: Branding | null = null): Promise<Buffer> {
	const children = blocks(new Lexer({ gfm: true }).lex(source));
	let styles: IPropertiesOptions['styles'] = undefined;
	let headers: ISectionOptions['headers'] = undefined;
	let footers: ISectionOptions['footers'] = undefined;

	if (branding !== null) {
		styles = brandingStyles(branding);

		if (hasHeader(branding)) {
			headers = { default: new Header({ children: [headerParagraph(branding)] }) };
		}

		if (hasFooter(branding)) {
			footers = { default: new Footer({ children: [footerParagraph(branding)] }) };
		}
	}

	const document = new Document({ styles, sections: [{ headers, footers, children }] });

	return Packer.toBuffer(document);
}
