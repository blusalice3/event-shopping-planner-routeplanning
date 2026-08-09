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

この repository に保存されている policy は production activation を許可しない。blocker の正本は
`node scripts/verify-foundation-policy.mjs --json` の `blockerCodes` であり、現在は 28 件である。

- `config/provider-policy.json` の provider/team/project/domain/WAF/log-retention が未設定
- `config/db-compatibility-contract.json` の remote observation と migration 適用が未完了
- `config/release-state-store.json` の host/database/executor/CA/backup owner が未設定
- `config/approval-policy.json` の三つの reviewer team が未設定
- `config/foundation-baseline.json` の `bootstrapBaselineSourceSha` と raw-dist manifest hash が未設定
- `config/metrics-retention-policy.json` の backup owner、remote cron、last-success observation が未設定
- startup burst API の production WAF/rate 値と provider log retention が未観測

fixture の artifact verifier が通っても production eligible を意味しない。
`verify-foundation-policy.mjs --require-production-ready` と production binding を要求する builder が
上記を fail-closed で拒否する状態が正しい。blocker 件数や code を手作業で別管理しない。

## 不変条件

1. build は full 40 桁 `sourceSha` の clean checkout だけで行う。
2. Node/npm/Vercel CLI と top-level dependency は `config/toolchain-versions.json` に exact pin
   する。
3. production eligible な `.vercel/output/**` を生成できるのは local pinned Vercel CLI の
   `vercel build --prod` だけである。policy activation QA は同じ pin の非 production build を使い、
   `buildPurpose=non-promotable-policy-activation-qa`、`promotable=false` とする。どちらも手書き、
   patch、後処理を禁止する。
4. build dimension は caller が指定せず、current Release State と immutable policy object から導出した
   review 済み `artifact-build-requirements.json` の exact bytes に従う。
5. standard と containment は同じ source、lockfile、toolchain、public build environment、
   provider policy/configuration、release policy、DB contract から別々に build する。
6. manifest の `outputFiles` と ZIP 展開後の path/hash/size set は exact 一致させる。
7. test 済み ZIP を再 build せず `vercel deploy --prebuilt --prod --skip-domain` へ渡す。
8. immutable deployment URL の probe が終わるまで production domain を変更しない。
9. alias 変更と Release State append は分散 transaction ではない。途中失敗は必ず
   reconcile する。
10. containment と legacy bootstrap を `release-accepted` にしない。
11. secret value、raw user data、free-form event/item text を artifact/evidence/log に含めない。

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

build は二つの protected run に分ける。

1. `produce-artifact-build-requirements` が current Release State を全 replay し、active policy、次の
   target gate、source、provider/DB/toolchain/CSP authority と expected standard/containment dimensions を
   canonical `artifact-build-requirements.json` にする。これを
   `foundation-artifact-build-requirements-<sourceSha>` として upload する。
2. 人が requirements bytes の SHA-256 を review する。
3. `build-and-verify` は distinct prior run ID と reviewed SHA-256 で exact artifact を downloadし、
   current Release State から同じ requirements を再導出する。head/policy/source/hash が変化した場合、
   同一 run、caller supplied dimension、proposed policy からの production build を拒否する。

package 出力先は checkout 外の新規 directory にする。既存 directory への上書きを禁止する。protected
workflow と同じ authority で read-only reproduction を行う場合も、reviewed requirements file と hash を
両方渡す。

```powershell
$sourceSha = (git rev-parse HEAD).Trim()
$packageRoot = "D:\foundation-release-packages\$sourceSha"
$providerObservation = "D:\foundation-release-input\provider-observation.json"
$buildRequirements = "D:\foundation-release-input\artifact-build-requirements.json"
$buildRequirementsSha256 = (Get-FileHash -LiteralPath $buildRequirements -Algorithm SHA256).Hash.ToLowerInvariant()

node scripts/build-release-artifact.mjs `
  --output $packageRoot `
  --provider-observation $providerObservation `
  --build-requirements $buildRequirements `
  --build-requirements-sha256 $buildRequirementsSha256
```

`--standard-dimensions` は禁止されている。P6/P8 のように dimension delta がない gate も
requirements の `targetGate` で識別し、caller の推測で補わない。

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

### Policy activation QA build と drill

通常の policy gate (`P1-PWA`、`P2A-LOCAL`、`P2B-REPORT`、`P3-XLSX`、`P4-CSP`、
`P5-DUAL`、`P5-LIST`、`P7-IDB`) は production build と分離した次の chain を使う。

