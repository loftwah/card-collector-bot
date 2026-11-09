import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

test("CLI sends only the chosen exact record to an isolated localhost endpoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "foilbury-import-fixture-"));
  const record = { slug: "gonta-gokuhara", logical_id: "danganronpa:gonta-gokuhara", name: "Gonta Gokuhara", description: "fixture" };
  await writeFile(path.join(dir, "danganronpa.json"), JSON.stringify({ collection: { slug: "danganronpa-three-games" }, cards: [record, { slug: "other" }] }));
  let received;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, cookie: req.headers.cookie, csrf: req.headers["x-foilbury-csrf"], body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "fixture", status: "draft" }));
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const child = spawn(process.execPath, ["scripts/content/import-local-subject-draft.mjs", "--manifest-dir", dir, "--subject", record.slug, "--apply"], { env: { ...process.env, FOILBURY_LOCAL_PORT: String(port), FOILBURY_LOCAL_COOKIE: "fixture=secret", FOILBURY_LOCAL_CSRF: "fixture-csrf" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
    const exit = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exit, 0, output);
    assert.equal(received.path, "/api/v1/admin/local-subject-drafts");
    assert.equal(received.cookie, "fixture=secret"); assert.equal(received.csrf, "fixture-csrf");
    assert.deepEqual(JSON.parse(received.body.recordJson), record);
    assert.equal(received.body.sha256, createHash("sha256").update(received.body.recordJson).digest("hex"));
    assert.doesNotMatch(output, /fixture=secret|fixture-csrf/);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
