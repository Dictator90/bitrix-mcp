import fs from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "../database.js";
import type { BitrixRelationRecord, HlblockUsageRecord, IblockUsageRecord, ModuleUsageRecord, OrmEntityRecord, OptionUsageRecord, OrmUsageRecord, SymbolRecord } from "../../types.js";
import { normalizeSlashes, normalizedFileLookupCandidates, rowToBitrixRelation, rowToHlblockUsage, rowToIblockUsage, rowToModuleUsage, rowToOptionUsage, rowToOrmEntity, rowToOrmUsage, rowToSymbol } from "./rows.js";
import type { BitrixRelationRow, HlblockUsageRow, IblockUsageRow, ModuleUsageRow, OptionUsageRow, OrmEntityRow, OrmUsageRow, SymbolRow } from "./rows.js";
import { ensureSqliteStore } from "./schema.js";

export interface IndexedRecordsForFiles {
  symbols: SymbolRecord[];
  moduleUsages: ModuleUsageRecord[];
  ormEntities: OrmEntityRecord[];
  ormUsages: OrmUsageRecord[];
  iblockUsages: IblockUsageRecord[];
  hlblockUsages: HlblockUsageRecord[];
  optionUsages: OptionUsageRecord[];
  relations: BitrixRelationRecord[];
}

function emptyIndexedRecordsForFiles(): IndexedRecordsForFiles {
  return { symbols: [], moduleUsages: [], ormEntities: [], ormUsages: [], iblockUsages: [], hlblockUsages: [], optionUsages: [], relations: [] };
}