1. `produce-policy-activation-qa-build-requirements` が exact predecessor/proposed/active policy と gate、
   target source を束縛し、人が別 run で bytes/hash を review する。
2. `build-policy-activation-qa` が reviewed requirements を再導出して、非 production Vercel build から
   nonpromotable standard/containment pair を作る。
3. `produce-policy-activation-qa-package` が manifest/ZIP/build authority を immutable store へ保存し、
   production package index と互換でない専用 QA package を作る。
4. `produce-policy-activation-qa-execution-subject` が QA package、policy、provider/CSP/toolchain authority を
   exact 8 reference set に閉じ、人が subject SHA-256 を review する。
5. `execute-policy-activation-qa` が operation 固有の `.vercel.app` alias にだけ preview deploy し、全 public
   routeを検証する。QA standard、accepted rollback、QA containment、QA standard restore の順で drillし、
   owned production domain とその subdomain には一度も接触しない。途中失敗も final restore と immutable
   failure journal を要求する。
6. `produce-policy-activation-closure` は reviewed QA execution bundle 一件だけを入力にし、そこから subject、
   policy、package、deployment/probe/drill refsを導出して current state と再照合する。caller supplied auxiliary
   SHA や missing/extra evidence を拒否する。

`P8-CLEAN` は floor-only activation であり、QA build/drillへ入れない。P8 acceptance後に同じ accepted
artifact bytesへ minimum safety floor を単調に適用する。

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

1. `produce-artifact-build-requirements` の prior run artifact/hash を人が reviewし、
   `build-and-verify` が current state から同じ authority を再導出して standard/containment pair を作る。
   package は `foundation-release-<sourceSha>-<requirementsSha256>` として保存する。
2. role ごとに `deploy-prebuilt` を実行し、二つの immutable
   `foundation-deployment-<sourceSha>-<role>` を作る。
3. QA/provenance evidence bytes を immutable store に保存し、review 済み
   `collect-prepromotion-evidence-source` のprior runから
   `foundation-prepromotion-evidence-source-<sourceSha>` を取得する。sourceは`qa`、`reproducibility`、
   `resource`、`route`、`security`のexact 5 categoryと、review済みrequirements、standard/containment
   binding、fresh provider observationを束縛する。requirements、standard binding、containment bindingは
   相互にdistinctなprior runのGitHub Run API raw/canonical receiptで`completed/success`、run ID/attempt、
   head SHA、workflow path、artifact名/hashを検証する。`produce-prepromotion-evidence` はUTF-8順に整列し、
   全objectを再解決した
   canonical `pre-promotion-evidence-set.json` だけを
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
11. `assignment-validated` のcommit後に`initialize-acceptance-collector`を一度だけ実行し、source、
    assignment、provider policy、Release State headを束縛したpersistent acceptance chainを初期化する。
    以後の`collect-continuous-sample`は毎回別のprotected runで、GitHub Run API/OIDCのprior-run authorityを
    検証し、provider APIのdeployment lookup raw responseと全owned domainのpublic HTTP response/bodyを
    実取得する。receipt/bodyをimmutable storeへ保存・readbackした後だけ、sample、chain commit、headを
    `ops/release-state/migrations/0002_acceptance_evidence_chains.sql`の同一transaction/CASでappendする。
    stale predecessor、fork/replay、異なるchain identity、途中rollback、caller supplied observationは拒否する。
    最大5分間隔で24時間以上とminimum sampleを満たした後、`finalize-acceptance-evidence`がcurrent chainから
    fresh exact-source v1とrollback inventoryを持つcanonical evidence/sourceをcreate-onlyで閉じる。
    bytesのSHA-256とrun authorityをreviewし、`publish-acceptance-evidence`がexact prior artifactだけを
    `foundation-acceptance-evidence-<sourceSha>`として再公開する。
12. `produce-acceptance-requirements` が current Release State、pending standard、active release
    policy の `phaseSequence` を replay し、次の `acceptedGate` と performance evidence の要否・kind を
    canonical `acceptance-requirements.json` にする。人が bytes の SHA-256 を review し、後続 run は
    exact prior run ID と hash で artifact を download する。後続 run は current state から同じ要件を
    再導出し、bytes/hash が一致しない場合、同一 run の artifact、caller supplied gate を拒否する。
