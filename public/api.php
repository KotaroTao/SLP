<?php
/**
 * SLP エリア管理API（管理者専用ページ slp_admin.html のサーバーモード用）
 *
 * - 契約データの保存先はサーバー上の private/store.json（.htaccessでHTTPアクセス全拒否）。
 *   このファイル自体には医院データを一切含まない。
 * - 保存時に scripts/build.js と同一仕様のバリデーションを行い、
 *   公開用 data/taken.json / data/summary.json をその場で再生成する。
 * - 認証: パスワードのSHA-256照合（平文は置かない）＋PHPセッション。
 *   失敗5回で60秒ロック。login/get/save は X-SLP-Admin ヘッダ必須（CSRF対策）。
 * - PHP 7.4 以上を想定（エックスサーバー標準のPHPで動作）。
 */

const PASSWORD_SHA256 = '62d63a2005e2c15be79e38a1e1b4e84fefaebebab95606a5a9161a342bc2e62a';
// サポートポータル（seo.tao-dx.com）→ 当APIの参加ステータス同期（action=sync）用の共有シークレット。
// 平文は置かず SHA-256 で照合する。環境変数 SLP_SYNC_SECRET があればそのSHA-256を優先し、
// 無ければ下記定数を使う。定数は「未設定（同期を無効化）」を意味するプレースホルダ。
// 有効化する手順: ポータル側 env に SLP_SYNC_SECRET=<秘密文字列> を設定し、
//   その `echo -n "<秘密文字列>" | sha256sum` の値をこの定数へ（またはサーバーの環境変数へ）反映する。
const SYNC_SECRET_SHA256 = 'CHANGE_ME_SET_SYNC_SECRET_SHA256';
const MAX_LOGIN_FAILS = 5;
const LOCK_SECONDS = 60;
const BACKUP_KEEP = 30;
// summary.json のステータス閾値（scripts/build.js の STATUS_THRESHOLDS と揃えること）
const THRESHOLD_FEW = 0.3;
const THRESHOLD_CLOSED = 0.7;

$PRIVATE_DIR = __DIR__ . '/private';
$DATA_DIR = __DIR__ . '/data';
$STORE_FILE = $PRIVATE_DIR . '/store.json';
$THROTTLE_FILE = $PRIVATE_DIR . '/throttle.json';
$LOCK_FILE = $PRIVATE_DIR . '/store.lock';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$cookieSecure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
session_name('SLPADMIN');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => $cookieSecure,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

$action = isset($_GET['action']) ? $_GET['action'] : '';

function respond($code, $payload)
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function require_admin_header()
{
    if (empty($_SERVER['HTTP_X_SLP_ADMIN'])) {
        respond(403, ['error' => '不正なリクエストです。']);
    }
}

function require_auth()
{
    if (empty($_SESSION['slp_authed'])) {
        respond(401, ['error' => 'ログインが必要です。']);
    }
}

// サポートポータル→当API の同期（action=sync）の認証。共有シークレットを SHA-256 で照合。
// 環境変数 SLP_SYNC_SECRET があればそのSHA-256を、無ければ定数 SYNC_SECRET_SHA256 を期待値にする。
function require_sync_auth()
{
    $expected = getenv('SLP_SYNC_SECRET') !== false
        ? hash('sha256', getenv('SLP_SYNC_SECRET'))
        : SYNC_SECRET_SHA256;
    if ($expected === 'CHANGE_ME_SET_SYNC_SECRET_SHA256') {
        respond(503, ['error' => '同期は未設定です（サーバー側で共有シークレットを設定してください）。']);
    }
    $provided = isset($_SERVER['HTTP_X_SLP_SYNC_SECRET']) ? $_SERVER['HTTP_X_SLP_SYNC_SECRET'] : '';
    if (!hash_equals($expected, hash('sha256', $provided))) {
        respond(401, ['error' => '同期シークレットが不正です。']);
    }
}

