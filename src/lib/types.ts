/** Domain types. Mirrors PRD section 14 (data model). */

export type ProjectType = 'talkinghead' | 'prompt';
export type ProjectStatus = 'recording' | 'processing' | 'ready';
export type Verdict = 'dud' | 'keep' | 'perfect';
export type ClipTag = 'talking' | 'broll';

export interface Project {
  id: string;
  type: ProjectType;
  title: string;
  status: ProjectStatus;
  prompt: string | null;
  created_at: number;
}

export interface Clip {
  id: string;
  project_id: string;
  order_index: number;
  file_uri: string;
  duration_ms: number;
  verdict: Verdict;
  verdict_overridden: number; // 0 | 1
  tag: ClipTag;
  tag_overridden: number; // 0 | 1
  excluded: number; // 0 | 1  manual-edit: dropped from the cut
  created_at: number;
}

export interface Collection {
  id: string;
  name: string;
  created_at: number;
}

export interface Inspiration {
  id: string;
  collection_id: string;
  source_url: string;
  thumb_color: string;
  note: string | null;
  added_at: number;
}
