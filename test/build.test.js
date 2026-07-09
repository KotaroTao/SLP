import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateContracts,
  generateArtifacts,
  generateTownsIndex,
  sha256Hex,
} from "../scripts/build.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// テスト用の最小マスタ（実データと同じスキーマ）
function fixtureMasters() {
  return new Map([
    [
      "14102",
      {
        municipality: "14102",
        name: "横浜市神奈川区",
        prefecture: "神奈川県",
        towns: [
          { code: "14102018001", name: "入江一丁目", lat: 35.487586, lng: 139.649227 },
          { code: "14102018002", name: "入江二丁目", lat: 35.491106, lng: 139.648521 },
          { code: "141020130", name: "神之木町", lat: 35.4926, lng: 139.6395 },
        ],
      },
    ],
  ]);
}

function baseData() {
  return {
    updated: "2026-07-06",
    contracts: [
      {
        id: "SLP-0001",
        clinic: "テスト医院",
        status: "active",
        municipality: "14102",
        towns: ["14102018001", "141020130"],
      },
    ],
  };
}

test("validateContracts: 正常データはエラーなし", () => {
  assert.deepEqual(validateContracts(baseData(), fixtureMasters()), []);
});

test("validateContracts: 形式エラーを検出する", () => {
  const data = baseData();
  data.updated = "2026/07/06";
  data.contracts[0].id = "SLP-1";
  data.contracts[0].status = "unknown";
  const errors = validateContracts(data, fixtureMasters());
  assert.ok(errors.some((e) => e.includes("YYYY-MM-DD")));
  assert.ok(errors.some((e) => e.includes("SLP-0000 形式")));
  assert.ok(errors.some((e) => e.includes("status")));
});

test("validateContracts: マスタにないコード・municipality不一致を検出する", () => {
  const data = baseData();
  data.contracts[0].towns = ["14102099999", "28206000000"];
  const errors = validateContracts(data, fixtureMasters());
  assert.ok(errors.some((e) => e.includes("14102099999") && e.includes("マスタ")));
  assert.ok(errors.some((e) => e.includes("28206000000") && e.includes("一致しません")));
});

test("validateContracts: マスタ未整備の市区町村は fetch-towns の実行を案内する", () => {
  const data = baseData();
  data.contracts[0].municipality = "28206";
  data.contracts[0].towns = ["28206000001"];
  const errors = validateContracts(data, fixtureMasters());
  assert.ok(errors.some((e) => e.includes("fetch-towns.js 28206")));
});

test("validateContracts: 契約間の町丁目重複を契約ID・コード・町名つきで列挙する", () => {
  const data = baseData();
  data.contracts.push({
    id: "SLP-0002",
    clinic: "テスト医院2",
    status: "pending",
    municipality: "14102",
    towns: ["14102018001", "14102018002"],
  });
  const errors = validateContracts(data, fixtureMasters());
  const conflict = errors.filter((e) => e.includes("契約重複"));
  assert.equal(conflict.length, 1);
  assert.ok(conflict[0].includes("SLP-0001"));
  assert.ok(conflict[0].includes("SLP-0002"));
  assert.ok(conflict[0].includes("14102018001"));
  assert.ok(conflict[0].includes("入江一丁目"));
});

test("validateContracts: ended契約は重複判定から除外する", () => {
  const data = baseData();
  data.contracts.push({
    id: "SLP-0002",
    clinic: "テスト医院2",
    status: "ended",
    municipality: "14102",
    towns: ["14102018001"],
  });
  const errors = validateContracts(data, fixtureMasters());
  assert.equal(errors.filter((e) => e.includes("契約重複")).length, 0);
});

test("validateContracts: paused契約はエリア解放のため重複判定から除外する", () => {
  const data = baseData();
  data.contracts.push({
    id: "SLP-0002",
    clinic: "テスト医院2",
    status: "paused",
    municipality: "14102",
    towns: ["14102018001"],
  });
  const errors = validateContracts(data, fixtureMasters());
  assert.equal(errors.filter((e) => e.includes("契約重複")).length, 0);
});

test("generateArtifacts: paused契約は taken/summary に含まれない（募集中扱い）", () => {
  const data = baseData();
  for (const c of data.contracts) c.status = "paused";
  const { taken, summary } = generateArtifacts(data, fixtureMasters());
  assert.equal(taken.hashes.length, 0);
  assert.equal(summary.municipalities.length, 0);
});

test("generateArtifacts: active契約のみが taken/summary に反映される", () => {
  const data = baseData();
  data.contracts.push({
    id: "SLP-0002",
    clinic: "テスト医院2",
    status: "pending",
    municipality: "14102",
    towns: ["14102018002"],
  });
  const { taken, summary, internal } = generateArtifacts(data, fixtureMasters());
  assert.equal(taken.hashes.length, 2); // SLP-0001 の2件のみ（pendingは含まない）
  assert.ok(taken.hashes.includes(sha256Hex("14102018001")));
  assert.ok(!taken.hashes.includes(sha256Hex("14102018002")));
  assert.equal(summary.municipalities[0].takenTowns, 2);
  assert.equal(internal.contracts.length, 2); // internal は全契約
});

