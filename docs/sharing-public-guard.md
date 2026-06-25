# Sharing Public Guard

`[PUBLIC-GUARD]` は一般公開・広範囲配布・外部ユーザー利用の前に完了する独立ゲートです。MVP-0c のローカル/限定テストが通っていても、このチェックが未完了なら共有入口は公開しません。

## 環境変数

公開 build では次を設定します。

```env
VITE_SHARING_PUBLIC_GATE_ENABLED=true
VITE_SHARING_EDGE_GUARD_URL=http://127.0.0.1:54321/functions/v1
VITE_SHARING_CONTRACT_VERSION=2
SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK=true
SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK=true
```

`VITE_SHARING_EDGE_GUARD_URL` は Supabase Edge Functions の共通ベース URL です。クライアントは次の3エンドポイントへ POST します。

- `POST /guard-create-room`
- `POST /guard-prepare-join`
- `POST /guard-prepare-restore`

## API 契約

全リクエストは `Authorization: Bearer <Supabase access token>`、`Content-Type: application/json`、`X-Sharing-Contract-Version: 2` を送ります。本文にも `contract_version: 2` を含めます。

成功:

```json
{ "ok": true, "data": {}, "contract_version": 2 }
```

失敗:

```json
{
  "ok": false,
  "error": {
    "code": "GUARD_UNAVAILABLE",
    "retry_after_seconds": 300,
    "contract_version": 2,
    "request_id": "..."
  }
}
```

`retry_after_seconds` と `request_id` は必要な場合だけ返します。SQL例外文やPostgRESTのmessage文字列をクライアント分岐に使いません。

## Guard の責務

- Supabase JWT を `auth/v1/user` で検証し、サーバー側で `auth_user_id` を確定する。
- クライアントから任意の `auth_user_id` や `purpose` を受け取らない。
- `guard-create-room` は受信した create payload をGuard側でUTF-8/JCS/NFC canonical化し、fingerprintとitem countを再計算する。クライアント申告の `plaintext_fingerprint` がGuard再計算値と一致しない場合はchallengeを作らず `CHALLENGE_INVALID` を返す。
- IP、端末ヘッダー、Authセッションをハッシュ化し、`guard_check_edge_rate_limit_internal` で公開用 rate limit を確認する。
- service role 経由で `guard_prepare_create_room_internal` / `guard_prepare_join_internal` / `guard_prepare_restore_internal` を呼ぶ。
- Guard 失敗時にブラウザから DB bootstrap RPC へ fallback しない。
- `member_key`、`member_restore_token`、digest、canonical payload 本文を console、分析ログ、エラー送信、通知payloadへ出さない。

## ローカル起動

```powershell
supabase functions serve guard-create-room --env-file .env.local
supabase functions serve guard-prepare-join --env-file .env.local
supabase functions serve guard-prepare-restore --env-file .env.local
```

ローカル確認時も `VITE_SHARING_EDGE_GUARD_URL` は functions の共通ベース URL にします。

## デプロイ前チェック

```powershell
npm run sharing:public-guard:check
```

このチェックは public flag が false の通常開発では通過します。public flag が true の場合は Guard URL、契約 version、Supabase URL/anon key、CSP/XSS/localStorage credential とログ非出力レビューの確認フラグ、`docs/sharing-public-guard-review.md` の完了 marker が必須です。さらに3つのGuard endpointへ未認証POSTを送り、`AUTH_REQUIRED` の安定エラー envelope が返ることを確認します。

続いて匿名Supabaseセッションを作り、Guard経由で使い捨て共有ルームを1件作成します。そのルームで create challenge、`create_room`、join challenge、restore challenge がすべて成功すること、同じブラウザ相当のJWTからDB bootstrap RPCを直接呼ぶと `GUARD_REQUIRED` になることを確認します。さらにfingerprint不一致、challengeなし作成、消費済みcreate challenge再利用、join challengeのcreate流用、公開Guard rate limit超過が安定エラーで拒否されることを確認します。これは公開前の実地リハーサルなので、対象DBへ短命の確認用ルームが1件作られます。`SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK=true` はこの副作用を理解していることを示すための明示フラグです。疎通失敗、契約不一致、challenge発行不可、DB直接RPC拒否不足のまま公開buildを通しません。

通常の `npm run build` もこのチェックを先に実行します。公開フラグが false の開発buildではskipし、`VITE_SHARING_PUBLIC_GATE_ENABLED=true` の公開buildではチェック失敗時にbuildを止めます。

## Release Checklist

- Guard API contract version が `2` である。
- Supabase JWT 検証が有効で、未認証は `AUTH_REQUIRED` になる。
- IP/端末/セッション横断 rate limit が有効で、超過時は `RATE_LIMITED` と `retry_after_seconds` を返す。
- `app.sharing_public_mode = 'public'` でブラウザ相当の直接 bootstrap RPC が `GUARD_REQUIRED` になる。
- Guard 経由の challenge は room、purpose、payload fingerprint、TTL、single-use を DB 側でも再検証する。
- Edge Guard とクライアントのcanonical create payload bytes/fingerprintが同じテストベクタで一致し、fingerprint不一致ではchallengeを作らない。
- challengeなし作成、消費済みchallenge再利用、wrong purpose challenge流用が `CHALLENGE_INVALID` で拒否される。
- Guard URL 未設定、疎通失敗、契約 version 不一致では共有入口が開かず DB 単体 RPC へ fallback しない。
- `vercel.json` の `Content-Security-Policy` に `default-src 'self'`、`script-src 'self'`、Supabase向け `connect-src`、`object-src 'none'`、`frame-ancestors 'none'` が入っている。
- CSP、外部 script、inline script 方針を確認した。
- XSS レビューで危険な DOM 挿入、credential の console 出力、分析/エラー送信への混入がないことを確認した。
- localStorage の `member_key` は端末内 Bearer credential であり、所持者が復元できるリスクを利用者向け説明または運用メモに残した。
