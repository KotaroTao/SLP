// ビルドスクリプト
//
// data/contracts.json（真実の唯一のソース）を検証し、以下を生成する:
//   - public/data/taken.json    : active契約の全町丁目コードの SHA-256 ハッシュ配列（辞書順ソート）
//   - public/data/summary.json  : 市区町村コード別の確保町丁目数・ステータス（医院名なし）
//   - public/data/towns/*.json  : 整備済み町丁目マスタのコピー＋索引 index.json（チェッカーの遅延ロード用。
//                                 国勢調査由来の公開データのみで医院情報は含まない）
//   - internal/data/internal.json : 医院名込みの全詳細（非公開・管理用）
//
// バリデーション違反（形式エラー・マスタ不在・契約間の町丁目重複）はすべて列挙して exit 1。
// 契約間の重複検出はビルド失敗＝契約前の最終チェックとして機能する。
//
// 使い方: npm run build  （= node scripts/build.js）

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { overlapCodes } from "../lib/overlap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// summary.json のステータス閾値（確保町丁目数 ÷ 総町丁目数）。フェーズ3のマップ表示で調整可。
export const STATUS_THRESHOLDS = { few: 0.3, closed: 0.7 };

const VALID_STATUS = new Set(["active", "pending", "ended"]);

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * contracts.json の内容を検証し、エラーメッセージの配列を返す（空配列＝正常）。
 * @param {object} data contracts.json をパースしたオブジェクト
 * @param {Map<string, object>} masters 市区町村コード → data/towns/{code}.json の内容
 */
export function validateContracts(data, masters) {
  const errors = [];
  if (!data || typeof data !== "object") {
    return ["contracts.json のルートがオブジェクトではありません"];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updated ?? "")) {
    errors.push(`updated が YYYY-MM-DD 形式ではありません: ${data.updated}`);
  }
  if (!Array.isArray(data.contracts)) {
    errors.push("contracts が配列ではありません");
    return errors;
  }

  const seenIds = new Set();
  for (const c of data.contracts) {
    const label = c.id ?? "(idなし)";
    if (!/^SLP-\d{4}$/.test(c.id ?? "")) {
      errors.push(`${label}: id は SLP-0000 形式で指定してください`);
    }
    if (seenIds.has(c.id)) {
      errors.push(`${label}: id が重複しています`);
    }
    seenIds.add(c.id);
    if (typeof c.clinic !== "string" || c.clinic.trim() === "") {
      errors.push(`${label}: clinic（医院名）が未設定です`);
    }
    if (!VALID_STATUS.has(c.status)) {
      errors.push(`${label}: status は active / pending / ended のいずれかにしてください（現在: ${c.status}）`);
    }
    if (!/^\d{5}$/.test(c.municipality ?? "")) {
      errors.push(`${label}: municipality は5桁の市区町村コードで指定してください（現在: ${c.municipality}）`);
      continue;
    }
    if (!Array.isArray(c.towns) || c.towns.length === 0) {
      errors.push(`${label}: towns（町丁目コード配列）が空です`);
      continue;
    }
    const master = masters.get(c.municipality);
    if (!master) {
      errors.push(
        `${label}: 町丁目マスタ data/towns/${c.municipality}.json がありません。` +
          `先に「node scripts/fetch-towns.js ${c.municipality}」を実行してください`,
      );
      continue;
    }
    const masterCodes = new Set(master.towns.map((t) => t.code));
    const seenTowns = new Set();
    for (const code of c.towns) {
      if (!/^\d{9,11}$/.test(code)) {
        errors.push(`${label}: 町丁目コードの形式が不正です（9〜11桁の数字）: ${code}`);
        continue;
      }
      if (!code.startsWith(c.municipality)) {
        errors.push(`${label}: 町丁目コード ${code} が municipality ${c.municipality} と一致しません`);
        continue;
      }
      if (seenTowns.has(code)) {
        errors.push(`${label}: 町丁目コード ${code} が同一契約内で重複しています`);
      }
      seenTowns.add(code);
      if (!masterCodes.has(code)) {
        errors.push(`${label}: 町丁目コード ${code} がマスタ（data/towns/${c.municipality}.json）に存在しません`);
      }
    }
  }

  // 契約間の重複検出（ended 以外）。どの契約同士がどの町丁目で衝突しているかを列挙する。
  const live = data.contracts.filter((c) => c.status !== "ended" && Array.isArray(c.towns));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const common = overlapCodes(live[i].towns, live[j].towns);
      for (const code of common) {
        const master = masters.get(live[i].municipality);
        const name = master?.towns.find((t) => t.code === code)?.name ?? "";
        errors.push(
          `契約重複: ${live[i].id} と ${live[j].id} が ${code}${name ? `（${name}）` : ""} で衝突しています`,
        );
      }
    }
  }

  return errors;
}

/**
 * 検証済みの contracts データから3つの生成物を組み立てる（ファイル出力はしない）。
 * @returns {{ taken: object, summary: object, internal: object }}
 */