function ensure_private_dir($privateDir)
{
    if (!is_dir($privateDir)) {
        mkdir($privateDir, 0705, true);
    }
    // 万一 .htaccess が無い環境でも直アクセスを拒否できるよう常に確認する
    $ht = $privateDir . '/.htaccess';
    if (!file_exists($ht)) {
        file_put_contents($ht, "Require all denied\n");
    }
    $backup = $privateDir . '/backup';
    if (!is_dir($backup)) {
        mkdir($backup, 0705, true);
    }
}

function atomic_write($path, $content)
{
    $tmp = $path . '.tmp.' . getmypid();
    if (file_put_contents($tmp, $content) === false) {
        respond(500, ['error' => 'ファイルの書き込みに失敗しました。']);
    }
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        respond(500, ['error' => 'ファイルの書き込みに失敗しました。']);
    }
}

function read_store($storeFile)
{
    if (!file_exists($storeFile)) {
        return ['revision' => 0, 'data' => null];
    }
    $store = json_decode(file_get_contents($storeFile), true);
    if (!is_array($store) || !isset($store['revision'])) {
        return ['revision' => 0, 'data' => null];
    }
    return $store;
}

function read_json_body()
{
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        respond(400, ['error' => 'リクエスト形式が不正です。']);
    }
    return $body;
}

// --- バリデーション（scripts/build.js の validateContracts と同一仕様） ---

function load_master($dataDir, $code, &$masters)
{
    if (array_key_exists($code, $masters)) {
        return $masters[$code];
    }
    $path = $dataDir . '/towns/' . $code . '.json';
    $masters[$code] = file_exists($path) ? json_decode(file_get_contents($path), true) : null;
    return $masters[$code];
}

function validate_contracts($data, $dataDir, &$masters)
{
    $errors = [];
    if (!is_array($data)) {
        return ['contracts.json のルートがオブジェクトではありません'];
    }
    $updated = isset($data['updated']) ? $data['updated'] : '';
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $updated)) {
        $errors[] = "updated が YYYY-MM-DD 形式ではありません: {$updated}";
    }
    if (!isset($data['contracts']) || !is_array($data['contracts'])) {
        $errors[] = 'contracts が配列ではありません';
        return $errors;
    }
    $seenIds = [];
    foreach ($data['contracts'] as $c) {
        $id = isset($c['id']) ? $c['id'] : '(idなし)';
        if (!preg_match('/^SLP-\d{4}$/', isset($c['id']) ? $c['id'] : '')) {
            $errors[] = "{$id}: id は SLP-0000 形式で指定してください";
        }
        if (isset($seenIds[$id])) {
            $errors[] = "{$id}: id が重複しています";
        }
        $seenIds[$id] = true;
        if (!isset($c['clinic']) || !is_string($c['clinic']) || trim($c['clinic']) === '') {
            $errors[] = "{$id}: clinic（医院名）が未設定です";
        }
        $status = isset($c['status']) ? $c['status'] : '';
        if (!in_array($status, ['active', 'pending', 'paused', 'ended'], true)) {
            $errors[] = "{$id}: status は active / pending / paused / ended のいずれかにしてください（現在: {$status}）";
        }
        $muni = isset($c['municipality']) ? $c['municipality'] : '';
        if (!preg_match('/^\d{5}$/', $muni)) {
            $errors[] = "{$id}: municipality は5桁の市区町村コードで指定してください（現在: {$muni}）";
            continue;
        }
        if (!isset($c['towns']) || !is_array($c['towns']) || count($c['towns']) === 0) {
            $errors[] = "{$id}: towns（町丁目コード配列）が空です";
            continue;
        }
        $master = load_master($dataDir, $muni, $masters);
        if ($master === null) {
            $errors[] = "{$id}: 町丁目マスタ（{$muni}）がサーバーにありません";
            continue;
        }
        $masterCodes = [];
        foreach ($master['towns'] as $t) {
            $masterCodes[$t['code']] = true;
        }
        $seenTowns = [];
        foreach ($c['towns'] as $code) {
            if (!is_string($code) || !preg_match('/^\d{9,11}$/', $code)) {
                $errors[] = "{$id}: 町丁目コードの形式が不正です（9〜11桁の数字）: {$code}";
                continue;
            }
            if (strpos($code, $muni) !== 0) {
                $errors[] = "{$id}: 町丁目コード {$code} が municipality {$muni} と一致しません";
                continue;
            }
            if (isset($seenTowns[$code])) {
                $errors[] = "{$id}: 町丁目コード {$code} が同一契約内で重複しています";
            }
            $seenTowns[$code] = true;
            if (!isset($masterCodes[$code])) {
                $errors[] = "{$id}: 町丁目コード {$code} がマスタに存在しません";
            }
        }
    }
    // 契約間の重複（エリア確保ステータス active / pending のみ。paused / ended は解放扱い）
    $live = [];
    foreach ($data['contracts'] as $c) {
        $st = isset($c['status']) ? $c['status'] : '';
        if (($st === 'active' || $st === 'pending') && isset($c['towns']) && is_array($c['towns'])) {
            $live[] = $c;
        }
    }
    $liveCount = count($live);
    for ($i = 0; $i < $liveCount; $i++) {
        for ($j = $i + 1; $j < $liveCount; $j++) {
            $setB = array_flip($live[$j]['towns']);
            $codes = array_values(array_unique($live[$i]['towns']));
            sort($codes);
            foreach ($codes as $code) {
                if (!isset($setB[$code])) {
                    continue;
                }
                $master = load_master($dataDir, $live[$i]['municipality'], $masters);
                $name = '';
                if ($master !== null) {
                    foreach ($master['towns'] as $t) {
                        if ($t['code'] === $code) {
                            $name = $t['name'];
                            break;
                        }
                    }
                }
                $suffix = $name !== '' ? "（{$name}）" : '';
                $errors[] = "契約重複: {$live[$i]['id']} と {$live[$j]['id']} が {$code}{$suffix} で衝突しています";
            }
        }
    }
    return $errors;
}

