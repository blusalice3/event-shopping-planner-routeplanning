# ADR: PostgreSQL Release State Store

- Status: Accepted for implementation; single-account human operation amended 2026-08-10; production binding blocked
- Date: 2026-08-06
- Owners: Release / Data Safety / Operations

## Context

Web Foundation release は application artifact、provider deployment/domain assignment、
database compatibility、approval、24 時間 observation を一つの operation として扱う。
provider alias と control state は同じ transaction に参加できないため、branch/tag/CI job の
成否だけでは「何が production か」を安全に決定できない。

必要な性質は次のとおりである。

- concurrent operator/job に対する compare-and-swap
- event と evidence の改ざん/削除拒否
- source/package/provider/DB/policy hash の exact propagation
- distinct role/team と、全human action/reviewでpolicyが明示するsingle-account operation
- process crash や alias 変更途中の deterministic reconcile
- provider や application database から独立した credential/backup boundary

## Decision

PostgreSQL 17 の dedicated control database に
`foundation_release` schema を作り、Release State を append-only event chain として保存する。
production では `config/release-state-store.json` の allowlist と TLS `verify-full` を必須に
する。

### Event chain

各 namespace は sequence/head hash を一つ持つ。event は canonical JSON bytes、
`previousEventHash`、payload hash、evidence/approval reference を含む。

append は database function `compare_and_append` に
`expectedSequence` / `expectedHash` / `appendId` を渡す。head が一致した場合だけ event と
head を同じ transaction で更新する。

- sequence は 1 から連続
- 最初の event は `state-initialized`
- `buildId === sourceSha`
- payload bytes と payload hash は一致
- 同じ `appendId` の replay は同じ receipt を返し、別 content は拒否

application-side reducer は event type と state invariant を再検証し、database receipt だけを
盲信しない。

### Evidence

evidence object は namespace、SHA-256、media type、byte length、raw bytes を持つ
content-addressed immutable object とする。上限は 256 MiB。既存 hash への異なる bytes、
update、delete、truncate を拒否する。

Release event は evidence の URI/hash を参照し、secret value や raw user data を event
payload に複製しない。

### Time

source/artifact identity に wall clock を使わない。event/evidence の authoritative time は
database commit clock とし、client が送る時刻は observation payload として検証対象にする。

### Credential boundary

release workflow に渡す接続情報は `RELEASE_STATE_DATABASE_URL` 一つと verified CA に限定する。

- host、database、executor role は policy allowlist exact 一致
- `sslmode=verify-full`
- pool size 2、connect timeout 5 秒、statement timeout 15 秒
- application/provider runtime credential から control DB へ到達させない
- owner/migration、executor、read-only observer、backup/restore の role を分離
- credential rotation、backup owner、restore rehearsal を evidence 化

production policy が `unconfigured`、CA hash が null、allowlist が空の場合は接続しない。

### Approval

approval は GitHub protected environment と OIDC receipt を issuer evidence として解決する。
repository、workflow ref、environment、operation ID、subject hash を exact に束縛する。
self-claimed JSON field だけを reviewer identity として採用しない。

- pre-promotion: `releaseOwner` と `dataSafetyReviewer`
- standard acceptance: 上記に `operationsReviewer` を追加
- role-bound approval ID は全て distinct
- provider reviewer ID はrole間で重複可とし、同一人物が複数roleを兼任できる
- 三つのreviewer teamはdistinctのまま維持し、兼任者は各teamのactive memberでなければならない
- 一つのauthoritative GitHub environment reviewは、検証済みteam membershipごとにrole-bound
  receiptへ展開する。role、team、operation、subject、runの自己申告による追加は許可しない
- containment/bootstrap を standard acceptance しない

reviewer team が未設定なら approval resolver は fail-closed する。

### Human operator model

`humanOperatorModel=single-human-single-github-account/v1`を正本とする。collector、baseline selector、
auditor、installed-PWA executor、reviewer、publisher、三つのapprover roleは同じ一つの実在GitHub
accountが担当できる。各role/action field、review timestamp、evidence referenceは残し、reviewは対象
evidence確定後の別actionとする。distinct workflow run、hash、source/build/deployment/profileとservice
credentialの分離は人物分離ではないため維持する。

### Provider assignment and reconcile

promotion は次の順で記録する。

1. verified target/companion/recovery と approval を `promotion-prepared`
2. provider API で全 owned domain assignment を変更
3. API receipt を evidence 化して `deployment-assigned`
4. production probe を evidence 化して `assignment-validated`
5. observation を開始

alias 変更と event append を「atomic」と表現しない。途中停止時は pending operation、
provider の現在 assignment、immutable package/evidence を読み、exact match の場合だけ
`state-reconciled` を CAS append する。一部 domain、unknown deployment、hash mismatch は
推測せず incident とする。

## State invariants

- active/accepted standard は `releaseRole=standard`
- companion/bootstrap/containment incident は `releaseRole=containment`
- binding の DB URI/fingerprint は current DB compatibility と exact 一致
- pending operation は同時に一つ
- rollback は current policy inventory で `eligible` な target のみ
- acceptance は minimum observation end と三役分のapprovalより前に行わない。三役は同一provider
  reviewerが兼任してよい
- legacy bootstrap は `temporary-containment-activated` のみで、accepted standard/floor を
  更新しない
- containment expiry は自動 alias 変更を行わず blocking incident を継続

## Alternatives considered

### Git tag / branch / workflow artifact を state とする

provider の現在 assignment と divergence し、CAS、immutable evidence、reconcile を表現できない
ため採用しない。

### Provider metadata だけを state とする

DB compatibility、approval、observation、rollback eligibility を provider lifecycle から独立して
検証できないため採用しない。

### Application Supabase database に同居する

application credential/incident と release control plane の blast radius が共有されるため採用
しない。

### Alias 変更を先に行い、成功後にログへ記録する

crash 後の prepared intent と reviewer subject を復元できず、安全な reconcile ができないため
採用しない。

## Consequences

利点:

- concurrent operation は CAS conflict として停止する
- artifact/provider/DB/policy/approval の hash chain を replay 検証できる
- alias 変更途中の crash を明示的に reconcile できる
- application data plane から control plane を分離できる

コスト:

- dedicated PostgreSQL、CA、role、backup/restore owner が必要
- provider と state store の二段階 operation/runbook が必要
- production activation 前に disposable namespace drill が必要
- control DB 障害中は promotion/rollback automation を fail-closed で停止する
- 独立した人的牽制を採用しないため、一つのGitHub account侵害で収集、review、承認、promotionまで
  実行し得る。operator accountのpasskey/MFA、session、最小権限token、team membership、audit logを
  重点監査する。監査記録では別人確認と表現せず、同一人物が行ったrole/action別記録として扱う

## Activation gate

次が揃うまで production namespace を初期化しない。

- migration checksum と PostgreSQL 17 disposable test
- allowlisted host/database/executor、verified CA
- credential rotation、backup/PITR owner、restore rehearsal
- protected environment と三つの reviewer team
- valid/wrong repo/workflow/environment/self-claimed/duplicate/tampered approval fixtures
- CAS/idempotency/immutable evidence/credential denial/reconcile drill
- final DB compatibility と verified bootstrap recovery binding

現在の `config/release-state-store.json` と `config/approval-policy.json` は未設定であり、この gate
を満たしていない。
