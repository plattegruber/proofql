// Browser side of the Google Takeout import: open the archive(s) the user
// picked, keep only the Business Profile review pages and listing names,
// and group them into locations (@proofql/core `groupTakeoutFiles`).
//
// Takeout archives are large — up to the 2–50 GB part size the user chose,
// mostly photos — so nothing is read whole: the zip is streamed through
// fflate's `Unzip` chunk by chunk, and only the few entries whose path
// matches are inflated. Photos never leave the machine, and never reach
// the Worker or R2. fflate is imported lazily, so it loads only on the
// Takeout page. Loose JSON files (a `reviews.json` picked on its own) are
// read as they are; they may be a subset, so they never count as a
// complete export.
import {
  groupTakeoutFiles,
  isTakeoutEntryOfInterest,
  MAPS_REVIEWS_MESSAGE,
  type TakeoutExport,
  type TakeoutFile,
  TakeoutShapeError,
} from "@proofql/core";

export interface TakeoutReadResult extends TakeoutExport {
  /** Every input was a zip archive (so each location's pages are all there, if every part was chosen). */
  fromArchives: boolean;
  archives: number;
  looseFiles: number;
}

export class TakeoutReadError extends Error {
  override readonly name = "TakeoutReadError";
}

export interface ReadProgress {
  file: string;
  bytesRead: number;
  totalBytes: number;
}

/** Read every chosen file; throws `TakeoutReadError` with a message for the user. */
export async function readTakeoutSelection(
  files: readonly File[],
  onProgress?: (progress: ReadProgress) => void,
): Promise<TakeoutReadResult> {
  if (files.length === 0) throw new TakeoutReadError("Choose a file first.");
  const collected: TakeoutFile[] = [];
  let archives = 0;
  let looseFiles = 0;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".zip")) {
      archives += 1;
      collected.push(...(await readZip(file, onProgress)));
    } else if (name.endsWith(".json")) {
      looseFiles += 1;
      collected.push({ path: file.name, text: await file.text() });
    } else if (name.endsWith(".tgz") || name.endsWith(".tar.gz")) {
      throw new TakeoutReadError(
        `${file.name} is a .tgz archive. Export again with "File type: .zip", or unpack it and choose the reviews*.json files.`,
      );
    } else {
      throw new TakeoutReadError(`${file.name} is not a .zip or a .json file.`);
    }
  }

  let grouped: TakeoutExport;
  try {
    grouped = groupTakeoutFiles(collected);
  } catch (error) {
    if (error instanceof TakeoutShapeError) {
      throw new TakeoutReadError(error.message);
    }
    throw error;
  }
  if (grouped.locations.length === 0) {
    throw new TakeoutReadError(
      grouped.mapsReviews
        ? MAPS_REVIEWS_MESSAGE
        : archives > 0
          ? "No Google Business Profile reviews were found in this archive. Check that Google Business Profile was selected when you exported, and that you chose every part of a split export."
          : "No Google Business Profile reviews were found. Choose the Takeout .zip, or the reviews.json files inside its Google Business Profile folder.",
    );
  }
  return {
    ...grouped,
    fromArchives: archives > 0 && looseFiles === 0,
    archives,
    looseFiles,
  };
}

/** Stream one zip, inflating only the entries of interest. */
async function readZip(
  file: File,
  onProgress?: (progress: ReadProgress) => void,
): Promise<TakeoutFile[]> {
  const { Unzip, UnzipInflate } = await import("fflate");
  const found: TakeoutFile[] = [];
  const pending: Promise<void>[] = [];
  const unzip = new Unzip((entry) => {
    if (!isTakeoutEntryOfInterest(entry.name)) return; // never inflated
    pending.push(
      new Promise<void>((resolve, reject) => {
        const decoder = new TextDecoder();
        let text = "";
        entry.ondata = (error, chunk, final) => {
          if (error) {
            reject(error);
            return;
          }
          text += decoder.decode(chunk, { stream: !final });
          if (final) {
            found.push({ path: entry.name, text });
            resolve();
          }
        };
        entry.start();
      }),
    );
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      bytesRead += value.byteLength;
      unzip.push(value);
      onProgress?.({ file: file.name, bytesRead, totalBytes: file.size });
    }
    await Promise.all(pending);
  } catch (error) {
    throw new TakeoutReadError(
      `${file.name} could not be read as a zip archive${error instanceof Error ? ` (${error.message})` : ""}. Download it again from Google Takeout.`,
    );
  }
  return found;
}
