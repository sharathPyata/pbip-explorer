// A small .xlsx writer with no dependencies: an Excel workbook is a zip of XML parts, so this
// writes the parts (one sheet each, text cells, a bold filtered header row that stays in view,
// column widths, wrapped multi-line cells) and zips them, deflated with Node's own zlib.
//   writeXlsx([{ name, columns: [{ header, width, wrap }], rows: [[…], …] }]) → Buffer
'use strict';
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* Zip `files` ([{ name, data: Buffer }]); deflated unless `store` (FHSQLMonitor's workbook: 4.3 MB stored). */
function zip(files, { when = new Date(), store = false } = {}) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data), size = f.data.length;
    const body = store ? f.data : zlib.deflateRawSync(f.data, { level: 6 });
    const method = store ? 0 : 8, packed = body.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + packed;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

const MAX_CELL = 32767;   // Excel's limit on a cell's text
function xmlText(v) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL - 1) + '…';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function colLetter(n) {   // 0 → A, 26 → AA
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
// Styles: 0 default · 1 header (bold, shaded) · 2 top-aligned · 3 top-aligned, wrapped
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sheet) {
  const cols = sheet.columns;
  const cell = (ref, v, style) => {
    const s = String(v == null ? '' : v);
    const space = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t${space}>${xmlText(s)}</t></is></c>`;
  };
  const rows = [`<row r="1">${cols.map((c, i) => cell(`${colLetter(i)}1`, c.header, 1)).join('')}</row>`];
  sheet.rows.forEach((r, ri) => {
    const n = ri + 2;
    rows.push(`<row r="${n}">${cols.map((c, i) => (r[i] == null || r[i] === '' ? '' : cell(`${colLetter(i)}${n}`, r[i], c.wrap ? 3 : 2))).join('')}</row>`);
  });
  const last = `${colLetter(cols.length - 1)}${Math.max(1, sheet.rows.length + 1)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A1:${last}"/>
</worksheet>`;
}

/* Sheet names: at most 31 characters, none of : \ / ? * [ ], unique. */
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map(s => {
    const base = String(s.name || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 28)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function writeXlsx(sheets) {
  const names = sheetNames(sheets);
  const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const parts = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${escAttr(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escAttr(names[i].replace(/'/g, "''"))}'!$A$1:$${colLetter(s.columns.length - 1)}$${Math.max(1, s.rows.length + 1)}</definedName>`).join('')}</definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(parts.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })));
}

module.exports = { writeXlsx, zip, crc32, colLetter };
