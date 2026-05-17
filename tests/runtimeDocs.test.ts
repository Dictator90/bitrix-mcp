import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("runtime requirements match node:sqlite support", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8")) as { engines?: { node?: string } };
  assert.equal(packageJson.engines?.node, ">=22.12.0");
});

test("documentation does not claim Node.js 20 support", async () => {
  const files = ["README.md", "ru.README.md"];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    assert.doesNotMatch(text, /Node\.js \*\*20|Node\.js 20|20\+/u, file);
    assert.match(text, /node:sqlite/u, file);
  }
});