test("generateArtifacts: ハッシュは辞書順ソートで契約のグルーピング情報を持たない", () => {
  const { taken } = generateArtifacts(baseData(), fixtureMasters());
  assert.deepEqual(taken.hashes, [...taken.hashes].sort());
});

test("generateTownsIndex: center/bbox を代表点から算出する", () => {
  const master = fixtureMasters().get("14102");
  const { municipalities } = generateTownsIndex("2026-07-06", [master]);
  assert.equal(municipalities.length, 1);
  const m = municipalities[0];
  assert.equal(m.code, "14102");
  assert.equal(m.prefecture, "神奈川県");
  assert.equal(m.name, "横浜市神奈川区");
  assert.ok(m.bbox.minLat <= m.center.lat && m.center.lat <= m.bbox.maxLat);
  assert.ok(m.bbox.minLng <= m.center.lng && m.center.lng <= m.bbox.maxLng);
  const lats = master.towns.map((t) => t.lat);
  assert.equal(m.bbox.minLat, Math.min(...lats));
  assert.equal(m.bbox.maxLat, Math.max(...lats));
});

// --- 実ファイルでの統合テスト（npm run build 相当を実行して生成物を検証） ---

test("build.js: 実フィクスチャでビルドが成功し、生成物がスキーマどおり", async () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.js")], {
    cwd: ROOT,
  });

  const taken = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "taken.json"), "utf8"),
  );
  assert.match(taken.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(taken.algo, "sha256");
  assert.ok(Array.isArray(taken.hashes) && taken.hashes.length > 0);
  for (const h of taken.hashes) assert.match(h, /^[0-9a-f]{64}$/);

  const summary = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "summary.json"), "utf8"),
  );
  assert.match(summary.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(summary.municipalities.length > 0);
  for (const m of summary.municipalities) {
    assert.match(m.code, /^\d{5}$/);
    assert.equal(typeof m.name, "string");
    assert.ok(Number.isInteger(m.takenTowns) && m.takenTowns > 0);
    assert.ok(Number.isInteger(m.totalTowns) && m.totalTowns >= m.takenTowns);
    assert.ok(m.ratio >= 0 && m.ratio <= 1);
    assert.ok(["open", "few", "closed"].includes(m.status));
  }

  const internal = JSON.parse(
    await readFile(path.join(ROOT, "internal", "data", "internal.json"), "utf8"),
  );
  assert.ok(internal.contracts.length > 0);
  for (const c of internal.contracts) {
    assert.equal(typeof c.clinic, "string");
    for (const t of c.towns) {
      assert.match(t.code, /^\d{9,11}$/);
      assert.equal(typeof t.name, "string");
      assert.equal(typeof t.lat, "number");
      assert.equal(typeof t.lng, "number");
    }
  }

  // 町丁目マスタの公開コピー＋索引（チェッカーの遅延ロード用）
  const townsIndex = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "towns", "index.json"), "utf8"),
  );
  assert.ok(townsIndex.municipalities.length >= 2, "14102 と 28206 が索引にあるはず");
  for (const m of townsIndex.municipalities) {
    assert.match(m.code, /^\d{5}$/);
    assert.equal(typeof m.prefecture, "string");
    assert.equal(typeof m.name, "string");
    assert.ok(m.bbox.minLat <= m.center.lat && m.center.lat <= m.bbox.maxLat);
    assert.ok(m.bbox.minLng <= m.center.lng && m.center.lng <= m.bbox.maxLng);
    const master = JSON.parse(
      await readFile(path.join(ROOT, "public", "data", "towns", `${m.code}.json`), "utf8"),
    );
    assert.equal(master.municipality, m.code);
    assert.ok(master.towns.length > 0);
  }
});

test("slp_map.html: 内部版・公開版が生成され、トークンが残っていない", async () => {
  const internalHtml = await readFile(path.join(ROOT, "internal", "slp_map.html"), "utf8");
  const publicHtml = await readFile(path.join(ROOT, "public", "slp_map.html"), "utf8");
  for (const [label, html] of [["internal", internalHtml], ["public", publicHtml]]) {
    assert.ok(!/__SLP_[A-Z_]+__/.test(html), `${label} 版に未置換トークンが残っている`);
    assert.ok(html.includes("geolonia-svg-map"), `${label} 版に日本地図SVGが埋め込まれていない`);
    assert.ok(html.includes('data-code="14"'), `${label} 版のSVGに神奈川県(data-code=14)がない`);
  }
  // 内部版はデータ埋め込み（file://で動く）・医院名を含む
  const contracts = JSON.parse(
    await readFile(path.join(ROOT, "data", "contracts.json"), "utf8"),
  );
  assert.ok(internalHtml.includes('const MODE = "internal"'));
  for (const c of contracts.contracts) {
    assert.ok(internalHtml.includes(c.clinic), "内部版に医院名が埋め込まれていない");
  }
  // 公開版はデータ埋め込みなし（summary.jsonをfetch）・internal.jsonを参照しない
  assert.ok(publicHtml.includes('const MODE = "public"'));
  assert.ok(publicHtml.includes("const EMBEDDED_DATA = null"));
  assert.ok(!publicHtml.includes("internal.json"), "公開版が internal.json を参照している");
});

