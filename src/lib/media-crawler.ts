import type { CloudFileRef, CloudStorageProvider } from './cloud-storage';
import { isMediaFile } from './cloud-storage';
import { mimeToAssetKind } from './google-drive';
import {
  replaceMediaSegments,
  setMediaLibraryCursor,
  upsertMediaAsset,
  upsertMediaLibraryRoot,
} from './media-library';
import type { MediaAsset, MediaAssetSource, MediaLibraryRoot } from './types';

const LIBRARY_FOLDER_NAME = 'OneTake Library';

export interface EnsureCloudLibraryResult {
  root: MediaLibraryRoot;
  folder: CloudFileRef;
}

export interface CrawlCloudLibraryResult {
  root: MediaLibraryRoot;
  scanned: number;
  indexed: number;
}

export async function ensureCloudMediaLibrary(
  provider: CloudStorageProvider
): Promise<EnsureCloudLibraryResult> {
  const folder = await provider.ensureFolder(LIBRARY_FOLDER_NAME);
  const cursor = await provider.getStartCursor(folder.fileId).catch(() => null);
  const root = await upsertMediaLibraryRoot({
    provider: provider.provider,
    providerRootId: folder.fileId,
    providerRootName: folder.name,
    changeCursor: cursor,
  });
  return { root, folder };
}

export async function crawlCloudMediaLibrary(
  provider: CloudStorageProvider,
  root: MediaLibraryRoot
): Promise<CrawlCloudLibraryResult> {
  let cursor: string | null = null;
  let scanned = 0;
  let indexed = 0;

  do {
    const page = await provider.listFiles(root.provider_root_id, cursor);
    for (const file of page.files) {
      scanned += 1;
      if (!isMediaFile(file)) continue;
      const asset = await upsertCloudMediaAsset(root.id, file, 'local_import');
      await ensurePlaceholderSegment(asset);
      indexed += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);

  const nextCursor = await provider.getStartCursor(root.provider_root_id).catch(
    () => root.change_cursor
  );
  await setMediaLibraryCursor(root.id, nextCursor);
  return { root: { ...root, change_cursor: nextCursor }, scanned, indexed };
}

export async function upsertCloudMediaAsset(
  libraryId: string,
  file: CloudFileRef,
  source: MediaAssetSource
): Promise<MediaAsset> {
  const kind = mimeToAssetKind(file.mimeType);
  if (!kind) throw new Error(`Unsupported media type: ${file.mimeType}`);
  return upsertMediaAsset({
    libraryId,
    kind,
    source,
    provider: file.provider,
    providerFileId: file.fileId,
    providerRevisionId: file.revisionId,
    providerWebUrl: file.webUrl,
    name: file.name,
    mimeType: file.mimeType,
    contentHash: file.contentHash,
    durationMs: file.durationMs,
    width: file.width,
    height: file.height,
    sizeBytes: file.sizeBytes,
  });
}

export async function ensurePlaceholderSegment(
  asset: MediaAsset
): Promise<void> {
  const endMs =
    asset.kind === 'video' || asset.kind === 'audio'
      ? Math.max(1000, asset.duration_ms ?? 10000)
      : 5000;
  await replaceMediaSegments(asset.id, [
    {
      assetId: asset.id,
      startMs: 0,
      endMs,
      description: asset.description ?? asset.name,
      tagsJson: asset.tags_json,
      transcript: asset.transcript,
      ocrText: asset.ocr_text,
      embeddingRef: asset.embedding_ref,
    },
  ]);
}

export async function uploadMediaToCloudLibrary(
  provider: CloudStorageProvider,
  root: MediaLibraryRoot,
  input: { uri: string; name: string; mimeType: string }
): Promise<MediaAsset> {
  const res = await fetch(input.uri);
  if (!res.ok) throw new Error(`Could not read local media: ${res.status}`);
  const bytes = await res.blob();
  const file = await provider.uploadFile({
    name: input.name,
    mimeType: input.mimeType,
    parentFolderId: root.provider_root_id,
    bytes,
  });
  const asset = await upsertCloudMediaAsset(root.id, file, 'local_import');
  await ensurePlaceholderSegment(asset);
  return asset;
}
