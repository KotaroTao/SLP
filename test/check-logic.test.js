import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../scripts/build.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// slp_check.html の純ロジックブロック（<script id="slp-logic">）を抽出して
// DOM なしの vm コンテキストで評価する。ここが失敗する＝ロジックがDOMに依存している。
async function loadLogic() {
  const html = await readFile(path.join(ROOT, "public", "slp_check.html"), "utf8");
  const m = html.match(/<script id="slp-logic">([\s\S]*?)<\/script>/);
  assert.ok(m, "slp_check.html に <script id=\"slp-logic\"> ブロックがない");
  const context = vm.createContext({});
  vm.runInContext(m[1], context);
  return context;
}

test("slp-logic: haversineKm が lib/overlap.js と同じ結果を返す", async () => {
  const logic = await loadLogic();
  const { haversineKm } = await import("../lib/overlap.js");
  const cases = [
    [35.681236, 139.767125, 35.465786, 139.622313],
    [35.0, 139.0, 35.0, 139.0],
    [34.7279, 135.3033, 35.4876, 139.6492],
  ];
  for (const [a, b, c, d] of cases) {
    assert.equal(logic.haversineKm(a, b, c, d), haversineKm(a, b, c, d));
  }
});

test("slp-logic: judge の3段階判定と境界（0件・50%・過半）", async () => {
  const { judge } = await loadLogic();
  const taken = new Set(["h1", "h2", "h3"]);

  // 重複ゼロ → open
  assert.equal(judge(["a", "b"], ["x", "y"], taken).level, "open");
  // 一部重複（50%ちょうどは partial）
  const half = judge(["a", "b"], ["h1", "y"], taken);
  assert.equal(half.level, "partial");
  assert.equal(half.ratio, 0.5);
  // 過半（50%超）→ taken
  const most = judge(["a", "b", "c"], ["h1", "h2", "y"], taken);
  assert.equal(most.level, "taken");
  assert.ok(most.ratio > 0.5);
  // 全部重複 → taken
  assert.equal(judge(["a"], ["h1"], taken).level, "taken");
  // 円内に町丁目なし → nodata
  assert.equal(judge([], [], taken).level, "nodata");
});

test("slp-logic: matchMunicipality は都道府県一致を優先し、未整備は null", async () => {
  const { matchMunicipality } = await loadLogic();
  const index = [
    { code: "14102", prefecture: "神奈川県", name: "横浜市神奈川区" },
    { code: "28206", prefecture: "兵庫県", name: "芦屋市" },
    { code: "13206", prefecture: "東京都", name: "府中市" },
    { code: "34208", prefecture: "広島県", name: "府中市" },
  ];
  assert.equal(
    matchMunicipality("神奈川県横浜市神奈川区入江一丁目１３－２５", index)?.code,
    "14102",
  );
  assert.equal(matchMunicipality("兵庫県芦屋市朝日ケ丘町１", index)?.code, "28206");
  // 同名市は都道府県で判別
  assert.equal(matchMunicipality("広島県府中市府川町", index)?.code, "34208");
  // 未整備の市区町村
  assert.equal(matchMunicipality("大阪府大阪市北区梅田１丁目", index), null);
  assert.equal(matchMunicipality("", index), null);
});

test("slp-logic: pickMunicipalitiesForCircle は円と交差するbboxだけ返す", async () => {
  const { pickMunicipalitiesForCircle } = await loadLogic();
  const index = [
    {
      code: "14102",
      bbox: { minLat: 35.46, maxLat: 35.51, minLng: 139.6, maxLng: 139.66 },
    },
    {
      code: "28206",
      bbox: { minLat: 34.71, maxLat: 34.76, minLng: 135.28, maxLng: 135.32 },
    },
  ];
  // 入江付近の円は神奈川区のみ
  assert.deepEqual(pickMunicipalitiesForCircle(index, 35.4893, 139.6489, 2.0), ["14102"]);
  // 芦屋市中心は芦屋市のみ
  assert.deepEqual(pickMunicipalitiesForCircle(index, 34.7279, 135.3033, 2.0), ["28206"]);
  // どちらにも遠い点（東京駅）は空
  assert.deepEqual(pickMunicipalitiesForCircle(index, 35.6812, 139.7671, 2.0), []);
  // bboxの外側でも半径分の近傍なら交差扱い（bbox北端から約1km）
  assert.deepEqual(pickMunicipalitiesForCircle(index, 35.519, 139.63, 2.0), ["14102"]);
});

// --- 実データでの結合テスト（受け入れ条件そのもの） ---

test("実データ: 入江1丁目付近は重複あり系（partial/taken）、芦屋市は open", async () => {
  const logic = await loadLogic();
  const taken = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "taken.json"), "utf8"),
  );
  const takenSet = new Set(taken.hashes);
  const index = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "towns", "index.json"), "utf8"),
  ).municipalities;

  async function judgeAt(lat, lng, radiusKm) {
    const codes = logic.pickMunicipalitiesForCircle(index, lat, lng, radiusKm);
    const towns = [];
    for (const code of codes) {
      const master = JSON.parse(
        await readFile(path.join(ROOT, "public", "data", "towns", `${code}.json`), "utf8"),
      );
      towns.push(...master.towns);
    }
    const inCircle = logic.townsWithinRadius(towns, lat, lng, radiusKm);
    const hashes = inCircle.map((t) => sha256Hex(t.code));
    return logic.judge(inCircle.map((t) => t.code), hashes, takenSet);
  }

  // 横浜市神奈川区入江1-13-25 付近（入江一丁目代表点近傍）→ 重複あり系
  const irie = await judgeAt(35.4876, 139.6492, 1.0);
  assert.ok(
    irie.level === "taken" || irie.level === "partial",
    `入江付近は重複あり系のはずが ${irie.level}`,
  );
  assert.ok(irie.takenCount > 0);

  // 芦屋市役所付近 → open（募集中）
  const ashiya = await judgeAt(34.7279, 135.3033, 1.0);
  assert.equal(ashiya.level, "open", `芦屋市は open のはずが ${ashiya.level}`);
  assert.ok(ashiya.totalCount > 0, "芦屋市の円内に町丁目があるはず");
});
