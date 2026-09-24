import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RuntimePaths } from "../src/config/paths.js";

const fixtureRoot = path.resolve("tests/fixtures/project");

function runtimePaths(): RuntimePaths {
  return {
    workspaceRoot: fixtureRoot,
    dataDir: path.join(os.tmpdir(), "bitrix-mcp-annotations-test-data"),
    docsDir: path.join(fixtureRoot, "docs"),
    docsPaths: [path.join(fixtureRoot, "docs")],
    embeddingsUrl: "http://127.0.0.1:8765",
    semanticEnabled: false,
    dbEnabled: true,
    dbAllowWrite: true,
    tinkerEnabled: true,
    phpBin: "php"
  };
}

async function connect(answer?: "decline" | "accept-false"): Promise<Client> {
  const server = createMcpServer(runtimePaths());
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: answer ? { elicitation: {} } : {} });
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async () => (answer === "decline" ? { action: "decline" } : { action: "accept", content: { confirm: false } }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("tools advertise read-only and destructive annotations", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    assert.equal(byName.get("bitrix_liveapi_search")?.readOnlyHint, true);
    assert.equal(byName.get("bitrix_db_query")?.readOnlyHint, true);
    assert.equal(byName.get("bitrix_index")?.readOnlyHint, false);
    assert.equal(byName.get("bitrix_index")?.destructiveHint, false);
    assert.equal(byName.get("bitrix_tinker")?.destructiveHint, true);
    assert.equal(byName.get("bitrix_db_execute")?.destructiveHint, true);
    assert.ok(tools.every((tool) => tool.annotations !== undefined));
  } finally {
    await client.close();
  }
});

for (const answer of ["decline", "accept-false"] as const) {
  test(`bitrix_tinker does not run when the user answers ${answer} to the confirmation`, async () => {
    const client = await connect(answer);
    try {
      const result = await client.callTool({ name: "bitrix_tinker", arguments: { code: "return 1;" } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /did not approve/);
    } finally {
      await client.close();
    }
  });
}
