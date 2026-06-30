import type {
  CloudFileRef,
  CloudListPage,
  CloudStorageProvider,
  CloudUploadInput,
} from './cloud-storage';
import type { MediaAssetKind } from './types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  size?: string;
  modifiedTime?: string;
  version?: string;
  md5Checksum?: string;
  videoMediaMetadata?: {
    width?: number;
    height?: number;
    durationMillis?: string;
  };
  imageMediaMetadata?: {
    width?: number;
    height?: number;
  };
};

function kindFromMime(mimeType: string): CloudFileRef['kind'] {
  if (mimeType === FOLDER_MIME) return 'folder';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'unknown';
}

function driveFileToRef(file: DriveFile): CloudFileRef {
  return {
    provider: 'google_drive',
    fileId: file.id,
    revisionId: file.version ?? null,
    name: file.name,
    mimeType: file.mimeType,
    webUrl: file.webViewLink ?? null,
    sizeBytes: file.size ? Number(file.size) : null,
    modifiedAt: file.modifiedTime ? Date.parse(file.modifiedTime) : null,
    contentHash: file.md5Checksum ?? null,
    durationMs: file.videoMediaMetadata?.durationMillis
      ? Number(file.videoMediaMetadata.durationMillis)
      : null,
    width:
      file.videoMediaMetadata?.width ?? file.imageMediaMetadata?.width ?? null,
    height:
      file.videoMediaMetadata?.height ?? file.imageMediaMetadata?.height ?? null,
    kind: kindFromMime(file.mimeType),
  };
}

function mediaFields(): string {
  return [
    'id',
    'name',
    'mimeType',
    'webViewLink',
    'size',
    'modifiedTime',
    'version',
    'md5Checksum',
    'videoMediaMetadata',
    'imageMediaMetadata',
  ].join(',');
}

function quoteDriveString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function mimeToAssetKind(mimeType: string): MediaAssetKind | null {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

export class GoogleDriveProvider implements CloudStorageProvider {
  readonly provider = 'google_drive' as const;

  constructor(private readonly accessToken: string) {}

  async ensureFolder(
    name: string,
    parentFolderId: string | null = null
  ): Promise<CloudFileRef> {
    const escapedName = quoteDriveString(name);
    const parentClause = parentFolderId
      ? ` and '${quoteDriveString(parentFolderId)}' in parents`
      : '';
    const q =
      `mimeType='${FOLDER_MIME}' and name='${escapedName}' and trashed=false` +
      parentClause;
    const page = await this.request<{ files: DriveFile[] }>(
      `/files?q=${encodeURIComponent(q)}&fields=files(${mediaFields()})&pageSize=1`
    );
    const existing = page.files[0];
    if (existing) return driveFileToRef(existing);

    const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
    if (parentFolderId) body.parents = [parentFolderId];
    const created = await this.request<DriveFile>('/files?fields=' + mediaFields(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return driveFileToRef(created);
  }

  async listFiles(
    folderId: string,
    cursor: string | null = null
  ): Promise<CloudListPage> {
    const q =
      `'${quoteDriveString(folderId)}' in parents and trashed=false and ` +
      "(mimeType contains 'video/' or mimeType contains 'image/' or mimeType contains 'audio/')";
    const params = new URLSearchParams({
      q,
      fields: `nextPageToken,files(${mediaFields()})`,
      pageSize: '100',
      orderBy: 'modifiedTime desc',
    });
    if (cursor) params.set('pageToken', cursor);
    const page = await this.request<{ files: DriveFile[]; nextPageToken?: string }>(
      `/files?${params.toString()}`
    );
    return {
      files: page.files.map(driveFileToRef),
      nextCursor: page.nextPageToken ?? null,
    };
  }

  async getFile(fileId: string): Promise<CloudFileRef> {
    const file = await this.request<DriveFile>(
      `/files/${encodeURIComponent(fileId)}?fields=${mediaFields()}`
    );
    return driveFileToRef(file);
  }

  async downloadFile(fileId: string): Promise<Blob> {
    const res = await this.fetchRaw(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
    );
    return res.blob();
  }

  async uploadFile(input: CloudUploadInput): Promise<CloudFileRef> {
    const metadata = {
      name: input.name,
      mimeType: input.mimeType,
      parents: [input.parentFolderId],
    };
    const boundary = `onetake-${Date.now().toString(36)}`;
    const metaPart =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n`;
    const mediaHeader =
      `--${boundary}\r\n` +
      `Content-Type: ${input.mimeType}\r\n\r\n`;
    const close = `\r\n--${boundary}--`;
    const body = new Blob([metaPart, mediaHeader, input.bytes, close], {
      type: `multipart/related; boundary=${boundary}`,
    });
    const file = await this.request<DriveFile>(
      `/files?uploadType=multipart&fields=${mediaFields()}`,
      {
        baseUrl: DRIVE_UPLOAD,
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      }
    );
    return driveFileToRef(file);
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.request<void>(`/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
  }

  async getStartCursor(): Promise<string | null> {
    const res = await this.request<{ startPageToken?: string }>('/changes/startPageToken');
    return res.startPageToken ?? null;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { baseUrl?: string } = {}
  ): Promise<T> {
    const baseUrl = init.baseUrl ?? DRIVE_API;
    const { baseUrl: _baseUrl, headers, ...rest } = init;
    const res = await this.fetchRaw(`${baseUrl}${path}`, {
      ...rest,
      headers,
    });
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Drive ${res.status}: ${text || res.statusText}`);
    }
    return res;
  }
}
