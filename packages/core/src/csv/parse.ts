/**
 * RFC 4180 CSV parsing, streaming-safe (issue #38).
 *
 * Hand-written rather than a dependency: the grammar is small (fields,
 * quotes, doubled quotes, CR/LF/CRLF records), the parser has to run both
 * in the browser (the mapping step previews rows client-side) and on
 * Workers (the import streams the upload out of R2), and a push parser
 * that accepts arbitrary chunk boundaries is the one thing papaparse's
 * string-at-a-time API does not give us without buffering the whole file.
 *
 * `CsvParser` is a push parser: feed it text in any chunking, collect the
 * records it emits, call `end()` for the final record. `parseCsv` wraps it
 * for strings, `parseCsvStream` for a `ReadableStream<Uint8Array>`.
 *
 * Behaviour beyond the RFC, all deliberate:
 *   - a leading UTF-8 BOM is dropped;
 *   - the delimiter is auto-detected from the header line (`,` `;` `\t`
 *     `|`) unless given — European exports use semicolons;
 *   - blank records (a line with no fields at all) are skipped;
 *   - a quote inside an unquoted field is kept literally (lenient, like
 *     every spreadsheet), and an unterminated quoted field at EOF is
 *     emitted as-is rather than thrown.
 */

export const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export interface CsvParserOptions {
  /** Explicit delimiter; auto-detected from the first record when omitted. */
  delimiter?: CsvDelimiter;
}

export class CsvParser {
  private delimiter: CsvDelimiter | null;
  private field = "";
  private record: string[] = [];
  private inQuotes = false;
  /** Set after a `"` inside a quoted field: the next char decides. */
  private afterQuote = false;
  /** Set after a CR so a following LF does not end a second record. */
  private afterCr = false;
  private started = false;
  private firstLine = "";
  private recordCount = 0;

  constructor(options: CsvParserOptions = {}) {
    this.delimiter = options.delimiter ?? null;
  }

  /** Feed a chunk; returns the records completed by it. */
  write(chunk: string): string[][] {
    let text = chunk;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const out: string[][] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (this.delimiter === null) {
        // Buffer until the first line break to sniff the delimiter.
        if (ch === "\n" || ch === "\r") {
          this.delimiter = detectDelimiter(this.firstLine);
          this.consume(this.firstLine, out);
          this.firstLine = "";
        } else {
          this.firstLine += ch;
          continue;
        }
      }
      this.consume(ch, out);
    }
    return out;
  }

  /** Flush the final record (a file without a trailing newline). */
  end(): string[][] {
    const out: string[][] = [];
    if (this.delimiter === null) {
      this.delimiter = detectDelimiter(this.firstLine);
      this.consume(this.firstLine, out);
      this.firstLine = "";
    }
    if (this.inQuotes || this.field !== "" || this.record.length > 0) {
      this.pushField();
      this.emit(out);
    }
    return out;
  }

  /** Records emitted so far (including the header). */
  get count(): number {
    return this.recordCount;
  }

  private consume(text: string, out: string[][]): void {
    const delimiter = this.delimiter as string;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (this.afterQuote) {
        this.afterQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
        // Anything but a delimiter/newline after the closing quote is
        // malformed; keep it (lenient) and fall through.
      }
      if (this.inQuotes) {
        if (ch === '"') this.afterQuote = true;
        else this.field += ch;
        continue;
      }
      if (this.afterCr) {
        this.afterCr = false;
        if (ch === "\n") continue;
      }
      if (ch === delimiter) {
        this.pushField();
      } else if (ch === "\n" || ch === "\r") {
        this.afterCr = ch === "\r";
        this.pushField();
        this.emit(out);
      } else if (ch === '"' && this.field === "") {
        this.inQuotes = true;
      } else {
        this.field += ch;
      }
    }
  }

  private pushField(): void {
    this.record.push(this.field);
    this.field = "";
    this.inQuotes = false;
    this.afterQuote = false;
  }

  private emit(out: string[][]): void {
    const record = this.record;
    this.record = [];
    // A blank line parses as one empty field; skip it.
    if (record.length === 1 && record[0] === "") return;
    this.recordCount += 1;
    out.push(record);
  }
}

/**
 * Pick the delimiter that splits the header line into the most fields,
 * ignoring characters inside quotes. Ties go to the earlier entry in
 * `CSV_DELIMITERS`, so a plain comma file is never mistaken for anything
 * else.
 */
export function detectDelimiter(headerLine: string): CsvDelimiter {
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of CSV_DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of headerLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** Parse a whole string. The first record is the header. */
export function parseCsv(
  text: string,
  options: CsvParserOptions = {},
): CsvTable {
  const parser = new CsvParser(options);
  const records = [...parser.write(text), ...parser.end()];
  const [headers = [], ...rows] = records;
  return { headers: headers.map(normalizeHeader), rows };
}

/**
 * Parse a byte stream record by record. Yields the header first (as
 * `{ kind: "header" }`), then one `{ kind: "row" }` per data record with
 * its 1-based row number (header excluded — the number a spreadsheet user
 * would quote, minus the header line).
 */
export async function* parseCsvStream(
  stream: ReadableStream<Uint8Array>,
  options: CsvParserOptions = {},
): AsyncGenerator<CsvStreamEvent> {
  const parser = new CsvParser(options);
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let headerSeen = false;
  let rowNumber = 0;
  const deliver = function* (records: string[][]): Generator<CsvStreamEvent> {
    for (const record of records) {
      if (!headerSeen) {
        headerSeen = true;
        yield { kind: "header", headers: record.map(normalizeHeader) };
      } else {
        rowNumber += 1;
        yield { kind: "row", row: record, rowNumber };
      }
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* deliver(parser.write(decoder.decode(value, { stream: true })));
    }
    const tail = decoder.decode();
    yield* deliver([...(tail ? parser.write(tail) : []), ...parser.end()]);
  } finally {
    reader.releaseLock();
  }
}

export type CsvStreamEvent =
  | { kind: "header"; headers: string[] }
  | { kind: "row"; row: string[]; rowNumber: number };

/** Headers are trimmed; everything else about them is preserved. */
export function normalizeHeader(header: string): string {
  return header.trim();
}
