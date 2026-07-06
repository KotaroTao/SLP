// 重複判定モジュール
// ビルドスクリプト・ユニットテスト・後続フェーズ（チェッカー／マップ）で共用するコアロジック。
// このファイルは Node 内蔵機能のみに依存する（ブラウザ移植を想定して純粋関数で構成）。

const EARTH_RADIUS_KM = 6371.0088;

/**
 * 2点間のハーバサイン距離（km）を返す。
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * 2つの町丁目コード集合の共通コードを返す（重複除去・辞書順ソート済み）。
 * @param {Iterable<string>} codesA
 * @param {Iterable<string>} codesB
 * @returns {string[]}
 */
export function overlapCodes(codesA, codesB) {
  const setB = new Set(codesB);
  const common = new Set();
  for (const code of codesA) {
    if (setB.has(code)) common.add(code);
  }
  return [...common].sort();
}

/**
 * 中心（lat, lng）から半径 radiusKm の円内に代表点が入る町丁目を返す。
 * @param {Array<{code: string, name?: string, lat: number, lng: number}>} towns
 * @param {number} lat
 * @param {number} lng
 * @param {number} [radiusKm=1.0]
 * @returns {Array<{code: string, name?: string, lat: number, lng: number}>}
 */
export function townsWithinRadius(towns, lat, lng, radiusKm = 1.0) {
  return towns.filter((t) => haversineKm(lat, lng, t.lat, t.lng) <= radiusKm);
}
