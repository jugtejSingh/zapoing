import ExcelJS from 'exceljs';

export type SheetCell = string | number | boolean | null;

export type Sheet = {
	name: string;
	rows: SheetCell[][];
};

/** Excel's rules: at most 31 characters, none of []:*?/\ and unique in the workbook. */
function sheetName(wanted: string, used: Set<string>): string {
	let base = wanted
		.replace(/[[\]:*?/\\]/g, ' ')
		.trim()
		.slice(0, 31);

	if (base.length === 0) {
		base = 'Sheet';
	}

	let name = base;
	let counter = 2;

	while (used.has(name.toLowerCase())) {
		const suffix = ' ' + String(counter);
		name = base.slice(0, 31 - suffix.length) + suffix;
		counter = counter + 1;
	}

	used.add(name.toLowerCase());

	return name;
}

/** JSON sheets → XLSX. Values only: no formulas, formatting or merged cells. */
export async function renderXlsx(sheets: Sheet[]): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const used = new Set<string>();

	for (const sheet of sheets) {
		const worksheet = workbook.addWorksheet(sheetName(sheet.name, used));

		for (const row of sheet.rows) {
			worksheet.addRow(row);
		}
	}

	if (sheets.length === 0) {
		workbook.addWorksheet('Sheet1');
	}

	const buffer = await workbook.xlsx.writeBuffer();

	return Buffer.from(buffer);
}
