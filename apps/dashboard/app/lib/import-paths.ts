// URL helpers for the import wizard, shared by server redirects and links.
export function importPath(slug: string): string {
  return `/app/projects/${slug}/import`;
}

export function importMapPath(
  slug: string,
  runId: string,
  query?: Record<string, string>,
): string {
  const search = query ? `?${new URLSearchParams(query)}` : "";
  return `${importPath(slug)}/${runId}/map${search}`;
}

export function importRunPath(slug: string, runId: string): string {
  return `${importPath(slug)}/${runId}`;
}

export function importErrorsPath(slug: string, runId: string): string {
  return `${importPath(slug)}/${runId}/errors.csv`;
}
