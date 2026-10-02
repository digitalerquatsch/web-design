import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parseCsv, parseTable, mapRows, toCsv, TableError } from "../src/table.js";

// Minimal ZIP writer for XLSX fixtures (deflated entries; our reader ignores CRCs).
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = zlib.deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(text), 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("parseCsv handles semicolons, quotes and blank lines; parseTable strips the BOM", () => {
  const text = 'Firma;Website\n"Müller; Söhne";mueller.de\r\n\n"Sag ""Hallo""";hallo.de\n';
  assert.deepEqual(parseCsv(text), [["Firma", "Website"], ["Müller; Söhne", "mueller.de"], ['Sag "Hallo"', "hallo.de"]]);
  assert.equal(parseTable(Buffer.from("\uFEFF" + text), "a.csv")[0][0], "Firma");
});

test("parseTable decodes Windows-1252 CSV from Excel", () => {
  const buf = Buffer.from([...Buffer.from("Firma,Website\n"), ...Buffer.from("B"), 0xe4, ...Buffer.from("ckerei,baecker.de\n")]);
  assert.deepEqual(parseTable(buf, "liste.csv")[1], ["Bäckerei", "baecker.de"]);
});

test("parseTable reads the first sheet of an XLSX with shared and inline strings", () => {
  const buf = zip({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Kunden" sheetId="1" r:id="rId7"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/kunden.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><t>Firma</t></si><si><t>Website</t></si><si><r><t>Zahn</t></r><r><t>arzt &amp; Co</t></r></si></sst>',
    "xl/worksheets/kunden.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>zahnarzt.de</t></is></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(parseTable(buf, "kunden.xlsx"), [["Firma", "Website"], ["Zahnarzt & Co", "zahnarzt.de", "42"]]);
});

test("mapRows finds columns by header, normalizes and dedupes URLs", () => {
  const { rows, skipped, columns } = mapRows([
    ["Unternehmen", "E-Mail", "Webseite", "Ansprechpartner"],
    ["Salon A", "a@a.de", "www.salon-a.de", "Eva"],
    ["Salon A Kopie", "", "https://salon-a.de/", ""],
    ["Kaputt", "", "nicht eine url", ""],
    ["", "", "", ""],
    ["Praxis B", "b@b.de", "http://praxis-b.de/kontakt", ""],
  ]);
  assert.equal(columns.url, "Webseite");
  assert.deepEqual(rows.map((r) => [r.company, r.url, r.email, r.contact]), [
    ["Salon A", "https://www.salon-a.de/", "a@a.de", "Eva"],
    ["Praxis B", "http://praxis-b.de/kontakt", "b@b.de", ""],
  ]);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /Doppelt/);
  assert.equal(skipped[1].value, "nicht eine url");
});

test("mapRows without a header finds the URL column itself", () => {
  const { rows } = mapRows([["Bäcker Kuhn", "kuhn-backt.de"], ["Optik Sicht", "optik-sicht.de"]]);
  assert.deepEqual(rows.map((r) => r.url), ["https://kuhn-backt.de/", "https://optik-sicht.de/"]);
});

test("mapRows explains what is wrong", () => {
  assert.throws(() => mapRows([["Name", "Ort"], ["A", "Köln"]]), /Website/);
  assert.throws(() => mapRows([["Website"], ...Array.from({ length: 201 }, (_, i) => [`firma${i}.de`])]), /höchstens 200/);
  assert.throws(() => parseTable(Buffer.from("x"), "alt.xls"), TableError);
});

test("toCsv writes Excel-friendly CSV and neutralizes formulas", () => {
  const out = toCsv([["Firma", "Hinweis"], ["=HYPERLINK(\"x\")", 'Sagt "Hi"; ok']]);
  assert.ok(out.startsWith("﻿Firma;Hinweis\r\n"));
  assert.match(out, /^"'=HYPERLINK/m);
  assert.match(out, /"Sagt ""Hi""; ok"/);
});
