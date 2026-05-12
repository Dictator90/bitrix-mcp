export type IndexKind = "project" | "template" | "bitrix" | "install" | "docs";

export interface IndexFile {
  path: string;
  relativePath: string;
  kind: IndexKind;
  size: number;
  mtimeMs: number;
  language: string;
  symbols: SymbolRecord[];
}

export interface SymbolRecord {
  type: "class" | "interface" | "trait" | "function" | "method" | "event" | "component" | "constant" | "static_call" | "method_call" | "export" | "object_method";
  kind?: IndexKind;
  language?: string;
  name: string;
  module?: string;
  className?: string;
  handlerClass?: string;
  handlerMethod?: string;
  handlerFunction?: string;
  anonymous?: boolean;
  eventName?: string;
  file: string;
  line: number;
  signature?: string;
  description?: string;
}

export interface EventRecord {
  kind?: IndexKind;
  module: string;
  eventName: string;
  handlerClass?: string;
  handlerMethod?: string;
  handlerFunction?: string;
  anonymous?: boolean;
  file: string;
  line: number;
  signature?: string;
  description?: string;
}

export interface SearchResult<T = unknown> {
  score: number;
  item: T;
}

export interface BitrixRelationRecord {
  id?: number;
  sourceType: string;
  sourceName: string;
  targetType: string;
  targetName: string;
  relationType: string;
  file: string;
  line: number;
  module?: string;
  kind?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

export interface IndexWarning {
  type: "php_parse_fallback";
  file: string;
  message: string;
}

export interface IndexManifest {
  version: 1;
  generatedAt: string;
  root: string;
  kind: IndexKind;
  files: IndexFile[];
  warnings?: IndexWarning[];
}

export interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  path: string;
}

export interface DocSource {
  id: number;
  type: "git" | "path";
  uri: string;
  rootPath?: string;
  checkoutPath?: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}
