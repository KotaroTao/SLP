// 町丁目マスタ取得スクリプト
//
// 使い方:
//   node scripts/fetch-towns.js <市区町村コード5桁> [<市区町村コード5桁> ...] [--refresh]
//   例: node scripts/fetch-towns.js 14102
//
// 指定した市区町村の町丁目一覧（国勢調査 小地域コード・名称・代表点緯度経度）を
// data/towns/{市区町村コード}.json に保存する。
//
// データソース（ソースアダプタ方式。将来 2020年版=Geoshape等 への差し替えを想定）:
//   frogcat/japan-small-area — e-Stat 統計LOD 由来の 2015年国勢調査 小地域 GeoJSON。
//   リポジトリは MIT ライセンス、元データは e-Stat 利用規約（出典表記必要）。
//   都道府県単位ファイル: https://raw.githubusercontent.com/frogcat/japan-small-area/master/docs/{都道府県2桁}.json
//
// 注意: プロキシ経由環境では NODE_USE_ENV_PROXY=1（必要なら NODE_EXTRA_CA_CERTS も）を
// 付けて実行する。通常のネットワークではそのまま動く。

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, "data", ".cache");
const TOWNS_DIR = path.join(ROOT, "data", "towns");

// ソースアダプタ。fetchPrefecture は都道府県単位の GeoJSON FeatureCollection を返し、
// extractTowns はそこから対象市区町村の町丁目配列を取り出す。
const SOURCES = {
  frogcat: {
    id: "frogcat/japan-small-area",
    census: "平成27年国勢調査 小地域（e-Stat 統計LOD）",
    license: "MIT（リポジトリ）／政府統計の総合窓口(e-Stat)の利用規約（元データ・出典表記必要）",
    url: (prefCode) =>
      `https://raw.githubusercontent.com/frogcat/japan-small-area/master/docs/${prefCode}.json`,
    cacheFile: (prefCode) => `frogcat-${prefCode}.json`,
    extractTowns(geojson, municipalityCode) {
      const towns = [];
      let prefecture = "";
      let municipalityName = "";
      for (const feature of geojson.features) {
        // id 例: "http://data.e-stat.go.jp/lod/smallArea/g00200521/2015/S14102018001"
        const idTail = String(feature.id ?? "").split("/").pop() ?? "";
        const code = idTail.replace(/^S/, "");
        if (!code.startsWith(municipalityCode)) continue;
        if (!/^\d{9,11}$/.test(code)) continue;
        const { label, fullname } = feature.properties ?? {};
        const point = centroidOf(feature.geometry);
        if (!point) continue;
        // fullname 例: "神奈川県/横浜市/神奈川区/入江一丁目"
        const parts = String(fullname ?? "").split("/");
        if (parts.length >= 2) {
          prefecture ||= parts[0];
          municipalityName ||= parts.slice(1, -1).join("");
        }
        towns.push({
          code,
          name: label ?? parts.at(-1) ?? "",
          lat: round6(point.lat),
          lng: round6(point.lng),
        });
      }
      towns.sort((a, b) => a.code.localeCompare(b.code));
      return { towns, prefecture, municipalityName };
    },
  },
};

const SOURCE = SOURCES.frogcat;

// 面積加重のポリゴン重心（shoelace法）。MultiPolygon は各ポリゴンの外周リングを面積で加重。
// 町丁目スケールでは経緯度をそのまま平面座標として扱って実用上十分。
function centroidOf(geometry) {
  if (!geometry) return null;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  let areaSum = 0;
  let latSum = 0;
  let lngSum = 0;
  for (const polygon of polygons) {
    const ring = polygon[0]; // 外周リングのみ（穴は代表点用途では無視できる）
    if (!ring || ring.length < 3) continue;
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const cross = x1 * y2 - x2 * y1;
      a += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    if (a === 0) continue;
    const area = Math.abs(a / 2);
    areaSum += area;
    latSum += (cy / (3 * a)) * area;
    lngSum += (cx / (3 * a)) * area;
  }
  if (areaSum === 0) return null;
  return { lat: latSum / areaSum, lng: lngSum / areaSum };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

async function fetchPrefectureGeoJson(prefCode, refresh) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, SOURCE.cacheFile(prefCode));
  if (!refresh) {
    try {
      await access(cachePath);
      return JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      // キャッシュなし → ダウンロードへ
    }
  }
  const url = SOURCE.url(prefCode);
  console.log(`ダウンロード中: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`データソースの取得に失敗しました（HTTP ${res.status}）: ${url}`);
  }
  const body = await res.text();
  const geojson = JSON.parse(body);
  await writeFile(cachePath, body);
  return geojson;
}

async function fetchTowns(municipalityCode, refresh) {
  const prefCode = municipalityCode.slice(0, 2);
  const geojson = await fetchPrefectureGeoJson(prefCode, refresh);
  const { towns, prefecture, municipalityName } = SOURCE.extractTowns(
    geojson,
    municipalityCode,
  );
  if (towns.length === 0) {
    throw new Error(
      `市区町村コード ${municipalityCode} に該当する町丁目が見つかりません。` +
        `コードが正しいか（総務省 標準地域コード5桁）を確認してください。`,
    );
  }
  const out = {
    municipality: municipalityCode,
    name: municipalityName,
    prefecture,
    source: {
      dataset: SOURCE.id,
      census: SOURCE.census,
      license: SOURCE.license,
      fetched: new Date().toISOString().slice(0, 10),
    },
    towns,
  };
  await mkdir(TOWNS_DIR, { recursive: true });
  const outPath = path.join(TOWNS_DIR, `${municipalityCode}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `保存しました: data/towns/${municipalityCode}.json（${prefecture}${municipalityName}・${towns.length}町丁目）`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const codes = args.filter((a) => a !== "--refresh");
  if (codes.length === 0) {
    console.error("使い方: node scripts/fetch-towns.js <市区町村コード5桁> [...] [--refresh]");
    process.exit(1);
  }
  for (const code of codes) {
    if (!/^\d{5}$/.test(code)) {
      console.error(`市区町村コードは5桁の数字で指定してください: ${code}`);
      process.exit(1);
    }
  }
  for (const code of codes) {
    await fetchTowns(code, refresh);
  }
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
