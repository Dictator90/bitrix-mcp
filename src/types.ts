export type IndexKind = "project" | "template" | "bitrix" | "install" | "docs";

export interface IndexFile {
  path: string;
  relativePath: string;
  kind: IndexKind;
  size: number;
  mtimeMs: number;
  language: string;
  symbols: SymbolRecord[];
  moduleUsages?: ModuleUsageRecord[];
  ormEntities?: OrmEntityRecord[];
  ormUsages?: OrmUsageRecord[];
}

export interface SymbolRecord {
  type: "class" | "interface" | "trait" | "function" | "method" | "event" | "component" | "constant" | "static_call" | "method_call" | "export" | "object_method" | "agent" | "mail_event";
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
  agentAction?: "AddAgent" | "RemoveAgent" | "GetList";
  api?: string;
  siteId?: string;
  periodic?: string;
  interval?: number;
  relativeFile?: string;
  file: string;
  line: number;
  signature?: string;
  description?: string;
}

export interface OrmFieldRecord {
  name: string;
  type: string;
  className?: string;
  line: number;
  options?: Record<string, unknown>;
  referenceClass?: string;
  signature?: string;
}

export interface OrmEntityRecord {
  type: "orm_entity";
  className: string;
  fullyQualifiedName: string;
  namespace?: string;
  parentClass?: string;
  module?: string;
  tableName?: string;
  file: string;
  relativeFile?: string;
  line: number;
  fields: OrmFieldRecord[];
  references: OrmFieldRecord[];
  kind?: IndexKind;
  signature?: string;
}

export interface OrmUsageRecord {
  type: "orm_usage";
  entity: string;
  method: string;
  usageKind: "datamanager" | "compile_entity" | "compile_entity_by_iblock";
  module?: string;
  file: string;
  relativeFile?: string;
  line: number;
  kind?: IndexKind;
  signature?: string;
}

export interface ModuleUsageRecord {
  type: "module_usage";
  module: string;
  file: string;
  relativeFile?: string;
  line: number;
  call: "Loader::includeModule" | "CModule::IncludeModule" | "IsModuleInstalled" | "ModuleManager::isModuleInstalled";
  kind?: IndexKind;
  signature: string;
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
