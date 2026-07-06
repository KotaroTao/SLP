import test from "node:test";
import assert from "node:assert/strict";
import { haversineKm, overlapCodes, townsWithinRadius } from "../lib/overlap.js";

test("haversineKm: 同一点は距離0", () => {
  assert.equal(haversineKm(35.0, 139.0, 35.0, 139.0), 0);
});

test("haversineKm: 緯度1度差はおよそ111.2km", () => {
  const d = haversineKm(35.0, 139.0, 36.0, 139.0);
  assert.ok(Math.abs(d - 111.2) < 0.3, `expected ~111.2km, got ${d}`);
});

test("haversineKm: 東京駅〜横浜駅はおよそ27km", () => {
  // 東京駅 35.681236,139.767125 / 横浜駅 35.465786,139.622313
  const d = haversineKm(35.681236, 139.767125, 35.465786, 139.622313);
  assert.ok(d > 26 && d < 28.5, `expected ~27km, got ${d}`);
});

test("overlapCodes: 共通コードを重複除去・ソートして返す", () => {
  assert.deepEqual(
    overlapCodes(["b", "a", "c", "a"], ["a", "b", "x"]),
    ["a", "b"],
  );
});

test("overlapCodes: 共通なしは空配列", () => {
  assert.deepEqual(overlapCodes(["1", "2"], ["3", "4"]), []);
});

test("overlapCodes: 空集合同士は空配列", () => {
  assert.deepEqual(overlapCodes([], []), []);
});

test("townsWithinRadius: 半径内の代表点だけを返す（境界含む）", () => {
  const center = { lat: 35.489, lng: 139.649 };
  // 緯度0.001度 ≈ 0.111km を利用して距離を作る
  const towns = [
    { code: "A", lat: center.lat, lng: center.lng }, // 0km
    { code: "B", lat: center.lat + 0.008, lng: center.lng }, // ~0.89km
    { code: "C", lat: center.lat + 0.0095, lng: center.lng }, // ~1.06km
  ];
  const hit = townsWithinRadius(towns, center.lat, center.lng, 1.0);
  assert.deepEqual(hit.map((t) => t.code), ["A", "B"]);
});

test("townsWithinRadius: 半径を広げると対象が増える（既定1.0km・可変）", () => {
  const towns = [
    { code: "A", lat: 35.489, lng: 139.649 },
    { code: "C", lat: 35.489 + 0.0095, lng: 139.649 }, // ~1.06km
  ];
  assert.equal(townsWithinRadius(towns, 35.489, 139.649).length, 1);
  assert.equal(townsWithinRadius(towns, 35.489, 139.649, 2.0).length, 2);
  assert.equal(townsWithinRadius(towns, 35.489, 139.649, 0.5).length, 1);
});
