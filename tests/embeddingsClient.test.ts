import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { EmbeddingsClient } from "../src/search/embeddingsClient.js";

async function withServer(handler: http.RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("EmbeddingsClient sends the bearer token and returns search hits without an extra health call", async () => {
  const seen: string[] = [];
  await withServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: [{ id: "a", score: 0.9, text: "hello", metadata: {} }] }));
  }, async (url) => {
    const hits = await new EmbeddingsClient(url, "secret").search("hello", 3);
    assert.equal(hits[0]?.id, "a");
    assert.deepEqual(seen, ["POST /search Bearer secret"]);
  });
});

test("EmbeddingsClient reports unreachable services and HTTP errors clearly", async () => {
  await assert.rejects(new EmbeddingsClient("http://127.0.0.1:9").health(), /unreachable \(\/health\)/);
  await withServer((_request, response) => {
    response.statusCode = 409;
    response.end("model mismatch");
  }, async (url) => {
    await assert.rejects(new EmbeddingsClient(url).search("x"), /\/search failed: 409 model mismatch/);
  });
});
