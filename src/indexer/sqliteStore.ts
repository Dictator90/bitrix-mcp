// Facade over the SQLite index store; the implementation lives in ./store/.
export type { AgentSearchQuery, AutoloadSearchQuery, BitrixRelationSearchQuery, ComponentContextQuery, ComponentContextResult, ComponentSearchQuery, ExistingIndexFile, HlblockUsageSearchQuery, IblockUsageSearchQuery, InheritanceSearchQuery, MailEventSearchQuery, MailEventSearchResult, ModuleUsageSearchQuery, OptionSearchQuery, OrmEntityMapQuery, OrmSearchQuery, OrmUsageSearchQuery, SqliteSearchQuery, SqliteStoreOptions, SymbolContextSearchQuery, WriteBitrixRelationsOptions } from "./store/types.js";
export { PARSER_VERSION, SCHEMA_VERSION, ensureSqliteStore } from "./store/schema.js";
export { SqliteIndexWriter, readExistingFilesByKind, writeIndexToSqlite } from "./store/writer.js";
export type { OpenIndexWriterOptions, WriteIndexOptions, WriteManifestOptions } from "./store/writer.js";
export { clearBitrixRelationsByFile, clearBitrixRelationsByKind, getComponentContext, getOrmEntityMap, searchAgents, searchAutoloadRecords, searchBitrixFeatures, searchBitrixRelations, searchCallSites, searchComponents, searchHlblockUsages, searchIblockUsages, searchInheritanceRelations, searchMailEvents, searchModuleUsages, searchOptionUsages, searchOrmEntities, searchOrmUsages, searchSymbolsForContext, writeAutoloadRecords, writeBitrixRelations } from "./store/queries.js";
export type { BitrixFeatureSearchQuery, BitrixFeatureSearchResult, CallSiteSearchQuery } from "./store/queries.js";
export { getIndexStatus, getProjectOverview, hasIndexMetadata, readIndexFromSqlite, readIndexWarnings } from "./store/status.js";
export type { IndexStatus, ProjectOverviewOptions, StatusBreakdown } from "./store/status.js";
export { readExistingDocsBySource, searchDocSymbolRefs, writeDocsToSqlite } from "./store/docs.js";
export type { DocIndexChunk, DocSymbolRef, ExistingDocIndexMetadata, WriteDocsOptions } from "./store/docs.js";
export { readIndexedRecordsForFiles } from "./store/indexedRecords.js";
export type { IndexedRecordsForFiles } from "./store/indexedRecords.js";
export { searchSqliteLiveApi, searchSqliteDocs } from "../liveapi/search.js";
