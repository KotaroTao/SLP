import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// PHP が無い環境（CI等）ではスキップする
let hasPhp = true;
try {
  execFileSync("php", ["-v"], { stdio: "ignore" });
} catch {
  hasPhp = false;
}

const PORT = 8941;
const BASE = `http://127.0.0.1:${PORT}/api.php`;

// 一時docroot（api.php＋必要なtownsマスタのみ）でPHP内蔵サーバーを起動する。
// リポジトリの実ファイル（private/・data/taken等）を汚さないための隔離。
function setupDocroot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slp-api-test-"));
  mkdirSync(path.join(tmp, "data", "towns"), { recursive: true });
  cpSync(path.join(ROOT, "public", "api.php"), path.join(tmp, "api.php"));
  for (const f of ["14102.json", "28206.json", "index.json"]) {
    cpSync(path.join(ROOT, "public", "data", "towns", f), path.join(tmp, "data", "towns", f));
  }
  return tmp;
}

let cookie = "";
async function call(action, body) {
  const res = await fetch(`${BASE}?action=${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-SLP-Admin": "1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: res.status, payload: await res.json() };
}

test("api.php: 認証・保存・公開ファイル生成の一連の動作", { skip: !hasPhp }, async (t) => {
  const docroot = setupDocroot();
  const php = spawn("php", ["-S", `127.0.0.1:${PORT}`, "-t", docroot], { stdio: "ignore" });
  t.after(() => php.kill());
  // サーバー起動待ち
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}?action=ping`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const fixture = JSON.parse(readFileSync(path.join(ROOT, "data", "contracts.json"), "utf8"));

  await t.test("ping は認証不要で応答する", async () => {
    const { status, payload } = await call("ping");
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.hasData, false);
  });

  await t.test("未ログインの get / save は 401", async () => {
    assert.equal((await call("get")).status, 401);
    assert.equal((await call("save", { baseRevision: 0, data: fixture })).status, 401);
  });

  await t.test("X-SLP-Admin ヘッダなしは 403", async () => {
    const res = await fetch(`${BASE}?action=get`, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(res.status, 403);
  });

  await t.test("誤パスワードは 401、正パスワードでログインできる", async () => {
    const bad = await call("login", { password: "wrong-password" });
    assert.equal(bad.status, 401);
    const ok = await call("login", { password: "01smile0511" });
    assert.equal(ok.status, 200);
  });

  await t.test("初回 get は未初期化（revision 0・data null）", async () => {
    const { status, payload } = await call("get");
    assert.equal(status, 200);
    assert.equal(payload.revision, 0);
    assert.equal(payload.data, null);
  });

  await t.test("フィクスチャ保存 → taken/summary が scripts/build.js の生成物と完全一致", async () => {
    const { status, payload } = await call("save", { baseRevision: 0, data: fixture });
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.revision, 1);

    const taken = JSON.parse(readFileSync(path.join(docroot, "data", "taken.json"), "utf8"));
    const expectedTaken = JSON.parse(readFileSync(path.join(ROOT, "public", "data", "taken.json"), "utf8"));
    assert.deepEqual(taken, expectedTaken, "taken.json が build.js と一致しない");

    const summary = JSON.parse(readFileSync(path.join(docroot, "data", "summary.json"), "utf8"));
    const expectedSummary = JSON.parse(readFileSync(path.join(ROOT, "public", "data", "summary.json"), "utf8"));
    assert.deepEqual(summary, expectedSummary, "summary.json が build.js と一致しない");

    assert.ok(existsSync(path.join(docroot, "private", "store.json")), "store.json が保存されていない");
    assert.ok(existsSync(path.join(docroot, "private", ".htaccess")), "private/.htaccess が生成されていない");
  });

  await t.test("get で保存済みデータと revision が返る", async () => {
    const { payload } = await call("get");
    assert.equal(payload.revision, 1);
    assert.equal(payload.data.contracts[0].id, "SLP-0001");
  });

  await t.test("stale な baseRevision の保存は 409（楽観ロック）", async () => {
    const { status, payload } = await call("save", { baseRevision: 0, data: fixture });
    assert.equal(status, 409);
    assert.equal(payload.revision, 1);
  });

  await t.test("重複契約の保存は 400 で衝突を列挙", async () => {
    const dup = structuredClone(fixture);
    dup.contracts.push({
      id: "SLP-0002",
      clinic: "テスト医院",
      status: "active",
      municipality: dup.contracts[0].municipality,
      towns: [dup.contracts[0].towns[0]],
    });
    const { status, payload } = await call("save", { baseRevision: 1, data: dup });
    assert.equal(status, 400);
    assert.ok(payload.errors.some((e) => e.includes("契約重複") && e.includes("SLP-0002")));
  });

  await t.test("OFF（pending）で保存すると taken が空になる＝募集中扱い", async () => {
    const off = structuredClone(fixture);
    for (const c of off.contracts) c.status = "pending";
    const { status, payload } = await call("save", { baseRevision: 1, data: off });
    assert.equal(status, 200);
    assert.equal(payload.taken, 0);
    const taken = JSON.parse(readFileSync(path.join(docroot, "data", "taken.json"), "utf8"));
    assert.deepEqual(taken.hashes, []);
  });
});
