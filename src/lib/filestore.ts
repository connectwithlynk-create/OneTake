import { Directory, File, Paths } from 'expo-file-system';

/**
 * Recorded clips land in the cache dir. Move them into persistent app
 * storage (PRD FR-CAP-3) under document/clips/<clipId>.mov.
 */
function clipsDir(): Directory {
  const dir = new Directory(Paths.document, 'clips');
  if (!dir.exists) dir.create();
  return dir;
}

export function persistClip(tempUri: string, clipId: string): string {
  try {
    const src = new File(tempUri);
    const dest = new File(clipsDir(), `${clipId}.mov`);
    if (dest.exists) dest.delete();
    src.move(dest);
    return dest.uri;
  } catch {
    // If the move fails (e.g. unsupported on platform) keep the temp uri so
    // the rest of the flow still works.
    return tempUri;
  }
}

export function deleteClipFile(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}