test("public/ 配下に医院名・契約ID・生の町丁目コードが漏れていない", async () => {
  const contracts = JSON.parse(
    await readFile(path.join(ROOT, "data", "contracts.json"), "utf8"),
  );
  const allCodes = new Set(contracts.contracts.flatMap((c) => c.towns));
  for (const file of ["taken.json", "summary.json"]) {
    const raw = await readFile(path.join(ROOT, "public", "data", file), "utf8");
    // 医院名・契約IDは文字列としても出現しない
    for (const c of contracts.contracts) {
      assert.ok(!raw.includes(c.clinic), `${file} に医院名が含まれている`);
      assert.ok(!raw.includes(c.id), `${file} に契約IDが含まれている`);
    }
    // 生の町丁目コードは JSON のどの値にも exact match で存在しない
    // （ハッシュ16進文字列内の偶然の部分一致を誤検知しないよう、値単位で比較する）
    JSON.parse(raw, (key, value) => {
      assert.ok(
        !allCodes.has(String(value)),
        `${file} に生の町丁目コード ${value} が含まれている`,
      );
      return value;
    });
  }

  // 町丁目マスタの公開コピーは国勢調査由来の全件リストなので生コードを含んでよいが、
  // 医院名・契約IDは絶対に含まない。チェッカー本体HTMLも同様。
  const townsDir = path.join(ROOT, "public", "data", "towns");
  const townsFiles = (await readdir(townsDir)).map((f) => path.join(townsDir, f));
  for (const filePath of [
    ...townsFiles,
    path.join(ROOT, "public", "slp_check.html"),
    path.join(ROOT, "public", "slp_map.html"),
    path.join(ROOT, "public", "slp_admin.html"),
  ]) {
    const raw = await readFile(filePath, "utf8");
    for (const c of contracts.contracts) {
      assert.ok(!raw.includes(c.clinic), `${filePath} に医院名が含まれている`);
      assert.ok(!raw.includes(c.id), `${filePath} に契約IDが含まれている`);
    }
  }

  // 管理ページにパスワード平文が埋め込まれていない（SHA-256ハッシュのみ）
  const adminHtml = await readFile(path.join(ROOT, "public", "slp_admin.html"), "utf8");
  assert.ok(!adminHtml.includes("01smile0511"), "slp_admin.html にパスワード平文が含まれている");
});

test("build.js: 重複契約を仕込むとビルドが失敗し衝突箇所を表示する", () => {
  // validateContracts 単体でも検証済みだが、CLI として exit 1 になることを確認する。
  // 実ファイルを汚さないよう、一時ディレクトリに必要ファイルを複製して実行する。
  const tmp = mkdtempSync(path.join(os.tmpdir(), "slp-build-test-"));
  mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  mkdirSync(path.join(tmp, "data", "towns"), { recursive: true });
  cpSync(path.join(ROOT, "lib"), path.join(tmp, "lib"), { recursive: true });
  cpSync(path.join(ROOT, "scripts", "build.js"), path.join(tmp, "scripts", "build.js"));
  cpSync(
    path.join(ROOT, "data", "towns", "14102.json"),
    path.join(tmp, "data", "towns", "14102.json"),
  );
  const data = {
    updated: "2026-07-06",
    contracts: [
      {
        id: "SLP-0001",
        clinic: "テスト医院",
        status: "active",
        municipality: "14102",
        towns: ["14102018001"],
      },
      {
        id: "SLP-0002",
        clinic: "テスト医院2",
        status: "active",
        municipality: "14102",
        towns: ["14102018001"],
      },
    ],
  };
  writeFileSync(path.join(tmp, "data", "contracts.json"), JSON.stringify(data));

  let failed = false;
  let stderr = "";
  try {
    execFileSync(process.execPath, [path.join(tmp, "scripts", "build.js")], {
      cwd: tmp,
      stdio: "pipe",
    });
  } catch (err) {
    failed = true;
    stderr = String(err.stderr);
  }
  assert.ok(failed, "重複契約でビルドが失敗しなかった");
  assert.ok(stderr.includes("契約重複"));
  assert.ok(stderr.includes("SLP-0001") && stderr.includes("SLP-0002"));
  assert.ok(stderr.includes("14102018001"));
});
