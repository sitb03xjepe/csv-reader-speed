// fast-csv: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the same
// input {text, header}: {columns, rows, errors}. The semantics below are copied
// from the reference (kit baselines/csv-reader/vendor/csv-reader/index.js) and
// re-implemented with indexOf-driven scanning instead of one character at a time:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, each CRLF or lone CR inside it read as LF; what follows
//     its closing quote, up to the next comma or line break, is appended as it
//     stands (quote_junk, when the field ends); a quote that never closes is a
//     literal character, and the text after it is read again as unquoted
//     (unterminated_quote); a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row, with fields: its count) or
//     cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based line
//     its record starts on, counting every LF, CRLF and lone CR inside quotes,
//     and row its record's index in rows (null for the header).
//
// Speed comes from three things: (1) a whole-record fast path for the common
// record (no quote, no stray CR) that splits one line on commas with indexOf;
// (2) unquoted and quoted fields scanned with indexOf jumps instead of a
// character loop; (3) every CR position precomputed once per case, so a stray-CR
// check is O(1) amortised instead of an unbounded scan. No state is kept from
// one run() call to the next; the module is pure.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  // Every '\r' in the text, ascending: one indexOf pass, so no later scan ever
  // has to run to the end of the text looking for a CR that is not there.
  const crs = [];
  {
    let i = text.indexOf('\r');
    while (i !== -1) {
      crs.push(i);
      i = text.indexOf('\r', i + 1);
    }
  }
  // crIdx: the first CR at or after the current scan position. pos only moves
  // forward, except the unterminated-quote reset, which re-seeks with resetCr.
  let crIdx = 0;
  const nextCr = (from) => {
    while (crIdx < crs.length && crs[crIdx] < from) crIdx++;
    return crIdx < crs.length ? crs[crIdx] : -1;
  };
  const resetCr = (from) => {
    let lo = 0;
    let hi = crs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crs[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    crIdx = lo;
  };

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  const error = (code) => {
    errors.push({ code, line: recordLine, row: recordRow });
  };

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). `nl` is the next LF at or after pos
  // (or -1), kept by the caller so this scan is not repeated per field. Returns
  // the field, how it ended, and `added`, the characters kept (not counting `value`).
  function readUnquoted(value, nl) {
    const startLen = value.length;
    let p = pos;
    let v = value;
    for (;;) {
      const comma = text.indexOf(',', p);
      let end = n;
      let kind = END;
      if (comma !== -1 && comma < end) {
        end = comma;
        kind = COMMA;
      }
      if (nl !== -1 && nl < end) {
        end = nl;
        kind = LINE_BREAK;
      }
      const cr = nextCr(p);
      if (cr !== -1 && cr < end) {
        if (text.charCodeAt(cr + 1) === 10) {
          // CRLF: the record ends here.
          v += text.slice(p, cr);
          pos = cr + 2;
          line++;
          return { value: v, ended: LINE_BREAK, added: v.length - startLen };
        }
        // A stray CR: dropped, and the field goes on.
        v += text.slice(p, cr);
        error('stray_cr');
        p = cr + 1;
        continue;
      }
      v += text.slice(p, end);
      if (kind === COMMA) {
        pos = end + 1;
        return { value: v, ended: COMMA, added: v.length - startLen };
      }
      if (kind === LINE_BREAK) {
        pos = end + 1;
        line++;
        return { value: v, ended: LINE_BREAK, added: v.length - startLen };
      }
      pos = n;
      return { value: v, ended: END, added: v.length - startLen };
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let v = '';
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it
        // is read again as unquoted. The line count the scan built is discarded.
        pos = open + 1;
        line = openLine;
        resetCr(open + 1);
        error('unterminated_quote');
        return readUnquoted('"', text.indexOf('\n', pos));
      }
      // The segment [pos, q): copy it, turning each CRLF or lone CR into LF.
      if (q > pos) {
        const cr = nextCr(pos);
        const nl = text.indexOf('\n', pos);
        if ((cr === -1 || cr >= q) && (nl === -1 || nl >= q)) {
          v += text.slice(pos, q);
        } else {
          // The segment holds line breaks: walk it, CR/CRLF -> LF, LF kept.
          let i = pos;
          for (;;) {
            const c = nextCr(i);
            const l = text.indexOf('\n', i);
            const cIn = c !== -1 && c < q ? c : -1;
            const lIn = l !== -1 && l < q ? l : -1;
            if (cIn === -1 && lIn === -1) {
              v += text.slice(i, q);
              break;
            }
            if (lIn !== -1 && (cIn === -1 || lIn < cIn)) {
              v += text.slice(i, lIn + 1);
              line++;
              i = lIn + 1;
            } else {
              v += text.slice(i, cIn);
              v += '\n';
              line++;
              i = cIn + (text.charCodeAt(cIn + 1) === 10 ? 2 : 1);
            }
          }
        }
      }
      pos = q;
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        v += '"';
        pos = q + 2;
        continue;
      }
      // Closed at q.
      pos = q + 1;
      if (pos >= n) return { value: v, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value: v, ended: COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value: v, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value: v, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break.
      const junk = readUnquoted(v, text.indexOf('\n', pos));
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;

    // Fast path: the record up to its next LF holds no quote and no CR other
    // than the CRLF that ends it, so it splits on commas as it stands.
    const nl = text.indexOf('\n', pos);
    const recEnd = nl === -1 ? n : nl;
    const q0 = text.indexOf('"', pos);
    if (q0 === -1 || q0 >= recEnd) {
      const cr0 = nextCr(pos);
      const crlfEnd = nl !== -1 && cr0 === recEnd - 1;
      if (cr0 === -1 || cr0 >= recEnd || crlfEnd) {
        const stop = crlfEnd ? recEnd - 1 : recEnd;
        fields = [];
        let p = pos;
        for (;;) {
          const comma = text.indexOf(',', p);
          if (comma === -1 || comma >= stop) {
            fields.push(text.slice(p, stop));
            break;
          }
          fields.push(text.slice(p, comma));
          p = comma + 1;
        }
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
      }
    }

    if (fields === undefined) {
      // A quote or a stray CR is in the way: read the record field by field.
      // recNl is the record's next LF; an unquoted field never crosses it, so it
      // stays valid across unquoted fields and is refreshed after each quoted one
      // (a quoted field may span lines).
      fields = [];
      let field;
      let recNl = nl;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) {
          field = readQuoted();
          recNl = text.indexOf('\n', pos);
        } else {
          field = readUnquoted('', recNl);
        }
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
