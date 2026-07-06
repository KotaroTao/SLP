import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../scripts/build.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sha256Hex: 既知ベクトルと一致する", () => {
  // echo -n "test" | sha256sum
  assert.equal(
    sha256Hex("test"),
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  );
});

test("sha256Hex: 町丁目コードのハッシュが taken.json と照合できる", async () => {
  const contracts = JSON.parse(
    await readFile(path.join(ROOT, "data", "contracts.json"), "utf8"),
  );
  const taken = JSON.parse(
    await readFile(path.join(ROOT, "public", "data", "taken.json"), "utf8"),
  );
  const hashSet = new Set(taken.hashes);
  const activeCodes = contracts.contracts
    .filter((c) => c.status === "active")
    .flatMap((c) => c.towns);
  assert.ok(activeCodes.length > 0, "activeな契約の町丁目がフィクスチャに必要");
  for (const code of activeCodes) {
    assert.ok(hashSet.has(sha256Hex(code)), `${code} のハッシュが taken.json にない`);
  }
  // 確保されていないコードは照合に失敗する（チェッカーの「募集中」判定に相当）
  assert.ok(!hashSet.has(sha256Hex("28206000000")), "未確保コードが taken.json に含まれてはいけない");
});
