# Web Foundation Release Runbook

## 目的と適用範囲

この runbook は Web Foundation の immutable artifact を build、検証、prebuilt deploy、
promotion、rollback、reconcile する手順を固定する。production alias、Release State、
database、provider のいずれかを変更する操作は protected workflow と二者以上の review
なしに実行しない。

`dist/`、branch 名、Git tag、provider alias は release artifact の正本ではない。正本は
`release-package-index.json` が参照する content-addressed manifest/ZIP と、それらを束縛する
Release State event である。

## 現在の production blocker

この repository に保存されている policy は production activation を許可しない。

- `config/provider-policy.json` の provider/team/project/domain/WAF/log-retention が未設定
- `config/db-compatibility-contract.json` の remote observation と migration 適用が未完了
- `config/release-state-store.json` の host/database/executor/CA/backup owner が未設定
- `config/approval-policy.json` の三つの reviewer team が未設定
- `config/foundation-baseline.json` の `bootstrapBaselineSourceSha` と raw-dist manifest hash が未設定

fixture の artifact verifier が通っても production eligible を意味しない。
`--require-production-bindings` を付けた verifier と builder が上記を fail-closed で拒否する
状態が正しい。

## 不変条件

1. build は full 40 桁 `sourceSha` の clean checkout だけで行う。
2. Node/npm/Vercel CLI と top-level dependency は `config/toolchain-versions.json` に exact pin
   する。
3. `.vercel/output/**` を生成できるのは local pinned Vercel CLI の
   `vercel build --prod` だけである。手書き、patch、後処理を禁止する。
4. standard と containment は同じ source、lockfile、toolchain、public build environment、
   provider policy/configuration、release policy、DB contract から別々に build する。
5. manifest の `outputFiles` と ZIP 展開後の path/hash/size set は exact 一致させる。
6. test 済み ZIP を再 build せず `vercel deploy --prebuilt --prod --skip-domain` へ渡す。
7. immutable deployment URL の probe が終わるまで production domain を変更しない。
8. alias 変更と Release State append は分散 transaction ではない。途中失敗は必ず
   reconcile する。
9. containment と legacy bootstrap を `release-accepted` にしない。
10. secret value、raw user data、free-form event/item text を artifact/evidence/log に含めない。

## 事前確認

PowerShell は UTF-8 に固定する。

```powershell
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null
```

checkout と runtime を確認する。

```powershell
git status --short
git rev-parse HEAD
node --version
npm --version
npm ci
npm run test:encoding
npm run verify:baseline
npm run verify:toolchain
npm run verify:db-compatibility
node scripts/provider/verify-provider-policy.mjs --require-configured
```

`git status --short` は空でなければならない。provider observation は provider API から
secret value を除いて取得し、review 済みの一時 file として保存する。手入力した ID や
placeholder を使わない。

protected environment から次の credential/binding を渡す。

- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_TOKEN`
- `RELEASE_STATE_DATABASE_URL` (`sslmode=verify-full`)
- `RELEASE_STATE_DATABASE_CA_PEM`
- `RELEASE_STATE_NAMESPACE`
- protected workflow の `GITHUB_TOKEN` / OIDC request binding

builder は `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` と provider observation/policy の exact
一致を検証する。token value は command line、log、artifact に出さない。

## Local fixture gate

外部 binding を変更せず、artifact contract と bootstrap byte preservation を検証する。

```powershell
node --test scripts/deterministic-zip.test.mjs scripts/release-artifact.test.mjs
node scripts/verify-foundation-policy.mjs
node scripts/provider/verify-provider-policy.mjs
```

期待結果は fixture test が PASS、provider policy の表示が `unconfigured` である。
production build を成功させるために policy check を迂回してはならない。

## Source-hardened pair の build

package 出力先は checkout 外の新規 directory にする。既存 directory への上書きを禁止する。

```powershell
$sourceSha = (git rev-parse HEAD).Trim()
$packageRoot = "D:\foundation-release-packages\$sourceSha"
$providerObservation = "D:\foundation-release-input\provider-observation.json"

