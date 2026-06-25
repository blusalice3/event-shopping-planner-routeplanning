# 共有 v2 activation runbook

この runbook は、additive migration 適用後に v2 専用運用へ切り替える直前の preflight と activation 手順を固定します。
activation は旧 v1 challenge の削除と旧 RPC の revoke/drop を含むため、linked 環境では rollback 不能な境界として扱います。

## activation 前の停止点

以下がすべて完了するまで `sharing:activation-cleanup:linked` を実行しません。

- additive schema/RPC/backfill migration を適用済みである。
- Edge Functions と client build が `SHARING_CONTRACT_VERSION = 2` で揃っている。
- `npm run sharing:public-guard:check` が成功している。
- `npm run sharing:activation-runbook:check` が成功している。
- `npm run sharing:activation-audit:linked` が blocker 0 件で成功している。
  - product/support が「古い共有ルーム利用者はいない」と明示判断した場合に限り、`active_v1_or_unknown_members` と `active_v1_or_unknown_member_sync_state` だけは `-AllowLegacyMemberBlockers` で免除できる。
- `npm run db:typegen` を activation 対象 DB に対して再生成できる見込みがある。
- product/support が active v1 member、pending v1 challenge、deleted tombstone size の監査結果を確認済みである。

非エンジニア向けに言うと、この段階を越えると「古い共有ルームに戻す」より「ローカルデータを保持して新しい共有ルームを作る」対応になります。
既存 v1 room/member を同じ room として自動復旧する flow は、この release には含めません。

## preflight 手順

1. 作業ツリーを確認します。

```powershell
git status --short
npm run encoding:check
```

2. local DB で migration chain と activation audit を確認します。

```powershell
npm run db:reset
npm run db:test
npm run db:lint
npm run sharing:activation-audit
```

3. linked DB で destructive でない監査だけを実行します。

```powershell
npm run sharing:activation-audit:linked
```

`blocker` が 1 件でもある場合は停止します。`warning` は内容を記録し、product/support が許容または対応方針を決めてから進みます。
ただし、古い共有ルーム利用者がいないことを product/support が確認済みの場合だけ、以下の 2 項目は release decision として免除できます。

```powershell
$env:SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK='true'
npm run sharing:activation-audit:linked -- -AllowLegacyMemberBlockers
```

この免除は「古い同じ共有ルームへの復帰は案内しない」という運用判断です。データ不整合の blocker ではないため、`route_mirror_mismatch`、`event_data_size_mismatch`、`active_items_missing_field_clocks` などは免除しません。

必ず確認する監査項目:

- `active_v1_or_unknown_members`
- `active_v1_or_unknown_member_sync_state`
- `pending_v1_create_challenges`
- `pending_v1_join_restore_challenges`
- `active_items_missing_field_clocks`
- `title_name_mismatch`
- `postponed_mirror_mismatch`
- `route_membership_without_event_date`
- `missing_route_version_rows`
- `route_mirror_mismatch`
- `event_data_size_mismatch`
- `legacy_change_log_missing_v2_metadata`
- `deleted_tombstone_rows`
- `old_rpc_execute_grants_present`

## activation 実行

linked activation cleanup は、直前の audit を必須にします。linked では `-SkipAudit` を使えません。

```powershell
$env:SHARING_ACTIVATION_CONFIRMED='true'
$env:SHARING_ACTIVATION_RUNBOOK_ACK='true'
npm run sharing:activation-cleanup:linked
```

古い共有ルーム利用者 blocker を免除して activation する場合は、直前に product/support 判断を再確認してから追加の ACK を設定します。

```powershell
$env:SHARING_ACTIVATION_CONFIRMED='true'
$env:SHARING_ACTIVATION_RUNBOOK_ACK='true'
$env:SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK='true'
npm run sharing:activation-cleanup:linked -- -AllowLegacyMemberBlockers
```

本番相当の完全実行では、preflight、linked audit、cleanup、post audit、旧 RPC カタログ確認、型再生成、typecheck、DB lint/tests、public guard、encoding check をまとめて実行します。

```powershell
$env:SHARING_ACTIVATION_CONFIRMED='true'
$env:SHARING_ACTIVATION_RUNBOOK_ACK='true'
npm run sharing:activation-production:linked
```

古い共有ルーム利用者 blocker を免除する本番相当実行:

```powershell
$env:SHARING_ACTIVATION_CONFIRMED='true'
$env:SHARING_ACTIVATION_RUNBOOK_ACK='true'
$env:SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK='true'
npm run sharing:activation-production:linked -- -AllowLegacyMemberBlockers
```

cleanup が行うこと:

- 未消費の v1 create challenge を削除する。
- 未消費の v1 join/restore challenge を削除する。
- `update_room_item_fields` の public/anon/authenticated execute grant を revoke し、関数を drop する。
- `claim_item` の public/anon/authenticated execute grant を revoke し、関数を drop する。

## activation 後の固定確認

```powershell
npm run db:typegen
npm run typecheck
npm run db:test
npm run sharing:activation-audit:linked
npm run sharing:public-guard:check
npm run encoding:check
```

`old_rpc_execute_grants_present` は activation 前は warning として残り得ますが、activation 後は 0 件であることを確認します。

## rollback 境界

- cleanup 実行前: client / Edge Functions を戻し、activation を延期できます。
- cleanup 実行後: 旧 v1 challenge と旧 RPC surface は戻さない前提です。問題が出た場合は v2 client / Edge Functions / DB 修正で前進復旧します。
- active v1 利用者が見つかった場合: 同じ room/member の自動復旧ではなく、ローカル継続または新規 v2 room 作成を案内します。

## support copy

共有同期を続けられない場合も、この端末のローカル買い物リストは保持されています。
共有を続けたい場合は、ローカルデータから新しい共有ルームを作成してください。
同じ古い共有ルームへ戻る機能は、この release では提供していません。
