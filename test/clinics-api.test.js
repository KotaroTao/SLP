import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
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

// 上流 publicClinicAreas の代役スタブ（医院名込みの生レスポンスを返す）。
// api.php が匿名化して医院特定情報を落とすこと・保存できることを検証するために使う。
const UPSTREAM_SAMPLE = {
  generatedAt: "2026-07-09T06:41:32.456Z",
  count: 2,
  clinics: [
    {
      id: "abc123",
      name: "○○歯科医院",
      postalCode: "1700003",
      address: "東京都豊島区駒込1-2-3 ○○ビル2F",
      subscriptionStatus: "active",
      isActive: true,
      deliveryAreas: [
        { prefecture: "東京都", city: "豊島区", area: "駒込１丁目", fullAddress: "東京都豊島区駒込１丁目", lat: 35.7382, lon: 139.747, count: 2200 },
        { prefecture: "東京都", city: "豊島区", area: "駒込２丁目", fullAddress: "東京都豊島区駒込２丁目", lat: 35.74, lon: 139.75, count: 800 },
      ],
    },
    {
      id: "def456",
      name: "スマイル歯科",
      postalCode: "2310001",
      address: "横浜市中区1-1",
      subscriptionStatus: "legacy",
      isActive: true,
      deliveryAreas: [
        { prefecture: "神奈川県", city: "横浜市中区", area: "本町", fullAddress: "神奈川県横浜市中区本町", lat: 35.44, lon: 139.63, count: 500 },
      ],
    },
  ],
};

function setupDocroot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slp-clinics-test-"));
  mkdirSync(path.join(tmp, "data", "towns"), { recursive: true });
  cpSync(path.join(ROOT, "public", "api.php"), path.join(tmp, "api.php"));
  return tmp;
}

function startUpstream() {
  const received = { apiKey: null, hits: 0 };
  const server = http.createServer((req, res) => {
    received.hits++;
    received.apiKey = req.headers["x-api-key"] ?? null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(UPSTREAM_SAMPLE));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/`, received });
    });
  });
}

// localhost スタブへ確実に直結させるためプロキシ系の環境変数を無効化して起動する
const NO_PROXY_ENV = { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NO_PROXY: "*", no_proxy: "*" };

async function startPhp(port, extraEnv) {
  const docroot = setupDocroot();
  const php = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", docroot], {
    stdio: "ignore",
    env: { ...process.env, ...NO_PROXY_ENV, ...extraEnv },
  });
  const base = `http://127.0.0.1:${port}/api.php`;
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${base}?action=ping`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { php, base, docroot };
}

// 医院特定情報がどこにも現れないことを保証する
function assertNoClinicIdentity(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  for (const leaked of ["○○歯科医院", "スマイル歯科", "abc123", "def456", "1700003", "○○ビル", "subscriptionStatus"]) {
    assert.ok(!json.includes(leaked), `匿名化漏れ: ${leaked} が含まれています`);
  }
}

test("api.php: 参加医院データベース（clinics_save / clinics）", { skip: !hasPhp }, async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const { php, base, docroot } = await startPhp(8943, {
    PUBLIC_AREAS_API_KEY: "test-upstream-key",
    PUBLIC_AREAS_API_URL: upstream.url,
  });
  t.after(() => php.kill());

  let cookie = "";
  async function call(action, { method = "GET", admin = false, body } = {}) {
    const res = await fetch(`${base}?action=${action}`, {
      method,
      headers: {
        ...(admin ? { "X-SLP-Admin": "1" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let payload = null;
    try { payload = await res.json(); } catch { /* 非JSON */ }
    return { status: res.status, payload, cacheControl: res.headers.get("cache-control") };
  }

  await t.test("保存前は stored:false（匿名・空）", async () => {
    const { status, payload, cacheControl } = await call("clinics");
    assert.equal(status, 200);
    assert.equal(payload.stored, false);
    assert.deepEqual(payload.areas, []);
    assert.match(cacheControl ?? "", /max-age=300/);
  });

  await t.test("clinics_save は管理者ヘッダなしだと 403", async () => {
    const { status } = await call("clinics_save", { method: "POST", body: {} });
    assert.equal(status, 403);
  });

  await t.test("clinics_save は未ログインだと 401", async () => {
    const { status } = await call("clinics_save", { method: "POST", admin: true, body: {} });
    assert.equal(status, 401);
  });

  await t.test("clinics_save は GET だと 405", async () => {
    await call("login", { method: "POST", admin: true, body: { password: "01smile0511" } });
    const { status } = await call("clinics_save", { method: "GET", admin: true });
    assert.equal(status, 405);
  });

  await t.test("ログイン後 clinics_save で取り込み・保存できる", async () => {
    const { status, payload } = await call("clinics_save", { method: "POST", admin: true, body: {} });
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.count, 2);
    assert.ok(payload.savedAt);
    // 上流にサーバー側のキーが届いている
    assert.equal(upstream.received.apiKey, "test-upstream-key");
    // 保存ファイルが生成される
    assert.ok(existsSync(path.join(docroot, "private", "clinics.json")), "private/clinics.json が無い");
    assert.ok(existsSync(path.join(docroot, "data", "clinics.json")), "data/clinics.json（匿名版）が無い");
  });

  await t.test("data/clinics.json（公開・匿名版）に医院名が含まれない", () => {
    const raw = readFileSync(path.join(docroot, "data", "clinics.json"), "utf8");
    assertNoClinicIdentity(raw);
    const anon = JSON.parse(raw);
    assert.equal(anon.areaCount, 3);
  });

  await t.test("private/clinics.json（原本）には医院名が保存される", () => {
    const rec = JSON.parse(readFileSync(path.join(docroot, "private", "clinics.json"), "utf8"));
    assert.equal(rec.clinics[0].name, "○○歯科医院");
    assert.ok(rec.savedAt);
  });

  await t.test("GET clinics（既定）は保存済みの匿名データを返す（医院名なし）", async () => {
    const { status, payload, cacheControl } = await call("clinics");
    assert.equal(status, 200);
    assert.equal(payload.stored, true);
    assert.equal(payload.areaCount, 3);
    assert.equal(payload.clinicCount, 2);
    assert.match(cacheControl ?? "", /max-age=300/);
    assertNoClinicIdentity(payload);
  });

  await t.test("GET clinics&full=1（管理者）は医院名込みの保存データを返す", async () => {
    const { status, payload } = await call("clinics&full=1", { admin: true });
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.stored, true);
    assert.equal(payload.count, 2);
    assert.equal(payload.clinics[0].name, "○○歯科医院");
  });

  await t.test("full=1 は管理者ヘッダなしだと 403、未ログイン相当は 401", async () => {
    const noHeader = await fetch(`${base}?action=clinics&full=1`);
    assert.equal(noHeader.status, 403);
  });
});

test("api.php: clinics_save はキー未設定だと 503", { skip: !hasPhp }, async (t) => {
  const { php, base } = await startPhp(8944, { PUBLIC_AREAS_API_KEY: "" });
  t.after(() => php.kill());
  let cookie = "";
  async function call(action, { method = "GET", body } = {}) {
    const res = await fetch(`${base}?action=${action}`, {
      method,
      headers: { "X-SLP-Admin": "1", ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status };
  }
  await call("login", { method: "POST", body: { password: "01smile0511" } });

  await t.test("キー未設定なら clinics_save は 503", async () => {
    const { status } = await call("clinics_save", { method: "POST", body: {} });
    assert.equal(status, 503);
  });
});
