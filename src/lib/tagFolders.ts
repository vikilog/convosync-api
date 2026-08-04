/** Shared folder-normalization + grouping helpers for the WorkspaceTag registry. */

export const UNCATEGORIZED_TAG_FOLDER = 'Uncategorized';

/** Trims freeform folder input; blank/whitespace-only becomes null ("Uncategorized"). */
export function normalizeTagFolder(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  return trimmed ? trimmed : null;
}

export type TagFolderGroup<T extends { folder: string | null }> = {
  folder: string;
  items: T[];
};

/** Groups tags by folder (null → "Uncategorized"), folders A→Z with Uncategorized last, items A→Z. */
export function groupTagsByFolder<T extends { folder: string | null; name: string }>(
  items: T[]
): TagFolderGroup<T>[] {
  const byFolder = new Map<string, T[]>();
  for (const item of items) {
    const key = item.folder ?? UNCATEGORIZED_TAG_FOLDER;
    const bucket = byFolder.get(key);
    if (bucket) bucket.push(item);
    else byFolder.set(key, [item]);
  }
  return [...byFolder.entries()]
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED_TAG_FOLDER) return b === UNCATEGORIZED_TAG_FOLDER ? 0 : 1;
      if (b === UNCATEGORIZED_TAG_FOLDER) return -1;
      return a.localeCompare(b);
    })
    .map(([folder, groupItems]) => ({
      folder,
      items: [...groupItems].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
