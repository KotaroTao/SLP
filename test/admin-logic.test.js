import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadMasters } from "../scripts/build.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// slp_admin.html の純ロジックブロックを DOM なしの vm コンテキストで評価する。
// WebCrypto と TextEncoder は Node のグローバル実装を注入する。
async function loadLogic() {
  const html = await readFile(path.join(ROOT, "public", "slp_admin.html"), "utf8");
  const m = html.match(/<script id="slp-admin-logic">([\s\S]*?)<\/script>/);
  assert.ok(m, "slp_admin.html に <script id=\"slp-admin-logic\"> ブロックがない");
  const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder });
  vm.runInContext(m[1], context);
  return context;
}

async function loadFixture() {
  const data = JSON.parse(await readFile(path.join(ROOT, "data", "contracts.json"), "utf8"));
  const masters = await loadMasters(data.contracts, path.join(ROOT, "data", "towns"));
  return { data, masters };
}

// vm コンテキスト内で生成されたオブジェクトはプロトタイプが別レルムのため、
// deepEqual（strict）に通す前に JSON 往復で素のオブジェクトへ正規化する
const plain = (value) => JSON.parse(JSON.stringify(value));

test("admin-logic: 実フィクスチャで build.js の生成物（taken/summary）と完全一致する", async () => {
  const logic = await loadLogic();
  const { data, masters } = await loadFixture();

  const taken = await logic.generateTaken(data);
  const expectedTaken = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "taken.json"), "utf8"),
  );
  assert.deepEqual(plain(taken), expectedTaken, "taken.json が build.js と一致しない");

  const summary = logic.generateSummary(data, masters);
  const expectedSummary = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "summary.json"), "utf8"),
  );
  assert.deepEqual(plain(summary), expectedSummary, "summary.json が build.js と一致しない");
});

test("admin-logic: validateContracts が実フィクスチャでエラーなし・重複を検出する", async () => {
  const logic = await loadLogic();
  const { data, masters } = await loadFixture();
  assert.deepEqual(plain(logic.validateContracts(data, masters)), []);

  const dup = structuredClone(data);
  dup.contracts.push({
    id: "SLP-0002",
    clinic: "テスト医院",
    status: "active",
    municipality: dup.contracts[0].municipality,
    towns: [dup.contracts[0].towns[0]],
  });
  const errors = logic.validateContracts(dup, masters);
  assert.ok(errors.some((e) => e.includes("契約重複") && e.includes("SLP-0001") && e.includes("SLP-0002")));
});

test("admin-logic: OFF（pending）にすると taken/summary から消える＝募集中扱い", async () => {
  const logic = await loadLogic();
  const { data, masters } = await loadFixture();
  const off = structuredClone(data);
  for (const c of off.contracts) c.status = "pending";
  const taken = await logic.generateTaken(off);
  assert.deepEqual(plain(taken.hashes), []);
  const summary = logic.generateSummary(off, masters);
  assert.deepEqual(plain(summary.municipalities), []);
});

test("admin-logic: nextContractId は SLP-0001 形式で採番する", async () => {
  const logic = await loadLogic();
  assert.equal(logic.nextContractId([]), "SLP-0001");
  assert.equal(logic.nextContractId([{ id: "SLP-0001" }, { id: "SLP-0007" }]), "SLP-0008");
  assert.equal(logic.nextContractId([{ id: "壊れたID" }]), "SLP-0001");
});

test("admin-logic: findConflicts が ended 以外との衝突だけを列挙する", async () => {
  const logic = await loadLogic();
  const { data, masters } = await loadFixture();
  const candidate = [data.contracts[0].towns[0], "28206999999"];

  const conflicts = logic.findConflicts(candidate, data.contracts, masters);
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].includes(data.contracts[0].clinic));

  const endedData = structuredClone(data);
  for (const c of endedData.contracts) c.status = "ended";
  assert.deepEqual(plain(logic.findConflicts(candidate, endedData.contracts, masters)), []);

  assert.deepEqual(plain(logic.findConflicts(["28206999999"], data.contracts, masters)), []);
});

test("admin-logic: haversine/townsWithinRadius がチェッカーと同一実装", async () => {
  const logic = await loadLogic();
  const { haversineKm } = await import("../lib/overlap.js");
  assert.equal(
    logic.haversineKm(35.681236, 139.767125, 35.465786, 139.622313),
    haversineKm(35.681236, 139.767125, 35.465786, 139.622313),
  );
});
