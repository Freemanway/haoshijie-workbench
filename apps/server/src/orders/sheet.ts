import JSZip from 'jszip';

/**
 * 读订单表：.xlsx（只读第一个工作表）和 .csv（UTF-8 或 GBK）。
 * 团购工具导出的表结构简单，不需要完整的 Excel 库；返回的单元格都是字符串，
 * 数字型日期保留 Excel 序列号，由字段解析时再换算。
 */
export async function readSheet(fileName: string, buf: Buffer): Promise<string[][]> {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return parseCsv(decodeText(buf));
  if (ext === 'xls') throw new SheetError('暂不支持老版 .xls，请在 Excel 里另存为 .xlsx 或 .csv 再导入');
  if (ext !== 'xlsx') throw new SheetError('只支持 .xlsx 或 .csv 文件');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new SheetError('文件打不开，请确认是 .xlsx 格式');
  }
  const sheetPath = await firstSheetPath(zip);
  const sheet = await zip.file(sheetPath)?.async('string');
  if (!sheet) throw new SheetError('表格里没有工作表');
  const shared = await sharedStrings(zip);
  return parseSheetXml(sheet, shared);
}

export class SheetError extends Error {}

function decodeText(buf: Buffer) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel 在中文 Windows 上另存的 CSV 是 GBK
    return new TextDecoder('gbk').decode(buf);
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some(Boolean));
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

async function firstSheetPath(zip: JSZip) {
  const wb = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  const rid = wb && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const target = rid && rels && new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const alt = rid && rels && new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
  const t = target || alt;
  if (!t) return 'xl/worksheets/sheet1.xml';
  return t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
}

async function sharedStrings(zip: JSZip) {
  const xml = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
};

function parseSheetXml(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = textOf(body);
      else if (v != null) val = unescapeXml(v);
      while (row.length < idx) row.push('');
      row[idx] = val.trim();
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}
