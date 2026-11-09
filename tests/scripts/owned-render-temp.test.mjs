import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withOwnedRenderTemp } from "../../scripts/content/owned-render-temp.mjs";

test("render jobs isolate and retain output after success and failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-render-test-"));
  try {
    const prior = path.join(root, "variant-subject-1.png");
    fs.writeFileSync(prior, "existing work");
    let job;
    await withOwnedRenderTemp(root, async (dir) => {
      job = dir;
      fs.writeFileSync(path.join(dir, "subject.png"), "temporary");
      fs.writeFileSync(path.join(dir, "mark.svg"), "temporary");
    });
    assert.equal(fs.readFileSync(path.join(job, "subject.png"), "utf8"), "temporary");
    await assert.rejects(withOwnedRenderTemp(root, async (dir) => {
      job = dir;
      fs.writeFileSync(path.join(dir, "front.webp"), "temporary");
      throw new Error("render failed");
    }), /render failed/);
    assert.equal(fs.readFileSync(path.join(job, "front.webp"), "utf8"), "temporary");
    assert.equal(fs.readFileSync(prior, "utf8"), "existing work");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("actual worker reports completed and failed jobs accurately while retaining output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-worker-test-"));
  try {
    const tmp = path.join(root, ".foilbury", "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "v-subject-1.png"), "existing work");
    const loader = path.join(root, "loader.mjs");
    fs.writeFileSync(loader, `
      const api = ${JSON.stringify(`
        import fs from 'node:fs';
        let listed = false;
        globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
        export const BASE_URL = 'http://invalid.local';
        export const agentToken = () => 'test';
        export const accessHeaders = () => ({});
        export async function apiJson(url) {
          if (url.includes('/cards?')) return {items: []};
          if (url.includes('/jobs?')) return {items: listed ? [] : (listed = true, [{id:'j'}])};
          if (url.endsWith('/claim')) return {job: {attempts: 1, payload: {variant_id:'v', card_id:'c', card_slug:'s', card_name:'n', subject_asset_id:'a', material_key:'m'}}};
          if (url.endsWith('/fail')) fs.writeFileSync('fail-called', 'yes');
          return {};
        }
        export async function apiForm() {}
      `)};
      const compose = ${JSON.stringify(`
        import fs from 'node:fs';
        export async function composeCard({outputPath}) {
          fs.writeFileSync(outputPath, 'output');
          if (process.env.FIXTURE_FAIL === '1') throw new Error('injected failure');
        }
        export async function composeCardBack() {}
      `)};
      export async function resolve(specifier, context, next) {
        if (specifier.endsWith('/art/compose.mjs')) return {url:'data:text/javascript,' + encodeURIComponent(compose), shortCircuit:true};
        if (specifier.endsWith('/lib/api.mjs')) return {url:'data:text/javascript,' + encodeURIComponent(api), shortCircuit:true};
        return next(specifier, context);
      }
    `);
    const worker = fileURLToPath(new URL("../../scripts/content/render-worker.mjs", import.meta.url));
    for (const fail of [false, true]) {
      const run = spawnSync(process.execPath, ["--experimental-loader", loader, worker, "--json"], {
        cwd: root, env: { ...process.env, FIXTURE_FAIL: fail ? "1" : "0" }, encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout.trim());
      assert.equal(result.rendered, fail ? 0 : 1);
      assert.equal(result.failed, fail ? 1 : 0);
      const dirs = fs.readdirSync(tmp).filter((name) => name.startsWith("render-job-"));
      assert.equal(dirs.length, fail ? 2 : 1);
      for (const dir of dirs) assert.deepEqual(fs.readdirSync(path.join(tmp, dir)).sort(), ["front.webp", "subject.png"]);
      assert.equal(fs.existsSync(path.join(root, "fail-called")), fail);
      assert.equal(fs.readFileSync(path.join(tmp, "v-subject-1.png"), "utf8"), "existing work");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a replacement installed before return is preserved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-swap-test-"));
  try {
    let directory;
    await withOwnedRenderTemp(root, async (dir) => {
      directory = dir;
      const file = path.join(dir, "front.webp");
      fs.writeFileSync(file, "original");
      fs.renameSync(file, path.join(dir, "original.webp"));
      fs.writeFileSync(file, "replacement");
    });
    assert.equal(fs.readFileSync(path.join(directory, "front.webp"), "utf8"), "replacement");
    assert.equal(fs.readFileSync(path.join(directory, "original.webp"), "utf8"), "original");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unexpected files and symlinks are retained without touching their targets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-render-test-"));
  try {
    const target = path.join(root, "preserve.png");
    fs.writeFileSync(target, "preserve");
    let job;
    await withOwnedRenderTemp(root, async (dir) => {
      job = dir;
      fs.symlinkSync(target, path.join(dir, "subject.png"));
      fs.writeFileSync(path.join(dir, "unexpected.txt"), "evidence");
      fs.writeFileSync(path.join(dir, "front.webp"), "unrecorded partial output");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "preserve");
    assert.equal(fs.readFileSync(path.join(job, "unexpected.txt"), "utf8"), "evidence");
    assert.equal(fs.readFileSync(path.join(job, "front.webp"), "utf8"), "unrecorded partial output");
    assert.equal(fs.lstatSync(path.join(job, "subject.png")).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