13. performance evidence は accepted gate ごとに固定する。`P0-RELEASE` は
    `P0-TOOLCHAIN` own-gate envelope、`P3-XLSX`、`P5-DUAL`、`P5-LIST` は各 own-gate
    envelope、`P8-CLEAN` は四つの historical accepted event と live archive readback を束縛した
    `performance-inherited-closure/v1` だけを許可する。P8 closure は
    `produce-performance-inherited-closure` の別 run で作り、同じ artifact name/file/hash 契約で review
    する。その他の accepted gate は performance bytes/hash とも `null` とし、dummy evidence を拒否する。
14. `produce-acceptance-inputs` が reviewed requirements、evidence/source、必要時だけ reviewed
    performance bytes から canonical `continuous-production-probe.json` を生成する。P1 以降で legacy
    bootstrap を解除する場合は、companion 固有の recovery drill を実施し、reviewed
    `companion-recovery-drill-source.json` から `companion-recovery-drill.json` も生成する。同じ保護 run で
    三役の実 approval receipt、candidate event、DB/policy/provider/assignment/continuous probe と optional
    performance ref の全 object closure を持つ `acceptance-final` bundle を生成し、bundle/object-set の
    SHA-256 を別途 review する。source v2とfinal v1はそれぞれclosed JSON schemaで検証し、unknown field、
    source workflow authority、sample/chain commit、HTTP/provider receiptの欠落またはkeyword制約違反を拒否する。
15. `accept-standard` が reviewed requirements、evidence、continuous probe、必要時の performance と
    companion drill、terminal bundle/object-set、current head/provider identities、三役の distinct approval
    chain を再検証する。performance の full gate verifier は immutable evidence 保存前と CAS commit 直前の
    二回実行し、完全一致した candidate event だけを CAS appendして standard だけを
    `release-accepted` にする。

collectorの下位CLIは`npm run release:acceptance-collector -- initialize|append|finalize`、final inputの
下位CLIは`npm run release:acceptance-input -- continuous-probe|companion-recovery`である。productionでは
上記workflow operationからだけ呼び、local shellの成功、fixture、同一run生成物をacceptanceへ流用しない。

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

`plan-archive-recovery` は provider mutation を行わない事前確認として残す。本番 recovery は次の
二つの保護 run に分ける。

1. `produce-archive-recovery-subject` が durable archive、availability receipt、manifest、package index、
   content hash、path closure を再読込する。build/install は行わず exact prebuilt package だけを
   materialize する。package redeploy の場合は alias を変えない immutable deployment と
   `DeploymentBinding` を先に生成し、current head/target/origin/companion/emergency を束縛した canonical
   subject を upload する。
2. 人が subject SHA-256 を review し、`execute-reviewed-archive-recovery` が prior run の exact artifact を
   download する。subject/approval を再検証し、pending operation を CAS appendしてから provider mutation、
   assignment receipt/validation、terminal rollback/containment/redeploy event を順に CAS appendする。

alias 変更後の terminal CAS 失敗は成功扱いにせず pending operation を維持し、execution artifact に
reconcile-required material を残す。reviewed subject のない local shell や同一 run で mutation しない。

containment は recovery deadline と target standard を記録する。expiry だけで alias を
自動変更しない。blocking incident を継続し、source-hardened standard への recovery を
完了する。

## Reconcile

provider alias 変更と Release State append の間で process が停止した場合:

1. Release State head と pending operation を read-only で取得する。
2. provider API から全 owned domain の現在 assignment を取得する。
3. pending target/previous/emergency binding の immutable provider policy、package/index/manifest/DB/policy
   hash を store から再解決する。caller supplied policy/config は authority にしない。
4. fresh exact observation が target の場合は `state-reconciled`、assignment validation、pending terminal
   retry を続ける。全 domain が再 probe 済み previous の場合は accepted origin event/gate/floors を復元して
   rollback terminal にする。previous を回復できず、verified emergency が exact な場合だけ containment
   terminal にする。legacy bootstrap は temporary 6 時間、source-hardened containment は 24 時間の
   recovery deadline を持つ。
5. 一部 domain、unknown/ambiguous deployment、stale observation、evidence 欠損は自動推測せず blocked
   decision として停止する。

古い binding/artifact/event/evidence を reconcile の都合で削除しない。

workflow の `reconcile` operation は provider API から owned domain assignment を直接取得し、raw response
receipt と canonical observation を先に immutable store へ保存する。上記三分岐のいずれかが pending
operation、全 domain、current predecessor と exact 一致した場合だけ lifecycle を進める。caller supplied
domain/target/snapshot/provider policy は受け付けない。

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
