import type { MediaAssetKind, MediaLibraryProvider } from './types';

export interface CloudFileRef {
  provider: MediaLibraryProvider;
  fileId: string;
  revisionId: string | null;
  name: string;
  mimeType: string;
  webUrl: string | null;
  sizeBytes: number | null;
  modifiedAt: number | null;
  contentHash: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  kind: MediaAssetKind | 'folder' | 'unknown';
}

export interface CloudListPage {
  files: CloudFileRef[];
  nextCursor: string | null;
}

export interface CloudUploadInput {
  name: string;
  mimeType: string;
  bytes: Blob | ArrayBuffer;
  parentFolderId: string;
}

export interface CloudStorageProvider {
  readonly provider: MediaLibraryProvider;

  ensureFolder(name: string, parentFolderId?: string | null): Promise<CloudFileRef>;
  listFiles(folderId: string, cursor?: string | null): Promise<CloudListPage>;
  getFile(fileId: string): Promise<CloudFileRef>;
  downloadFile(fileId: string): Promise<Blob>;
  uploadFile(input: CloudUploadInput): Promise<CloudFileRef>;
  deleteFile(fileId: string): Promise<void>;

  /** Provider-specific cursor for incremental recrawls of the selected
   *  library folder. Google Drive maps this to changes/page tokens. */
  getStartCursor(folderId: string): Promise<string | null>;
}

export function isMediaFile(ref: CloudFileRef): boolean {
  return ref.kind === 'video' || ref.kind === 'image' || ref.kind === 'audio';
}