export function generateArtifacts(data, masters) {
  const active = data.contracts.filter((c) => c.status === "active");

  // taken.json: active契約の全町丁目コードをハッシュ化。辞書順ソートで
  // 契約単位のグルーピング・登録順の情報を消す（公開物から医院を推測させない）。
  const hashes = [...new Set(active.flatMap((c) => c.towns))]
    .map((code) => sha256Hex(code))
    .sort();
  const taken = { updated: data.updated, algo: "sha256", hashes };

  // summary.json: 市区町村コード別の集計（active のみ・医院名/契約ID/生コードなし）
  const byMunicipality = new Map();
  for (const c of active) {
    const codes = byMunicipality.get(c.municipality) ?? new Set();
    for (const code of c.towns) codes.add(code);
    byMunicipality.set(c.municipality, codes);
  }
  const municipalities = [...byMunicipality.entries()]
    .map(([code, codes]) => {
      const master = masters.get(code);
      const totalTowns = master.towns.length;
      const ratio = codes.size / totalTowns;
      const status =
        ratio < STATUS_THRESHOLDS.few ? "open" : ratio < STATUS_THRESHOLDS.closed ? "few" : "closed";
      return {
        code,
        name: `${master.prefecture}${master.name}`,
        takenTowns: codes.size,
        totalTowns,
        ratio: Math.round(ratio * 100) / 100,
        status,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  const summary = { updated: data.updated, municipalities };

  // internal.json: 医院名込み全詳細＋町丁目名・代表点を結合（内部管理・内部マップ用）
  const internal = {
    updated: data.updated,
    contracts: data.contracts.map((c) => {
      const master = masters.get(c.municipality);
      return {
        id: c.id,
        clinic: c.clinic,
        status: c.status,
        municipality: c.municipality,
        municipalityName: `${master.prefecture}${master.name}`,
        towns: c.towns.map((code) => {
          const t = master.towns.find((mt) => mt.code === code);
          return { code, name: t?.name ?? "", lat: t?.lat ?? null, lng: t?.lng ?? null };
        }),
      };
    }),
  };

  return { taken, summary, internal };
}

/** data/towns/ から、契約に登場する市区町村のマスタを読み込む（存在しないものは欠落のまま返す）。 */
export async function loadMasters(contracts, townsDir) {
  const masters = new Map();
  const codes = new Set(contracts.map((c) => c.municipality).filter((m) => /^\d{5}$/.test(m ?? "")));
  for (const code of codes) {
    try {
      const raw = await readFile(path.join(townsDir, `${code}.json`), "utf8");
      masters.set(code, JSON.parse(raw));
    } catch {
      // 欠落は validateContracts がエラーとして報告する
    }
  }
  return masters;
}

/**
 * 整備済みの全町丁目マスタから、チェッカー遅延ロード用の索引を組み立てる。
 * center/bbox は町代表点から算出（円との交差判定で「対象＋隣接分だけロード」を実現する）。
 * @param {Array<object>} allMasters data/towns/*.json の内容の配列
 */
export function generateTownsIndex(updated, allMasters) {
  const municipalities = allMasters
    .map((m) => {
      const lats = m.towns.map((t) => t.lat);
      const lngs = m.towns.map((t) => t.lng);
      const bbox = {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs),
      };
      return {
        code: m.municipality,
        prefecture: m.prefecture,
        name: m.name,
        center: {
          lat: Math.round(((bbox.minLat + bbox.maxLat) / 2) * 1e6) / 1e6,
          lng: Math.round(((bbox.minLng + bbox.maxLng) / 2) * 1e6) / 1e6,
        },
        bbox,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return { updated, municipalities };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

export async function main() {
  const contractsPath = path.join(ROOT, "data", "contracts.json");
  const data = JSON.parse(await readFile(contractsPath, "utf8"));
  const townsDir = path.join(ROOT, "data", "towns");
  const masters = await loadMasters(data.contracts ?? [], townsDir);

  const errors = validateContracts(data, masters);
  if (errors.length > 0) {
    console.error("ビルド失敗: contracts.json の検証エラー");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const { taken, summary, internal } = generateArtifacts(data, masters);
  await writeJson(path.join(ROOT, "public", "data", "taken.json"), taken);
  await writeJson(path.join(ROOT, "public", "data", "summary.json"), summary);
  await writeJson(path.join(ROOT, "internal", "data", "internal.json"), internal);

  // 町丁目マスタの公開コピー＋索引（契約の有無に関わらず data/towns/ の整備済み全件を公開する。
  // チェッカーは索引の bbox と検索円の交差で必要分だけ遅延ロードする）
  const allMasters = [];
  for (const file of (await readdir(townsDir)).filter((f) => /^\d{5}\.json$/.test(f))) {
    const master = JSON.parse(await readFile(path.join(townsDir, file), "utf8"));
    allMasters.push(master);
    await writeJson(path.join(ROOT, "public", "data", "towns", file), master);
  }
  const townsIndex = generateTownsIndex(data.updated, allMasters);
  await writeJson(path.join(ROOT, "public", "data", "towns", "index.json"), townsIndex);

  console.log(`ビルド完了（updated: ${data.updated}）`);
  console.log(`  public/data/taken.json    : ${taken.hashes.length} ハッシュ`);
  console.log(
    `  public/data/summary.json  : ${summary.municipalities.length} 市区町村 ` +
      summary.municipalities.map((m) => `${m.name}=${m.takenTowns}/${m.totalTowns}(${m.status})`).join(", "),
  );
  console.log(
    `  public/data/towns/        : index + ${townsIndex.municipalities.length} 市区町村マスタ ` +
      townsIndex.municipalities.map((m) => `${m.prefecture}${m.name}(${m.code})`).join(", "),
  );
  console.log(`  internal/data/internal.json : ${internal.contracts.length} 契約`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  });
}