node scripts/build-release-artifact.mjs `
  --output $packageRoot `
  --provider-observation $providerObservation
```

任意 phase の standard dimension を build する場合は、review 済み canonical JSON を
`--standard-dimensions` で渡す。builder は policy の exact dimension set と containment
projection を検証する。

builder は role ごとに次を行う。

1. `.vercel` が存在しないことを確認する。
2. pinned local `vercel@58.5.1` の `vercel build --prod --yes` を一回実行する。
3. CLI が生成した `.vercel/output` を read-only で manifest 化する。
4. 同じ output から二回 ZIP を生成し、SHA-256 一致を確認する。
5. `yauzl` による独立読取で entry policy と path/hash/size set を検証する。
6. standard output を削除してから containment を別 build する。
7. pair relationship、capability byte 同一、variant identity byte 差異を検証する。
8. content-addressed object と package index を出力先へ atomic rename する。

途中失敗した package は publish/deploy しない。

## Legacy bootstrap package

bootstrap は一時 containment 専用であり、standard acceptance には使わない。先に
provider-bound `bootstrapBaselineSourceSha`、recorded Node/npm/lockfile、raw-dist manifest
hash、final DB fingerprint を baseline evidence に確定する。

raw `dist/**` は baseline source を recorded toolchain で build した bytes を使う。古い
checkout で Vercel build を実行しない。

```powershell
$packageRoot = "D:\foundation-release-packages\bootstrap-$sourceSha"
$rawDist = "D:\foundation-release-input\baseline-raw-dist"

node scripts/build-release-artifact.mjs `
  --bootstrap `
  --raw-dist $rawDist `
  --output $packageRoot `
  --provider-observation $providerObservation
```

bootstrap staging の allowlist は次だけである。

- `public/**`: raw dist の byte-for-byte copy
- fixed metrics-disabled API
- fixed JSON 404 API
- dependency 0 の generated `package.json` / lockfile / `vercel.json`
- self-contained `verify-bootstrap-staging.mjs`

builder は Vercel build の前後で raw dist と `public/**` /
`.vercel/output/static/**` の path/hash/size set を比較する。`release-identity*.json` を追加
しない。Phase 0D の final DB fingerprint より前に生成した fixture/bootstrap package を
temporary production activation に使わない。

## Package の独立検証

local structure/hash 検証:

```powershell
node scripts/verify-release-artifact.mjs `
  --package $packageRoot `
  --provider-observation $providerObservation
```

promotion 前の production-binding 検証:

```powershell
node scripts/verify-release-artifact.mjs `
  --package $packageRoot `
  --provider-observation $providerObservation `
  --require-production-bindings
```

二つ目だけが production eligibility を検査する。どちらも次を再計算する。

- package index / manifest / bootstrap input の canonical bytes と schema contract
- content-addressed URI と object SHA-256
- deterministic ZIP entry policy と展開後 path/hash/size
- release role projection、variant ID、policy/toolchain/provider/DB hash
- Release A capability と release identity
- exact `/api` / unknown `/api/**` JSON 404 route ownership
- Python build trigger (`*.py`、`requirements*.txt`、`Pipfile*`、`pyproject.toml`) が
  build input/output に 0 件で、全 function runtime が Node であること
- bootstrap raw static byte preservation
- secret/workspace path/source-map scan

## Prebuilt deploy

手動の ZIP 展開や Vercel CLI 直接実行は行わない。`release:deploy-prebuilt` は production
verifier を先に再実行し、index の対象 role を一意に選択し、content-addressed archive を
secure staging へ展開して pinned Vercel CLI の
`deploy --prebuilt --prod --skip-domain --yes --cwd` だけを実行する。

```powershell
$receiptPath = Join-Path $env:TEMP "prebuilt-deployment-receipt.json"
$bindingPath = Join-Path $env:TEMP "deployment-binding.json"
$idempotencyKey = "deploy:<protected-run-id>:$sourceSha:standard"

npm run release:deploy-prebuilt -- `
  --package $packageRoot `
  --role standard `
  --provider-observation $providerObservation `
  --idempotency-key $idempotencyKey `
  --receipt $receiptPath

npm run release:produce-deployment-binding -- deployment-binding `
  --namespace $env:RELEASE_STATE_NAMESPACE `
  --package $packageRoot `
  --role standard `
  --deployment-receipt $receiptPath `
  --provider-observation $providerObservation `
  --output $bindingPath
```

production では上記 CLI を `.github/workflows/release.yml` の `deploy-prebuilt` operation
からだけ呼ぶ。workflow は固定名 package を prior trusted run から取得し、receipt と
DeploymentBinding を `foundation-deployment-<sourceSha>-<role>` に保存する。同じ
idempotency key と exact receipt を渡した retry は provider deploy を再実行せず replay
し、異なる bytes/configuration は拒否する。

`providerConfigurationHash` は provider observation のうち運用設定を表す stable projection
の hash であり、取得時刻と evidence receipt bytes は除外する。freshness と改ざん検出には
別途、完全な provider observation SHA-256 と各 raw response receipt を保存する。したがって
fresh observation の時刻差は replay を壊さない一方、project/domain/environment/WAF/log/HSTS
の drift は必ず拒否される。

## Immutable deployment probe

production domain へ割り当てる前に immutable URL で最低限次を検査する。

| request                                   | expected owner/result            |
| ----------------------------------------- | -------------------------------- |
| `/`                                       | static app、expected body hash   |
| `/release-capabilities.json`              | no-cache、manifest hash          |
| versioned capability                      | immutable、同じ capability bytes |
| `/release-identity.json`                  | source-hardened のみ、no-cache   |
| versioned identity                        | source-hardened のみ、immutable  |
| `/sw.js`                                  | expected body hash/cache policy  |
| `POST /api/persistence-release-a-metrics` | exact metrics function           |
| `/api`                                    | JSON 404、`no-store`             |
| unknown `/api/**`                         | JSON 404、`no-store`             |
| SPA route                                 | `index.html`                     |

`release:produce-deployment-binding` は manifest が宣言した全 route を immutable URL で
bounded probe し、body/cache/security/HSTS/API ownership/public identity を照合する。
deployment ID、project ID、source、manifest/index/policy/DB hash、response hash、
environment presence を `ProviderDeploymentEvidence` として immutable Release State
evidence store に保存し、保存後の再読取まで一致した場合だけ canonical
`DeploymentBinding` を出力する。

## Promotion

`.github/workflows/release.yml` の operation と固定アーティファクトを次の順で使う。

1. `build-and-verify` が standard/containment pair を作り、
   `foundation-release-<sourceSha>` を保存する。
2. role ごとに `deploy-prebuilt` を実行し、二つの immutable
   `foundation-deployment-<sourceSha>-<role>` を作る。
3. QA/provenance evidence bytes を immutable store に保存し、UTF-8 順に整列した reference
   だけを持つ canonical `pre-promotion-evidence-set.json` を
   `foundation-prepromotion-evidence-<sourceSha>` として保護 run に保存する。
4. `produce-promotion-subject` が current Release State を replay し、standard/companion/
   previous/emergency recovery と全 evidence を再解決して
   `foundation-promotion-subject-<sourceSha>` を作る。
5. subject bytes の SHA-256 を人が review し、その exact 値と subject run ID を
   `prepare-and-promote` dispatch input にする。
6. protected environment/OIDC と GitHub API approval を検証し、
   `releaseOwner` と `dataSafetyReviewer` の distinct receipt を保存して
   `promotion-prepared` を CAS append する。
7. pinned `vercel promote` を一回だけ実行し、全 owned production domain の before/after
   assignment receipt を保存する。partial/unknown target、configuration drift、retry
   mismatch は停止する。
8. promotion receipt から canonical `production-assignment-authority.json` を生成し、
   `record-assignment` が `deployment-assigned` を CAS append する。alias 変更後の public
   probe より先にこの event を永続化し、保存後の readback が一致しなければ停止する。
9. 全 domain × 全 declared route を再 probe し、prepared target、provider alias、
   immutable route baseline、body/cache/security/identity/API owner を exact 比較する。
10. `record-promotion` が authority、validation、probe を exact replay し、
    `assignment-validated` と `observation-started` を順次 CAS append する。途中停止時は、
    同じ promotion artifact を指定した
    `record-promotion` または read-only `reconcile` だけを使う。
11. `assignment-validated` の commit 後から同じ deployment ID と全 owned domain を
    最大 5 分間隔で 24 時間以上観測し、fresh exact-source v1、minimum sample、
    rollback inventory を満たす canonical `release-a-acceptance-evidence.json` と
    `continuous-production-probe-source.json` を保存して bytes の SHA-256 を review する。
12. `produce-acceptance-inputs` が reviewed evidence/source bytes から canonical
    `continuous-production-probe.json` を生成する。P1 以降で legacy bootstrap を解除する場合は、
    companion 固有の recovery drill を実施し、reviewed
    `companion-recovery-drill-source.json` から `companion-recovery-drill.json` も生成する。
    生成物の SHA-256 を別途 review する。
13. `accept-standard` が evidence、continuous probe、必要時の companion drill の全 reviewed
    hash、current head/provider identities、三役の distinct
    approval を commit 直前にも再検証し、standard だけを `release-accepted` にする。

workflow の `source_sha` は protected `main` の dispatch head と exact 一致しなければならない。
subject/evidence は caller が組み立てた snapshot を信用せず、Release State replay と immutable
evidence から導出する。promotion 後の再実行は同じ assignment authority の exact replay
だけを許可し、新しい promotion のために過去の authority を流用しない。Release State append、
provider assignment、promotion を local branch や未保護 shell から代替実行しない。

## Rollback と containment

pre-promotion の失敗は alias を変更せず `operation-aborted` を append する。

post-assignment / pre-acceptance の失敗では、prepared operation が束縛した recovery target
だけを使う。

- 初回 source-hardened release: verified legacy bootstrap を
  `temporary-containment-activated`
- 通常 release: current policy で eligible な previous accepted standard または
  source-hardened containment
- package bytes が残り deployment だけ失われた場合:
  `package-redeploy-activated`

containment は recovery deadline と target standard を記録する。expiry だけで alias を
自動変更しない。blocking incident を継続し、source-hardened standard への recovery を
完了する。

## Reconcile

provider alias 変更と Release State append の間で process が停止した場合:

1. Release State head と pending operation を read-only で取得する。
2. provider API から全 owned domain の現在 assignment を取得する。
3. immutable deployment の package/index/manifest/DB/policy hash を再解決する。
4. prepared operation と exact 一致する場合だけ missing event を `state-reconciled` として
   CAS append する。
5. 一致しない、一部 domain だけ変更、unknown deployment、evidence 欠損の場合は自動推測
   せず incident として停止する。

古い binding/artifact/event/evidence を reconcile の都合で削除しない。

workflow の `reconcile` operation は provider API から owned domain assignment を直接取得し、
raw response receipt と canonical observation を先に immutable store へ保存する。prepared
operation、全 domain target、current Release State predecessor が exact 一致した場合だけ
`state-reconciled` を CAS append する。caller supplied domain/target/snapshot は受け付けない。

## 完了記録

release ごとに次を immutable evidence として保持する。

- package index と全 content-addressed object
- provider configuration before/after observation
- deployment evidence と全-domain assignment receipt/validation
- DB compatibility contract/fingerprint と remote observation
- approval issuer receipt、OIDC binding、reviewer identity/role
- Release State event/receipt/head
- immutable/production HTTP probe
- observation window、metrics、rollback/recovery drill

archive retention と access control は `config/artifact-archive-policy.json` および
`config/metrics-retention-policy.json` の owner/期間に従う。
