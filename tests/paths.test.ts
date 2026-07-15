import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBitrixProjectRoot, resolveRuntimePaths } from "../src/config/paths.js";

function withBitrixRootEnv<T>(value: string | undefined, callback: () => T): T {
  const previous = process.env.BITRIX_ROOT;
  if (value === undefined) {
    delete process.env.BITRIX_ROOT;
  } else {
    process.env.BITRIX_ROOT = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_ROOT;
    } else {
      process.env.BITRIX_ROOT = previous;
    }
  }
}

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bitrix-mcp-paths-"));
}

test("resolveRuntimePaths uses explicit BITRIX_ROOT", () => {
  const workspaceRoot = tempWorkspace();
  const explicitRoot = path.join(workspaceRoot, "explicit-site");
  fs.mkdirSync(path.join(workspaceRoot, "bitrix"));

  withBitrixRootEnv(explicitRoot, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, explicitRoot);
  });
});

test("resolveRuntimePaths normalizes explicit BITRIX_ROOT bitrix directory to project root", () => {
  const workspaceRoot = tempWorkspace();
  const projectRoot = path.join(workspaceRoot, "site");
  const bitrixDir = path.join(projectRoot, "bitrix");
  fs.mkdirSync(bitrixDir, { recursive: true });

  withBitrixRootEnv(bitrixDir, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, projectRoot);
  });
});

test("resolveBitrixProjectRoot normalizes a passed bitrix directory to project root", () => {
  const projectRoot = tempWorkspace();
  const bitrixDir = path.join(projectRoot, "bitrix");
  fs.mkdirSync(bitrixDir);

  assert.equal(resolveBitrixProjectRoot(bitrixDir), projectRoot);
});

test("resolveRuntimePaths uses workspace root when workspace bitrix directory exists", () => {
  const workspaceRoot = tempWorkspace();
  fs.mkdirSync(path.join(workspaceRoot, "bitrix"));

  withBitrixRootEnv(undefined, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, workspaceRoot);
  });
});

test("resolveRuntimePaths leaves bitrixRoot unset when no workspace bitrix directory exists", () => {
  const workspaceRoot = tempWorkspace();

  withBitrixRootEnv(undefined, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.bitrixRoot, undefined);
  });
});

function withDocsEnv<T>(values: { docsPaths?: string; docsDir?: string }, callback: () => T): T {
  const previousPaths = process.env.BITRIX_MCP_DOCS_PATHS;
  const previousDir = process.env.BITRIX_MCP_DOCS_DIR;
  if (values.docsPaths === undefined) {
    delete process.env.BITRIX_MCP_DOCS_PATHS;
  } else {
    process.env.BITRIX_MCP_DOCS_PATHS = values.docsPaths;
  }
  if (values.docsDir === undefined) {
    delete process.env.BITRIX_MCP_DOCS_DIR;
  } else {
    process.env.BITRIX_MCP_DOCS_DIR = values.docsDir;
  }

  try {
    return callback();
  } finally {
    if (previousPaths === undefined) {
      delete process.env.BITRIX_MCP_DOCS_PATHS;
    } else {
      process.env.BITRIX_MCP_DOCS_PATHS = previousPaths;
    }
    if (previousDir === undefined) {
      delete process.env.BITRIX_MCP_DOCS_DIR;
    } else {
      process.env.BITRIX_MCP_DOCS_DIR = previousDir;
    }
  }
}

test("resolveRuntimePaths reads BITRIX_MCP_DOCS_PATHS with path delimiter", () => {
  const workspaceRoot = tempWorkspace();
  const docsOne = path.join(workspaceRoot, "docs-one");
  const docsTwo = path.join(workspaceRoot, "docs-two");

  withDocsEnv({ docsPaths: [docsOne, docsTwo].join(path.delimiter) }, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });

    assert.equal(paths.docsDir, docsOne);
    assert.deepEqual(paths.docsPaths, [docsOne, docsTwo]);
  });
});

test("resolveRuntimePaths keeps BITRIX_MCP_DOCS_DIR compatibility", () => {
  const workspaceRoot = tempWorkspace();
  const docsDir = path.join(workspaceRoot, "legacy-docs");

  withDocsEnv({ docsDir }, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });

    assert.equal(paths.docsDir, docsDir);
    assert.deepEqual(paths.docsPaths, [docsDir]);
  });
});

function withSemanticEnv<T>(value: string | undefined, callback: () => T): T {
  const previous = process.env.BITRIX_MCP_SEMANTIC_ENABLED;
  if (value === undefined) {
    delete process.env.BITRIX_MCP_SEMANTIC_ENABLED;
  } else {
    process.env.BITRIX_MCP_SEMANTIC_ENABLED = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_MCP_SEMANTIC_ENABLED;
    } else {
      process.env.BITRIX_MCP_SEMANTIC_ENABLED = previous;
    }
  }
}

test("resolveRuntimePaths enables optional semantic mode from BITRIX_MCP_SEMANTIC_ENABLED", () => {
  const workspaceRoot = tempWorkspace();

  withSemanticEnv("true", () => {
    assert.equal(resolveRuntimePaths({ workspaceRoot }).semanticEnabled, true);
  });

  withSemanticEnv(undefined, () => {
    assert.equal(resolveRuntimePaths({ workspaceRoot }).semanticEnabled, false);
  });
});


function withOfficialDocsEnv<T>(value: string | undefined, callback: () => T): T {
  const previous = process.env.BITRIX_MCP_OFFICIAL_DOCS_ENABLED;
  if (value === undefined) {
    delete process.env.BITRIX_MCP_OFFICIAL_DOCS_ENABLED;
  } else {
    process.env.BITRIX_MCP_OFFICIAL_DOCS_ENABLED = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_MCP_OFFICIAL_DOCS_ENABLED;
    } else {
      process.env.BITRIX_MCP_OFFICIAL_DOCS_ENABLED = previous;
    }
  }
}

test("resolveRuntimePaths enables official docs indexing by default and supports opt-out", () => {
  const workspaceRoot = tempWorkspace();

  withOfficialDocsEnv(undefined, () => {
    assert.equal(resolveRuntimePaths({ workspaceRoot }).officialDocsEnabled, true);
  });

  withOfficialDocsEnv("0", () => {
    assert.equal(resolveRuntimePaths({ workspaceRoot }).officialDocsEnabled, false);
  });
});

function withDbEnv<T>(vars: Record<string, string | undefined>, callback: () => T): T {
  const keys = Object.keys(vars);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }

  try {
    return callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolveRuntimePaths gates DB access behind BITRIX_MCP_DB_ENABLED and BITRIX_MCP_DB_ALLOW_WRITE", () => {
  const workspaceRoot = tempWorkspace();

  withDbEnv({ BITRIX_MCP_DB_ENABLED: undefined, BITRIX_MCP_DB_ALLOW_WRITE: undefined }, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.dbEnabled, false);
    assert.equal(paths.dbAllowWrite, false);
  });

  withDbEnv({ BITRIX_MCP_DB_ENABLED: "1", BITRIX_MCP_DB_ALLOW_WRITE: undefined }, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.dbEnabled, true);
    assert.equal(paths.dbAllowWrite, false);
  });

  withDbEnv({ BITRIX_MCP_DB_ENABLED: "true", BITRIX_MCP_DB_ALLOW_WRITE: "yes" }, () => {
    const paths = resolveRuntimePaths({ workspaceRoot });
    assert.equal(paths.dbEnabled, true);
    assert.equal(paths.dbAllowWrite, true);
  });
});