// --- 公開ファイル生成（scripts/build.js の taken.json / summary.json と同一仕様） ---

function generate_taken($data)
{
    $codes = [];
    foreach ($data['contracts'] as $c) {
        if ($c['status'] !== 'active') {
            continue;
        }
        foreach ($c['towns'] as $code) {
            $codes[$code] = true;
        }
    }
    $hashes = [];
    foreach (array_keys($codes) as $code) {
        $hashes[] = hash('sha256', $code);
    }
    sort($hashes);
    return ['updated' => $data['updated'], 'algo' => 'sha256', 'hashes' => $hashes];
}

function generate_summary($data, $dataDir, &$masters)
{
    $byMuni = [];
    foreach ($data['contracts'] as $c) {
        if ($c['status'] !== 'active') {
            continue;
        }
        if (!isset($byMuni[$c['municipality']])) {
            $byMuni[$c['municipality']] = [];
        }
        foreach ($c['towns'] as $code) {
            $byMuni[$c['municipality']][$code] = true;
        }
    }
    $municipalities = [];
    foreach ($byMuni as $muniCode => $codes) {
        // PHPは "14102" のような数値文字列の配列キーを整数化するため文字列に戻す
        $muniCode = (string) $muniCode;
        $master = load_master($dataDir, $muniCode, $masters);
        $totalTowns = count($master['towns']);
        $takenTowns = count($codes);
        $ratio = $takenTowns / $totalTowns;
        $status = $ratio < THRESHOLD_FEW ? 'open' : ($ratio < THRESHOLD_CLOSED ? 'few' : 'closed');
        $municipalities[] = [
            'code' => $muniCode,
            'name' => $master['prefecture'] . $master['name'],
            'takenTowns' => $takenTowns,
            'totalTowns' => $totalTowns,
            'ratio' => round($ratio * 100) / 100,
            'status' => $status,
        ];
    }
    usort($municipalities, function ($a, $b) {
        return strcmp($a['code'], $b['code']);
    });
    return ['updated' => $data['updated'], 'municipalities' => $municipalities];
}

