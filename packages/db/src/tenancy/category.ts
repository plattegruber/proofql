/**
 * The project's business category from Google (#151).
 *
 * `projects.category` picks the generic query words the floor's partial
 * word match ignores (`genericQueryWords` in `@proofql/core`). Imports
 * that see Google's primary type — the Places bootstrap and its refresh
 * (`primaryType`), the Business Profile connector
 * (`categories.primaryCategory`) — fill it **only while it is null**: an
 * owner's choice in Settings always wins, and a later import of a
 * different place never flips it.
 *
 * The caller bumps the project's cache generation when this returns
 * `true`, after the commit; the query cache key also carries the generic
 * words, so a missed bump can serve nothing computed under the old list.
 */

import { categoryFromGoogleType } from "@proofql/core";
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../client.js";
import { projects } from "../schema/tenancy.js";

/**
 * Set `projects.category` from a Google type when it is still null and
 * the type maps to a category. Resolves to true when the row changed.
 */
export async function setCategoryFromGoogleIfUnset(
  db: Db,
  projectId: string,
  googleType: string | null | undefined,
): Promise<boolean> {
  const category = categoryFromGoogleType(googleType);
  if (category === null) return false;
  const rows = await db
    .update(projects)
    .set({ category, updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), isNull(projects.category)))
    .returning({ id: projects.id });
  return rows.length > 0;
}
