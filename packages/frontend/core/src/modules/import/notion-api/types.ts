import type { ImportBatch } from '@blocksuite/affine/widgets/linked-doc';

export type NotionAnnotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
};

export type NotionRichText = {
  type: string;
  plain_text: string;
  href?: string | null;
  annotations?: NotionAnnotations;
  mention?: { type: string; page?: { id: string }; database?: { id: string } };
};

export type NotionParent =
  | { type: 'workspace' }
  | { type: 'page_id'; page_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'data_source_id'; data_source_id: string; database_id?: string }
  | { type: 'block_id'; block_id: string };

export type NotionFileObject =
  | { type: 'file'; file: { url: string }; name?: string }
  | { type: 'external'; external: { url: string }; name?: string };

export type NotionIcon =
  | { type: 'emoji'; emoji: string }
  | NotionFileObject
  | null
  | undefined;

export type NotionSelectOption = { id?: string; name: string; color?: string };

export type NotionPropertySchema = {
  id: string;
  name: string;
  type: string;
  select?: { options: NotionSelectOption[] };
  multi_select?: { options: NotionSelectOption[] };
  status?: { options: NotionSelectOption[] };
};

export type NotionPropertyValue = { id?: string; type: string } & Record<
  string,
  any
>;

export type NotionPage = {
  object: 'page';
  id: string;
  parent: NotionParent;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  icon?: NotionIcon;
  properties: Record<string, NotionPropertyValue>;
};

export type NotionDatabase = {
  object: 'database';
  id: string;
  parent: NotionParent;
  title: NotionRichText[];
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  icon?: NotionIcon;
  properties: Record<string, NotionPropertySchema>;
};

export type NotionBlock = {
  object?: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  /** Filled in by the client for blocks with `has_children`. */
  children?: NotionBlock[];
} & Record<string, any>;

export type NotionWarning = NonNullable<ImportBatch['warnings']>[number];

/** Abstraction the planner reads from; implemented by `NotionApiClient`. */
export interface NotionSource {
  listAccessibleContent(): Promise<{
    pages: NotionPage[];
    databases: NotionDatabase[];
  }>;
  getBlocks(pageId: string): Promise<NotionBlock[]>;
}