// 検証済み contracts データを store.json に保存し、バックアップと公開ファイル（taken/summary）を再生成する。
// 呼び出し側でロックを取得済みであること。戻り値は保存後のリビジョンと件数。
function persist_and_publish($data, $store, $privateDir, $storeFile, $dataDir, &$masters)
{
    $newRevision = (int) $store['revision'] + 1;
    $newStore = [
        'revision' => $newRevision,
        'savedAt' => date('Y-m-d H:i:s'),
        'data' => $data,
    ];
    $storeJson = json_encode($newStore, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    atomic_write($storeFile, $storeJson);
    // バックアップ（直近 BACKUP_KEEP 世代）
    file_put_contents($privateDir . '/backup/store-' . date('Ymd-His') . '.json', $storeJson);
    $backups = glob($privateDir . '/backup/store-*.json');
    sort($backups);
    while (count($backups) > BACKUP_KEEP) {
        @unlink(array_shift($backups));
    }
    // 公開ファイルの再生成（保存と同時に公開反映が完了する）
    $taken = generate_taken($data);
    $summary = generate_summary($data, $dataDir, $masters);
    atomic_write($dataDir . '/taken.json', json_encode($taken, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
    atomic_write($dataDir . '/summary.json', json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
    return ['revision' => $newRevision, 'taken' => count($taken['hashes']), 'municipalities' => count($summary['municipalities'])];
}

// --- ログイン試行の制限 ---

function throttle_check($throttleFile)
{
    if (!file_exists($throttleFile)) {
        return;
    }
    $t = json_decode(file_get_contents($throttleFile), true);
    if (is_array($t) && isset($t['lockedUntil']) && time() < $t['lockedUntil']) {
        respond(429, ['error' => 'ログイン失敗が続いたため一時的にロックしています。しばらく待ってからお試しください。']);
    }
}

function throttle_fail($throttleFile)
{
    $t = file_exists($throttleFile) ? json_decode(file_get_contents($throttleFile), true) : [];
    $fails = (is_array($t) && isset($t['fails']) ? $t['fails'] : 0) + 1;
    $locked = 0;
    if ($fails >= MAX_LOGIN_FAILS) {
        $locked = time() + LOCK_SECONDS;
        $fails = 0;
    }
    file_put_contents($throttleFile, json_encode(['fails' => $fails, 'lockedUntil' => $locked]));
    sleep(1); // 総当たり対策の遅延
}

// --- アクション ---

$MASTERS = [];

switch ($action) {
    case 'ping':
        respond(200, ['ok' => true, 'hasData' => file_exists($STORE_FILE)]);
        // no break（respondでexit）

    case 'login':
        require_admin_header();
        ensure_private_dir($PRIVATE_DIR);
        throttle_check($THROTTLE_FILE);
        $body = read_json_body();
        $password = isset($body['password']) ? $body['password'] : '';
        if (hash('sha256', $password) === PASSWORD_SHA256) {
            session_regenerate_id(true);
            $_SESSION['slp_authed'] = true;
            @unlink($THROTTLE_FILE);
            respond(200, ['ok' => true]);
        }
        throttle_fail($THROTTLE_FILE);
        respond(401, ['error' => 'パスワードが違います。']);
        // no break

    case 'logout':
        require_admin_header();
        $_SESSION = [];
        session_destroy();
        respond(200, ['ok' => true]);
        // no break

    case 'get':
        require_admin_header();
        require_auth();
        $store = read_store($STORE_FILE);
        respond(200, ['revision' => $store['revision'], 'data' => $store['data']]);
        // no break

    case 'save':
        require_admin_header();
        require_auth();
        ensure_private_dir($PRIVATE_DIR);
        $body = read_json_body();
        if (!isset($body['baseRevision']) || !isset($body['data'])) {
            respond(400, ['error' => 'baseRevision と data が必要です。']);
        }

        // 同時保存を直列化（楽観ロック判定と書込みをまとめて保護）
        $lock = fopen($LOCK_FILE, 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            respond(500, ['error' => 'ロックの取得に失敗しました。']);
        }

        $store = read_store($STORE_FILE);
        if ((int) $body['baseRevision'] !== (int) $store['revision']) {
            flock($lock, LOCK_UN);
            respond(409, [
                'error' => '他のメンバーが先に保存しています。最新の内容を読み込み直してから、もう一度編集してください。',
                'revision' => $store['revision'],
            ]);
        }

        $data = $body['data'];
        $errors = validate_contracts($data, $DATA_DIR, $MASTERS);
        if (count($errors) > 0) {
            flock($lock, LOCK_UN);
            respond(400, ['error' => '検証エラーのため保存できません。', 'errors' => $errors]);
        }

        $result = persist_and_publish($data, $store, $PRIVATE_DIR, $STORE_FILE, $DATA_DIR, $MASTERS);
        flock($lock, LOCK_UN);
        respond(200, [
            'ok' => true,
            'revision' => $result['revision'],
            'taken' => $result['taken'],
            'municipalities' => $result['municipalities'],
        ]);
        // no break

    case 'sync':
        // サポートポータル（SLP参加ステータスのマスタ）→ 当APIへ参加/停止を反映する。
        // 既存契約の status のみを更新し、towns / municipality などエリア情報は一切変更しない。
        // 認証はセッションではなく共有シークレット（マシン間連携）。
        require_sync_auth();
        ensure_private_dir($PRIVATE_DIR);
        $body = read_json_body();
        if (!isset($body['updates']) || !is_array($body['updates'])) {
            respond(400, ['error' => 'updates（[{id, status}] の配列）が必要です。']);
        }

        $lock = fopen($LOCK_FILE, 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            respond(500, ['error' => 'ロックの取得に失敗しました。']);
        }

        $store = read_store($STORE_FILE);
        $data = $store['data'];
        if (!is_array($data) || !isset($data['contracts']) || !is_array($data['contracts'])) {
            flock($lock, LOCK_UN);
            respond(409, ['error' => 'エリアデータが未初期化のため同期できません。先に管理コンソールで契約を登録してください。']);
        }

        // id → status（active / paused のみ受け付ける。エリアの新規作成・解約はポータルからは行わない）
        $wanted = [];
        foreach ($body['updates'] as $u) {
            $uid = isset($u['id']) ? $u['id'] : '';
            $ust = isset($u['status']) ? $u['status'] : '';
            if (!preg_match('/^SLP-\d{4}$/', $uid)) {
                flock($lock, LOCK_UN);
                respond(400, ['error' => "id の形式が不正です: {$uid}"]);
            }
            if (!in_array($ust, ['active', 'paused'], true)) {
                flock($lock, LOCK_UN);
                respond(400, ['error' => "{$uid}: status は active / paused のみ指定できます（現在: {$ust}）"]);
            }
            $wanted[$uid] = $ust;
        }

        $applied = [];
        $unknown = [];
        $byId = [];
        foreach ($data['contracts'] as $c) {
            if (isset($c['id'])) {
                $byId[$c['id']] = true;
            }
        }
        foreach ($wanted as $uid => $ust) {
            if (!isset($byId[$uid])) {
                $unknown[] = $uid;
            }
        }
        foreach ($data['contracts'] as &$c) {
            $cid = isset($c['id']) ? $c['id'] : '';
            if (isset($wanted[$cid])) {
                // active/paused 以外（pending / ended）は手動管理中とみなし、ポータル同期では上書きしない
                if ($c['status'] === 'active' || $c['status'] === 'paused') {
                    if ($c['status'] !== $wanted[$cid]) {
                        $c['status'] = $wanted[$cid];
                        $applied[] = $cid;
                    }
                }
            }
        }
        unset($c);

        $errors = validate_contracts($data, $DATA_DIR, $MASTERS);
        if (count($errors) > 0) {
            flock($lock, LOCK_UN);
            respond(409, ['error' => '同期後の検証でエリア重複などが発生したため中止しました。', 'errors' => $errors]);
        }

        if (count($applied) === 0) {
            flock($lock, LOCK_UN);
            respond(200, ['ok' => true, 'applied' => [], 'unknown' => $unknown, 'revision' => $store['revision'], 'note' => '変更はありませんでした。']);
        }

        $result = persist_and_publish($data, $store, $PRIVATE_DIR, $STORE_FILE, $DATA_DIR, $MASTERS);
        flock($lock, LOCK_UN);
        respond(200, [
            'ok' => true,
            'applied' => $applied,
            'unknown' => $unknown,
            'revision' => $result['revision'],
            'taken' => $result['taken'],
            'municipalities' => $result['municipalities'],
        ]);
        // no break

    default:
        respond(404, ['error' => '不明なアクションです。']);
}
