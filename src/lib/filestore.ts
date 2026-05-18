import { Directory, File, Paths } from 'expo-file-system';

/**
 * Recorded clips land in the cache dir. Move them into persistent app
 * storage and store only the RELATIVE path in the DB (e.g.
 * "clips/<id>.mov"). The absolute container path on iOS includes a
 * per-install UUID that changes on reinstall, so storing absolute URIs
 * would break playback/sync after an update. Resolve at read time instead.
 */
const SUB = 'clips';

function clipsDir(): Directory {
  const dir = new Directory(Paths.document, SUB);
  if (!dir.exists) dir.create();
  return dir;
}

/** Returns the relative path to store in clips.file_uri. */
export function persistClip(tempUri: string, clipId: string): string {
  try {
    const src = new File(tempUri);
    const dest = new File(clipsDir(), `${clipId}.mov`);
    if (dest.exists) dest.delete();
    src.move(dest);
    return `${SUB}/${clipId}.mov`;
  } catch {
    // If the move fails, fall back to the temp uri so the flow continues.
    return tempUri;
  }
}

/** Relative path -> absolute uri. Legacy absolute values pass through. */
export function resolveClipUri(rel: string): string {
  if (!rel) return rel;
  if (rel.startsWith('file:') || rel.startsWith('/')) return rel; // legacy
  return new File(Paths.document, rel).uri;
}

export function deleteClipFile(rel: string) {
  try {
    const f = new File(resolveClipUri(rel));
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}
