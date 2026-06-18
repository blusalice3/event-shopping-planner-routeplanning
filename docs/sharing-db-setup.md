# 共有機能 DB セットアップ

## 現在の状態

MVP-0aのCLI基盤に加えて、実Supabaseへ接続するローカル専用入力ファイルと実行スクリプトを追加済みです。
実Supabaseへの接続確認では、共有機能の既存テーブル/RPCがない空DB相当のschemaであることを確認しました。
このため、MVP-0b前に空DBを正として基礎schemaを新規作成する方針へ切り替えています。
既存の `src/lib/database.types.ts` は、migrationをローカルDBまたは実DBへ適用してから `public` schemaだけを再生成します。

## MVP-0b実装状態

空DB向け基礎schemaとMVP-0bのDB境界は実装済みです。対象はRLS/helper、private runtime config、
secret/digest、room code alias rotation、credential digest、create/join/restore challenge、DB側rate limit、
private fixture境界、payload暗号化保存、public modeでの直接bootstrap拒否、旧RPC fail-closedです。

MVP-0b完了確認として次を通しています。

```powershell
npm run db:reset
npm run db:test
npm run db:lint
npm run db:typegen:local
npm run typecheck
npm run test:run -- src/features/sharing/canonicalCreateRoomPayload.test.ts src/features/sharing/roomEventDataSchema.test.ts
npm run encoding:check
npm run build
```

MVP-0cの `create_room` / `join_room_by_code` / `restore_member_by_key` / snapshot / ack 本体は、
MVP-0bでは意図的にfail-closedのままです。一般公開向けGuardサーバー、公開buildのGuard URL検証、
CSP/XSS/localStorage credentialレビューは `[PUBLIC-GUARD]` の別ゲートです。公開運用のGuard API契約、Edge Functions、環境変数、release checklistは [sharing-public-guard.md](./sharing-public-guard.md) を参照してください。

## ユーザーが入力するファイル

リポジトリ直下の `.supabase-connection.local.ps1` だけを編集します。このファイルは `.gitignore` 済みです。

```powershell
$env:SUPABASE_ACCESS_TOKEN = ''
$env:SUPABASE_PROJECT_REF = ''
$env:SUPABASE_DB_PASSWORD = ''

$env:VITE_SUPABASE_URL = ''
$env:VITE_SUPABASE_ANON_KEY = ''

$env:SUPABASE_AUTH_ANONYMOUS_SIGN_INS_CONFIRMED = 'false'
```

Authentication > Sign In / Providers で Anonymous sign-ins が有効になっていることを確認したら、
`SUPABASE_AUTH_ANONYMOUS_SIGN_INS_CONFIRMED` を `true` にします。

## 実接続の実行

```powershell
npm run db:connect:real
```

このコマンドは次を順番に実行します。

- `supabase login --token`
- `supabase link --project-ref --password`
- `.env.local` 生成
- Management APIアクセス確認、APIキー値は表示しない
- `db pull` による `public,private` baseline migration生成
- `public` schemaだけの `src/lib/database.types.ts` 生成

`supabase db pull` / `supabase db dump` はSupabase CLI内部でDocker Desktopを必要とする場合があります。
Windowsで `failed to inspect docker image` や `docker_engine` のエラーが出た場合は、Docker Desktopをインストールして起動し、
同じPowerShellで次を再実行します。

```powershell
npm run db:pull
npm run db:typegen
```

baseline生成後、生成されたSQLをレビューします。共有系テーブルが存在しない空DBの場合は、
`20260614213000_sharing_foundation_schema.sql` 以降のmigrationで基礎schemaから作成します。

## ローカルDB

Docker Desktopを起動してから次を実行します。

```powershell
npm run db:start
npm run db:status
npm run db:reset
npm run db:typegen:local
npm run db:test
npm run db:lint
```

ローカルSupabaseの `supabase/config.toml` では Anonymous sign-ins を有効化済みです。

## 期限切れ共有データの定期cleanup

MVP-2bの期限切れ共有データcleanupは、Supabase Cron / `pg_cron` で毎日自動実行します。
設定は `20260614235000_sharing_mvp2b_cleanup_cron.sql` に含まれています。

- ジョブ名: `sharing-expired-room-cleanup-daily`
- 実行時刻: 毎日 03:00 JST（DB上のcron式は `0 18 * * *`、UTC基準）
- 削除対象: 期限切れから72時間以上経過した共有ルーム
- 1回の処理上限: 50ルーム
- 実行内容: `private.run_expired_room_cleanup_job()` から `cleanup_expired_room_data(null, 72, 50)` を呼ぶ

このジョブは通常ユーザーから直接実行できない内部関数を使い、cleanup結果は
`private.expired_room_cleanup_runs` に本文やsecretを含まない最小メタデータとして記録します。
本番SupabaseでCron Postgres Moduleが無効な場合は、migration適用前にDashboardのIntegrations > Cronで有効化します。

## baseline確認項目

- `rooms`, `room_members`, `room_items`, `notifications`, `activity_log` が既存にあるか。空DBの場合は新規migrationで作る
- `claim_item` の既存有無。空DBの場合は後続MVPまでfail-closed stubとして作る
- PK、FK、一意制約、index、RLS policy
- Realtime publication対象
- extensionとDB major version
- `room_items.postponed` と `purchase_status` の既存データ整合性
- Supabase匿名Authの有効化状態
- 生成されたbaselineに秘密値、平文room code、不要なprivate型露出が混入していないこと

baseline取得後に `supabase/config.toml` の `db.major_version` を実DBと一致させます。
現時点の実DB確認値は PostgreSQL 17 系で、`supabase/config.toml` は `major_version = 17` です。

## 型生成境界

通常フロントエンド用の `src/lib/database.types.ts` は `public` schemaだけから生成します。
将来追加するcredential、暗号化payload、runtime configは `private` schemaへ配置し、
このclient-safe型へ含めません。
