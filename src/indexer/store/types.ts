import path from "node:path";
import type { BitrixRelationRecord, ComponentParamRecord, IndexFile, IndexKind, SymbolRecord, AutoloadRecordType } from "../../types.js";

export interface SqliteStoreOptions {
  dbFile: string;
}

export interface SqliteSearchQuery {
  query: string;
  type?: SymbolRecord["type"];
  module?: string;
  limit?: number;
}

export interface AgentSearchQuery {
  query?: string;
  module?: string;
  kind?: IndexKind | IndexKind[];
  file?: string;
  limit?: number;
}

export interface SymbolContextSearchQuery {
  name: string;
  type?: Extract<SymbolRecord["type"], "class" | "interface" | "trait" | "function" | "method" | "event" | "component" | "constant">;
  kind?: IndexKind | IndexKind[];
  file?: string;
  limit?: number;
}

export interface MailEventSearchQuery {
  query?: string;
  eventName?: string;
  api?: string;
  kind?: IndexKind | IndexKind[];
  file?: string;
  includeHandlers?: boolean;
  limit?: number;
}

export interface MailEventSearchResult extends SymbolRecord {
  handlers?: SymbolRecord[];
}
export interface ComponentSearchQuery {
  query?: string;
  component?: string;
  template?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface ComponentContextQuery {
  component: string;
  template?: string;
  callFile?: string;
  includeFiles?: boolean;
  includeAssets?: boolean;
  includeParams?: boolean;
  format?: "compact" | "full";
}

export interface ComponentContextResult {
  component: string;
  template: string;
  calls: SymbolRecord[];
  templateFiles: IndexFile[];
  assets: IndexFile[];
  parameters: ComponentParamRecord[];
  relations: BitrixRelationRecord[];
  possibleTemplatePaths?: string[];
}

export interface ModuleUsageSearchQuery {
  module?: string;
  call?: string;
  kind?: IndexKind | IndexKind[];
  file?: string;
  limit?: number;
}

export interface IblockUsageSearchQuery {
  query?: string;
  iblockId?: string;
  api?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface HlblockUsageSearchQuery {
  query?: string;
  hlblockId?: string;
  api?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface OptionSearchQuery {
  query?: string;
  module?: string;
  name?: string;
  operation?: "get" | "set";
  api?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  file?: string;
  limit?: number;
}

export interface OrmSearchQuery {
  query?: string;
  tableName?: string;
  className?: string;
  module?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  limit?: number;
}

export interface OrmEntityMapQuery {
  className?: string;
  tableName?: string;
  file?: string;
}

export interface OrmUsageSearchQuery {
  query?: string;
  entity?: string;
  method?: string;
  file?: string;
  kind?: IndexKind | IndexKind[] | string | string[];
  limit?: number;
}

export interface AutoloadSearchQuery {
  query?: string;
  namespace?: string;
  package?: string;
  type?: AutoloadRecordType;
  limit?: number;
}

export interface BitrixRelationSearchQuery {
  sourceType?: string;
  sourceName?: string;
  targetType?: string;
  targetName?: string;
  relationType?: string;
  module?: string;
  kind?: string;
  file?: string;
  limit?: number;
}

export interface InheritanceSearchQuery {
  target: string;
  relation?: "extends" | "implements" | "uses_trait" | "any";
  kind?: IndexKind | IndexKind[];
  module?: string;
  limit?: number;
}

export interface WriteBitrixRelationsOptions {
  clearKind?: string;
  clearFile?: string;
}

export interface ExistingIndexFile {
  id: number;
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}
