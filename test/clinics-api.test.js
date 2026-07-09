import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
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
// api.php プロキシが匿名化して医院特定情報を落とすことを検証するために使う。
const UPSTREAM_SAMPLE = {
  generatedAt: "2026-07-09T06:41:32.456Z",
  count: 1,
  clinics: [
    {
      id: "abc123",
      name: "○○歯科医院",
      postalCode: "1700003",
      address: "東京都豊島区駒込1-2-3 ○○ビル2F",
      subscriptionStatus: "active",
      isActive: true,
      deliveryAreas: [
        {
          prefecture: "東京都",
          city: "豊島区",
          area: "駒込１丁目",
          fullAddress: "東京都豊島区駒込１丁目",
          lat: 35.7382,
          lon: 139.747,
          count: 2200,
        },
      ],
    },
  ],
};

// api.php だけの隔離 docroot（実ファイルを汚さない）
function setupDocroot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slp-clinics-test-"));
  mkdirSync(path.join(tmp, "data", "towns"), { recursive: true });
  cpSync(path.join(ROOT, "public", "api.php"), path.join(tmp, "api.php"));
  return tmp;
}

// 上流スタブを起動し、受信した X-API-Key を記録する
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
const NO_PROXY_ENV = {
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  NO_PROXY: "*",
  no_proxy: "*",
};

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
  return { php, base };
}

// ペイロードのどこにも医院特定情報が現れないことを保証する
function assertNoClinicIdentity(payload) {
  const json = JSON.stringify(payload);
  for (const leaked of ["○○歯科医院", "abc123", "1700003", "○○ビル", "subscriptionStatus"]) {
    assert.ok(!json.includes(leaked), `匿名化漏れ: ${leaked} が含まれています`);
  }
}

test("api.php: 公開API（action=clinics）プロキシ", { skip: !hasPhp }, async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const { php, base } = await startPhp(8943, {
    PUBLIC_AREAS_API_KEY: "test-upstream-key",
    PUBLIC_AREAS_API_URL: upstream.url,
  });
  t.after(() => php.kill());

  await t.test("既定は匿名化した配布エリアのみ返す（医院名等は出ない）", async () => {
    const res = await fetch(`${base}?action=clinics`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.clinicCount, 1);
    assert.equal(payload.areaCount, 1);
    assert.equal(payload.areas.length, 1);
    const a = payload.areas[0];
    assert.equal(a.prefecture, "東京都");
    assert.equal(a.city, "豊島区");
    assert.equal(a.area, "駒込１丁目");
    assert.equal(a.count, 2200);
    assert.equal(a.lat, 35.7382);
    assertNoClinicIdentity(payload);
  });

  await t.test("APIキーはサーバー側で付与され上流に届く", async () => {
    await fetch(`${base}?action=clinics`);
    assert.equal(upstream.received.apiKey, "test-upstream-key");
  });

  await t.test("公開レスポンスは5分キャッシュ可能", async () => {
    const res = await fetch(`${base}?action=clinics`);
    assert.match(res.headers.get("cache-control") ?? "", /max-age=300/);
  });

  await t.test("GET 以外は 405", async () => {
    const res = await fetch(`${base}?action=clinics`, { method: "POST" });
    assert.equal(res.status, 405);
  });

  await t.test("full=1 は管理者ヘッダなしだと 403", async () => {
    const res = await fetch(`${base}?action=clinics&full=1`);
    assert.equal(res.status, 403);
  });

  await t.test("full=1 は未ログインだと 401", async () => {
    const res = await fetch(`${base}?action=clinics&full=1`, { headers: { "X-SLP-Admin": "1" } });
    assert.equal(res.status, 401);
  });

  await t.test("full=1 はログイン後に医院名込みの生データを返す", async () => {
    let cookie = "";
    const login = await fetch(`${base}?action=login`, {
      method: "POST",
      headers: { "X-SLP-Admin": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "01smile0511" }),
    });
    assert.equal(login.status, 200);
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const res = await fetch(`${base}?action=clinics&full=1`, {
      headers: { "X-SLP-Admin": "1", Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.clinics[0].name, "○○歯科医院");
    assert.equal(payload.clinics[0].deliveryAreas[0].count, 2200);
  });
});

test("api.php: 公開API未設定時は 503", { skip: !hasPhp }, async (t) => {
  // PUBLIC_AREAS_API_KEY を敢えて空で起動する
  const { php, base } = await startPhp(8944, { PUBLIC_AREAS_API_KEY: "" });
  t.after(() => php.kill());

  await t.test("キー未設定なら 503", async () => {
    const res = await fetch(`${base}?action=clinics`);
    assert.equal(res.status, 503);
  });
});