export async function readIndexedRecordsForFiles(dbFile: string, files: string[], options: { includeRelations?: boolean } = {}): Promise<IndexedRecordsForFiles> {
  if (files.length === 0) {
    return emptyIndexedRecordsForFiles();
  }
  try {
    await fs.access(dbFile);
  } catch {
    return emptyIndexedRecordsForFiles();
  }
  await ensureSqliteStore(dbFile);
  const db = openDatabase(dbFile);
  try {
    const inputCandidates = Array.from(new Set(files.flatMap((file) => normalizedFileLookupCandidates(file))));
    if (inputCandidates.length === 0) {
      return emptyIndexedRecordsForFiles();
    }

    const inputPlaceholders = inputCandidates.map(() => "?").join(", ");
    const matchedFiles = db.prepare(`
      SELECT path, relative_path
      FROM files
      WHERE replace(path, char(92), '/') IN (${inputPlaceholders}) OR replace(relative_path, char(92), '/') IN (${inputPlaceholders})
    `).all(...inputCandidates, ...inputCandidates) as Array<{ path: string; relative_path: string }>;
    const normalized = Array.from(new Set([
      ...inputCandidates,
      ...matchedFiles.flatMap((file) => [normalizeSlashes(file.path), normalizeSlashes(file.relative_path)])
    ]));
    const placeholders = normalized.map(() => "?").join(", ");
    const symbolRows = db.prepare(`
      SELECT s.kind, s.type, s.language, s.name, s.module, s.class_name, s.handler_class, s.handler_method, s.handler_function,
             s.event_name, s.agent_action, s.api, s.site_id, s.periodic, s.interval, s.file, f.relative_path AS relative_file, s.line, s.line_end, s.signature, s.description, s.component_template, s.params_json
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(s.file, char(92), '/') IN (${placeholders})
      ORDER BY f.relative_path, s.line, s.id
    `).all(...normalized, ...normalized) as unknown as SymbolRow[];

    const moduleUsageRows = db.prepare(`
      SELECT m.id, m.file_id, m.kind, m.root, m.module, m.call, m.file, m.relative_file, m.line, m.signature
      FROM module_usages m
      JOIN files f ON f.id = m.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(m.relative_file, char(92), '/') IN (${placeholders}) OR replace(m.file, char(92), '/') IN (${placeholders})
      ORDER BY coalesce(m.relative_file, m.file), m.line, m.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as ModuleUsageRow[];

    const ormEntityRows = db.prepare(`
      SELECT o.id, o.kind, o.root, o.class_name, o.fully_qualified_name, o.namespace, o.parent_class, o.module, o.table_name, o.file, o.relative_file, o.line, o.fields_json, o.references_json, o.signature
      FROM orm_entities o
      JOIN files f ON f.id = o.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(o.relative_file, char(92), '/') IN (${placeholders}) OR replace(o.file, char(92), '/') IN (${placeholders})
      ORDER BY coalesce(o.relative_file, o.file), o.line, o.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as OrmEntityRow[];

    const ormUsageRows = db.prepare(`
      SELECT o.id, o.kind, o.root, o.entity, o.method, o.usage_kind, o.module, o.file, o.relative_file, o.line, o.signature
      FROM orm_usages o
      JOIN files f ON f.id = o.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(o.relative_file, char(92), '/') IN (${placeholders}) OR replace(o.file, char(92), '/') IN (${placeholders})
      ORDER BY coalesce(o.relative_file, o.file), o.line, o.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as OrmUsageRow[];

    const iblockUsageRows = db.prepare(`
      SELECT i.id, i.file_id, i.kind, i.root, i.iblock_id, i.api, i.file, i.relative_file, i.line, i.signature, i.context_type, i.context_name, i.component
      FROM iblock_usages i
      JOIN files f ON f.id = i.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(i.relative_file, char(92), '/') IN (${placeholders}) OR replace(i.file, char(92), '/') IN (${placeholders})
      ORDER BY coalesce(i.relative_file, i.file), i.line, i.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as IblockUsageRow[];

    const hlblockUsageRows = db.prepare(`
      SELECT h.id, h.file_id, h.kind, h.root, h.hlblock_id, h.api, h.file, h.relative_file, h.line, h.signature, h.context_type, h.context_name
      FROM hlblock_usages h
      JOIN files f ON f.id = h.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(h.relative_file, char(92), '/') IN (${placeholders}) OR replace(h.file, char(92), '/') IN (${placeholders})
      ORDER BY coalesce(h.relative_file, h.file), h.line, h.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as HlblockUsageRow[];

    const optionUsageRows = db.prepare(`
      SELECT o.id, o.file_id, o.kind, o.root, o.module, o.name, o.operation, o.api, o.file, o.relative_file, o.line, o.signature, o.context_type, o.context_name
      FROM option_usages o
      JOIN files f ON f.id = o.file_id
      WHERE replace(f.relative_path, char(92), '/') IN (${placeholders}) OR replace(o.relative_file, char(92), '/') IN (${placeholders}) OR replace(o.file, char(92), '/') IN (${placeholders})
      ORDER BY coalesce(o.relative_file, o.file), o.line, o.id
    `).all(...normalized, ...normalized, ...normalized) as unknown as OptionUsageRow[];

    let relationRows: BitrixRelationRow[] = [];
    if (options.includeRelations !== false) {
      relationRows = db.prepare(`
        SELECT id, source_type, source_name, target_type, target_name, relation_type, file, line, module, kind, signature, metadata_json
        FROM bitrix_relations
        WHERE replace(file, char(92), '/') IN (${placeholders})
        ORDER BY file, line, id
      `).all(...normalized) as unknown as BitrixRelationRow[];
    }

    return {
      symbols: symbolRows.map(rowToSymbol),
      moduleUsages: moduleUsageRows.map(rowToModuleUsage),
      ormEntities: ormEntityRows.map(rowToOrmEntity),
      ormUsages: ormUsageRows.map(rowToOrmUsage),
      iblockUsages: iblockUsageRows.map(rowToIblockUsage),
      hlblockUsages: hlblockUsageRows.map(rowToHlblockUsage),
      optionUsages: optionUsageRows.map(rowToOptionUsage),
      relations: relationRows.map(rowToBitrixRelation)
    };
  } finally {
    db.close();
  }
}
