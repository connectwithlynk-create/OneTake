import { getDb } from './db';
import { id as newId } from './id';
import type {
  MediaAnalysisStatus,
  MediaAsset,
  MediaAssetKind,
  MediaAssetSegment,
  MediaAssetSource,
  MediaLibraryProvider,
  MediaLibraryRoot,
} from './types';

export type MediaLibraryRootInput = {
  provider: MediaLibraryProvider;
  providerRootId: string;
  providerRootName: string;
  catalogFileId?: string | null;
  embeddingsFileId?: string | null;
  changeCursor?: string | null;
};

export type MediaAssetInput = {
  libraryId: string;
  kind: MediaAssetKind;
  source: MediaAssetSource;
  provider: MediaLibraryProvider;
  providerFileId: string;
  providerRevisionId?: string | null;
  providerWebUrl?: string | null;
  name: string;
  mimeType: string;
  contentHash?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  sizeBytes?: number | null;
};

export type MediaSegmentInput = {
  assetId: string;
  startMs: number;
  endMs: number;
  thumbnailFileId?: string | null;
  description?: string | null;
  tagsJson?: string | null;
  objectsJson?: string | null;
  transcript?: string | null;
  ocrText?: string | null;
  embeddingRef?: string | null;
  score?: number | null;
};

export type MediaSegmentSearchResult = MediaAssetSegment & {
  asset_name: string;
  asset_kind: MediaAssetKind;
  provider: MediaLibraryProvider;
  provider_file_id: string;
  provider_revision_id: string | null;
  provider_web_url: string | null;
  mime_type: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  proxy_file_id: string | null;
};

function likePattern(query: string): string {
  return `%${query.trim().replace(/[%_]/g, '\\$&')}%`;
}

export async function upsertMediaLibraryRoot(
  input: MediaLibraryRootInput
): Promise<MediaLibraryRoot> {
  const db = await getDb();
  const now = Date.now();
  const existing = await db.getFirstAsync<MediaLibraryRoot>(
    'SELECT * FROM media_libraries WHERE provider = ? AND provider_root_id = ?',
    input.provider,
    input.providerRootId
  );
  if (existing) {
    await db.runAsync(
      `UPDATE media_libraries
          SET provider_root_name = ?,
              catalog_file_id = ?,
              embeddings_file_id = ?,
              change_cursor = ?,
              status = 'active',
              error = NULL,
              updated_at = ?
        WHERE id = ?`,
      input.providerRootName,
      input.catalogFileId ?? existing.catalog_file_id,
      input.embeddingsFileId ?? existing.embeddings_file_id,
      input.changeCursor ?? existing.change_cursor,
      now,
      existing.id
    );
    return (await getMediaLibraryRoot(existing.id))!;
  }

  const root: MediaLibraryRoot = {
    id: newId(),
    provider: input.provider,
    provider_root_id: input.providerRootId,
    provider_root_name: input.providerRootName,
    catalog_file_id: input.catalogFileId ?? null,
    embeddings_file_id: input.embeddingsFileId ?? null,
    change_cursor: input.changeCursor ?? null,
    status: 'active',
    error: null,
    created_at: now,
    updated_at: now,
  };
  await db.runAsync(
    `INSERT INTO media_libraries
       (id, provider, provider_root_id, provider_root_name, catalog_file_id,
        embeddings_file_id, change_cursor, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    root.id,
    root.provider,
    root.provider_root_id,
    root.provider_root_name,
    root.catalog_file_id,
    root.embeddings_file_id,
    root.change_cursor,
    root.status,
    root.error,
    root.created_at,
    root.updated_at
  );
  return root;
}

export async function getMediaLibraryRoot(
  id: string
): Promise<MediaLibraryRoot | null> {
  const db = await getDb();
  return db.getFirstAsync<MediaLibraryRoot>(
    'SELECT * FROM media_libraries WHERE id = ?',
    id
  );
}

export async function listMediaLibraryRoots(): Promise<MediaLibraryRoot[]> {
  const db = await getDb();
  return db.getAllAsync<MediaLibraryRoot>(
    'SELECT * FROM media_libraries ORDER BY updated_at DESC'
  );
}

export async function setMediaLibraryCursor(
  libraryId: string,
  changeCursor: string | null
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE media_libraries SET change_cursor = ?, updated_at = ? WHERE id = ?',
    changeCursor,
    Date.now(),
    libraryId
  );
}

export async function upsertMediaAsset(
  input: MediaAssetInput
): Promise<MediaAsset> {
  const db = await getDb();
  const now = Date.now();
  const existing = await db.getFirstAsync<MediaAsset>(
    'SELECT * FROM media_assets WHERE provider = ? AND provider_file_id = ?',
    input.provider,
    input.providerFileId
  );
  if (existing) {
    await db.runAsync(
      `UPDATE media_assets
          SET library_id = ?,
              kind = ?,
              source = ?,
              provider_revision_id = ?,
              provider_web_url = ?,
              name = ?,
              mime_type = ?,
              content_hash = ?,
              duration_ms = ?,
              width = ?,
              height = ?,
              fps = ?,
              size_bytes = ?,
              last_seen_at = ?,
              updated_at = ?
        WHERE id = ?`,
      input.libraryId,
      input.kind,
      input.source,
      input.providerRevisionId ?? null,
      input.providerWebUrl ?? null,
      input.name,
      input.mimeType,
      input.contentHash ?? null,
      input.durationMs ?? null,
      input.width ?? null,
      input.height ?? null,
      input.fps ?? null,
      input.sizeBytes ?? null,
      now,
      now,
      existing.id
    );
    return (await getMediaAsset(existing.id))!;
  }

  const asset: MediaAsset = {
    id: newId(),
    library_id: input.libraryId,
    kind: input.kind,
    source: input.source,
    provider: input.provider,
    provider_file_id: input.providerFileId,
    provider_revision_id: input.providerRevisionId ?? null,
    provider_web_url: input.providerWebUrl ?? null,
    name: input.name,
    mime_type: input.mimeType,
    content_hash: input.contentHash ?? null,
    duration_ms: input.durationMs ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    fps: input.fps ?? null,
    size_bytes: input.sizeBytes ?? null,
    thumbnail_file_id: null,
    proxy_file_id: null,
    analysis_status: 'pending',
    analysis_error: null,
    description: null,
    tags_json: null,
    objects_json: null,
    transcript: null,
    ocr_text: null,
    embedding_ref: null,
    last_seen_at: now,
    analyzed_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.runAsync(
    `INSERT INTO media_assets
       (id, library_id, kind, source, provider, provider_file_id,
        provider_revision_id, provider_web_url, name, mime_type, content_hash,
        duration_ms, width, height, fps, size_bytes, thumbnail_file_id,
        proxy_file_id, analysis_status, analysis_error, description, tags_json,
        objects_json, transcript, ocr_text, embedding_ref, last_seen_at,
        analyzed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    asset.id,
    asset.library_id,
    asset.kind,
    asset.source,
    asset.provider,
    asset.provider_file_id,
    asset.provider_revision_id,
    asset.provider_web_url,
    asset.name,
    asset.mime_type,
    asset.content_hash,
    asset.duration_ms,
    asset.width,
    asset.height,
    asset.fps,
    asset.size_bytes,
    asset.thumbnail_file_id,
    asset.proxy_file_id,
    asset.analysis_status,
    asset.analysis_error,
    asset.description,
    asset.tags_json,
    asset.objects_json,
    asset.transcript,
    asset.ocr_text,
    asset.embedding_ref,
    asset.last_seen_at,
    asset.analyzed_at,
    asset.created_at,
    asset.updated_at
  );
  return asset;
}

export async function getMediaAsset(id: string): Promise<MediaAsset | null> {
  const db = await getDb();
  return db.getFirstAsync<MediaAsset>('SELECT * FROM media_assets WHERE id = ?', id);
}

export async function setMediaAssetAnalysis(
  assetId: string,
  patch: {
    status: MediaAnalysisStatus;
    error?: string | null;
    description?: string | null;
    tagsJson?: string | null;
    objectsJson?: string | null;
    transcript?: string | null;
    ocrText?: string | null;
    embeddingRef?: string | null;
    thumbnailFileId?: string | null;
    proxyFileId?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `UPDATE media_assets
        SET analysis_status = ?,
            analysis_error = ?,
            description = COALESCE(?, description),
            tags_json = COALESCE(?, tags_json),
            objects_json = COALESCE(?, objects_json),
            transcript = COALESCE(?, transcript),
            ocr_text = COALESCE(?, ocr_text),
            embedding_ref = COALESCE(?, embedding_ref),
            thumbnail_file_id = COALESCE(?, thumbnail_file_id),
            proxy_file_id = COALESCE(?, proxy_file_id),
            analyzed_at = ?,
            updated_at = ?
      WHERE id = ?`,
    patch.status,
    patch.error ?? null,
    patch.description ?? null,
    patch.tagsJson ?? null,
    patch.objectsJson ?? null,
    patch.transcript ?? null,
    patch.ocrText ?? null,
    patch.embeddingRef ?? null,
    patch.thumbnailFileId ?? null,
    patch.proxyFileId ?? null,
    patch.status === 'ready' || patch.status === 'failed' ? now : null,
    now,
    assetId
  );
}

export async function replaceMediaSegments(
  assetId: string,
  segments: MediaSegmentInput[]
): Promise<MediaAssetSegment[]> {
  const db = await getDb();
  const now = Date.now();
  const inserted: MediaAssetSegment[] = [];
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM media_segments WHERE asset_id = ?', assetId);
    for (const input of segments) {
      const segment: MediaAssetSegment = {
        id: newId(),
        asset_id: assetId,
        start_ms: Math.max(0, Math.round(input.startMs)),
        end_ms: Math.max(0, Math.round(input.endMs)),
        thumbnail_file_id: input.thumbnailFileId ?? null,
        description: input.description ?? null,
        tags_json: input.tagsJson ?? null,
        objects_json: input.objectsJson ?? null,
        transcript: input.transcript ?? null,
        ocr_text: input.ocrText ?? null,
        embedding_ref: input.embeddingRef ?? null,
        score: input.score ?? null,
        created_at: now,
        updated_at: now,
      };
      await db.runAsync(
        `INSERT INTO media_segments
           (id, asset_id, start_ms, end_ms, thumbnail_file_id, description,
            tags_json, objects_json, transcript, ocr_text, embedding_ref,
            score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        segment.id,
        segment.asset_id,
        segment.start_ms,
        segment.end_ms,
        segment.thumbnail_file_id,
        segment.description,
        segment.tags_json,
        segment.objects_json,
        segment.transcript,
        segment.ocr_text,
        segment.embedding_ref,
        segment.score,
        segment.created_at,
        segment.updated_at
      );
      inserted.push(segment);
    }
  });
  return inserted;
}

export async function searchMediaSegments(
  query: string,
  options: { limit?: number; kind?: MediaAssetKind } = {}
): Promise<MediaSegmentSearchResult[]> {
  const db = await getDb();
  const q = query.trim();
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  if (!q) {
    return db.getAllAsync<MediaSegmentSearchResult>(
      `SELECT s.*,
              a.name AS asset_name,
              a.kind AS asset_kind,
              a.provider,
              a.provider_file_id,
              a.provider_revision_id,
              a.provider_web_url,
              a.mime_type,
              a.duration_ms,
              a.width,
              a.height,
              a.proxy_file_id
         FROM media_segments s
         JOIN media_assets a ON a.id = s.asset_id
        WHERE (? IS NULL OR a.kind = ?)
        ORDER BY s.updated_at DESC
        LIMIT ?`,
      options.kind ?? null,
      options.kind ?? null,
      limit
    );
  }

  const pattern = likePattern(q);
  return db.getAllAsync<MediaSegmentSearchResult>(
    `SELECT s.*,
            a.name AS asset_name,
            a.kind AS asset_kind,
            a.provider,
            a.provider_file_id,
            a.provider_revision_id,
            a.provider_web_url,
            a.mime_type,
            a.duration_ms,
            a.width,
            a.height,
            a.proxy_file_id
       FROM media_segments s
       JOIN media_assets a ON a.id = s.asset_id
      WHERE (? IS NULL OR a.kind = ?)
        AND (
          s.description LIKE ? ESCAPE '\\'
          OR s.tags_json LIKE ? ESCAPE '\\'
          OR s.objects_json LIKE ? ESCAPE '\\'
          OR s.transcript LIKE ? ESCAPE '\\'
          OR s.ocr_text LIKE ? ESCAPE '\\'
          OR a.description LIKE ? ESCAPE '\\'
          OR a.tags_json LIKE ? ESCAPE '\\'
          OR a.name LIKE ? ESCAPE '\\'
        )
      ORDER BY COALESCE(s.score, 0) DESC, s.updated_at DESC
      LIMIT ?`,
    options.kind ?? null,
    options.kind ?? null,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    limit
  );
}
