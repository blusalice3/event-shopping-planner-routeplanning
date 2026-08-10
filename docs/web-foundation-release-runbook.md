# Web Foundation Release Runbook

## 目的と適用範囲

この runbook は Web Foundation の immutable artifact を build、検証、prebuilt deploy、
promotion、rollback、reconcile する手順を固定する。production alias、Release State、
database、provider のいずれかを変更する操作は protected workflow と必須roleを満たすreview記録
なしに実行しない。

`dist/`、branch 名、Git tag、provider alias は release artifact の正本ではない。正本は
`release-package-index.json` が参照する content-addressed manifest/ZIP と、それらを束縛する
Release State event である。

## 現在の production blocker

この repository に保存されている policy は production activation を許可しない。blocker の正本は
`node scripts/verify-foundation-policy.mjs --json`、
`node scripts/verify-phase-exit-external-prerequisites.mjs --json`、
`node scripts/verify-phase-exit-readiness.mjs --json` の machine-readable 出力である。

- `config/provider-policy.json` の provider/team/project/domain/WAF/log-retention が未設定
- `config/db-compatibility-contract.json` の remote observation と migration 適用が未完了
- `config/release-state-store.json` の host/database/executor/CA/backup owner が未設定
- `config/approval-policy.json` の Organization repository と三つの reviewer team が未設定
- Team membership確認用の`FOUNDATION_APPROVAL_GITHUB_TOKEN`が未設定
- `config/foundation-p0a-authorities.json` のpreview alias authorityが未設定で、bootstrap seed 4値が未採取・未固定
- `config/metrics-retention-policy.json` の backup owner、remote cron、last-success observation が未設定
- startup burst API の production WAF/rate 値と provider log retention が未観測

fixture の artifact verifier が通っても production eligible を意味しない。
`verify-foundation-policy.mjs --require-production-ready` と production binding を要求する builder が
上記を fail-closed で拒否する状態が正しい。blocker 件数や code を手作業で別管理しない。

## 1人・1 GitHub accountの運用設定

Formal Exitは`releaseOwner`、`dataSafetyReviewer`、`operationsReviewer`の三役を維持するが、
同一GitHubユーザーが複数roleを兼任してよい。監査用のrole-bound approval IDと三つのreviewer
teamはdistinctのまま維持し、`providerReviewerId`だけ重複を許可する。一回のauthoritative
GitHub Environment承認は、そのユーザーについてGitHub APIで確認できた各team membershipから、
必要な二役または三役のreceiptへ決定論的に展開される。

human operator modelは`single-human-single-github-account/v1`である。collector、baseline選定、audit、
実機試験、review、publish、三つのapproval roleを同じ実在GitHub accountが担当できる。role/action fieldと
review記録は省略せず、同じloginを正直に記録する。架空の別人accountを作らない。別run、時刻順序、
immutable artifact/hash、OIDC、CASは維持する。DB/provider/deviceのservice credentialは同じ一人が管理できるが、
権限境界とsecretは統合しない。

設定手順:

1. repositoryのSettingsでEnvironmentの`Required reviewers`を利用できるplanか確認する。
   GitHub Free/Pro/Teamではpublic repositoryだけが対象であり、private/internal repositoryで項目を
   利用できない場合は、対応planへ変更するまでFormal Exitを開始しない。
2. repositoryのownerがGitHub Organizationであることを確認する。個人account所有なら、Organizationを
   作成してrepositoryを移管する。移管後はlocal repositoryの`origin`、GitHub/Vercel連携、protected
   `main`を新repositoryに合わせ、以降の設定を移管先で行う。protected `main`はPull Requestと必須status
   checksを維持するが、required approving reviewsを0にし、Code Owner reviewを必須にしない。
3. GitHub Organizationに`release-owners`、`data-safety-reviewers`、
   `operations-reviewers`など三つのdistinct Teamを作る。
4. 兼任する同じGitHubユーザーを三つすべてのTeamへ追加し、membershipが`Active`であることを確認する。
5. 三つのTeamそれぞれへ移管後repositoryのread以上のaccessを付与する。
6. GitHubの`foundation-release-state` Environmentを作成し、三つのTeamをRequired reviewersへ登録する。
   GitHub側は登録したuser/teamのうち一つの承認でjobを進めるため、本実装がその一回の承認を三役へ展開する。
   管理者によるprotection ruleのbypassは無効にし、`Start all waiting jobs`を使わず必ず通常のreviewを残す。
7. 一つのaccountがworkflow開始とEnvironment承認を行うため、Environmentの`Prevent self-review`を
   必ずOFFにする。別automation/accountを前提にしない。
8. fine-grained PAT作成画面で`Resource owner`を移管先Organization、`Repository access`を
   `Only select repositories`の対象repositoryだけにする。Organization permissionは`Members: read`、
   repository permissionは`Actions: read`だけを設定する。Organization側の承認やSSO authorizationが
   必要なら、`Pending`ではなく利用可能になったことを確認する。有効期限は24時間観測と再試行期間を
   十分に含める。
9. PATを`foundation-release-state` Environment secretの
   `FOUNDATION_APPROVAL_GITHUB_TOKEN`へ保存する。自動`GITHUB_TOKEN`ではOrganization membershipを
   検証できない。token値をconfig、log、artifactへ書かず、期限前にrotationする。
10. 実在する外部設定を確認した後、`config/approval-policy.json`の`repository`、`workflowRef`、
    三roleのTeam slugを確定する。`humanOperatorModel: "single-human-single-github-account/v1"`、
    `distinctApprovalIds: true`、`distinctProviderReviewerIds: false`を維持し、
    `bindingStatus`を`configured`、`blockerCodes`を空配列にする。この最終configをPR経由でprotected
    `main`へmergeし、そのmerge SHAを以降のsource SHAとして使う。
11. protected jobが待機したら、対象repository、workflow、source SHA、operation、subject hashを確認し、
    `Approve and deploy`を一回実行する。collectorが必要roleへ展開したことはartifactとRelease Stateで確認する。
12. release、operation、subject hashが変わるたびに新しく承認する。以前のreceiptは再利用しない。

このsingle-account modelは全human roleを対象にする。同じ人物が実施とreviewを行えるが、reviewは
evidence確定後の別actionとして後の時刻を記録する。producer/reviewer run、DB credential、distinct
source/build/deployment/profile、24時間観測、minimum sampleなどの非人物分離は変更しない。

またapproval policyのhashが変わるため、手順10の最終binding/configをprotected `main`へmergeしたSHAで
`collect-foundation-bootstrap-recovery`を再実行し、その後の別runで
`produce-foundation-baseline-closure`を再実行する。続いて旧policy hashを参照する後続の
bundle、closure、approvalをすべて再生成し、旧証跡を流用しない。
`collect-foundation-external-bindings`は診断用に再実行してよいが、P0-BASELINE bundleの正式入力ではない。

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
- `DB_COMPATIBILITY_OBSERVER_DATABASE_URL` (`sslmode=verify-full`、read-only observer)
- `DB_COMPATIBILITY_OBSERVER_CA_PEM`
- protected workflow の `GITHUB_TOKEN` / OIDC request binding
- `FOUNDATION_APPROVAL_GITHUB_TOKEN`（Organization `Members: read`、repository `Actions: read`）

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

## Phase 0A baseline closure

正式な採取は protected `Foundation release` workflow を使い、入力は常に
`source_sha`、`operation`、`request_json` の3件だけにする。

Phase 0A は次の順序を変えない。すべて protected `main` の別runで実行する。seed、recovery、closureの
`request_json`はexact `{}`、bundleの`request_json`は手順7のclosed objectだけにする。

1. provider、application DB、control store、approval policyを構成したPRで
   `config/foundation-p0a-authorities.json` を `bootstrap-seed-pending` にする。
   `blockerCodes` は `p0a-bootstrap-deployment-binding-seed-pending` の1件、
   `bootstrapSourceSha`、`rawDistManifestSha256`、`deploymentBindingSha256`、
   `deploymentSeedAuthoritySha256` はすべて `null` にする。`previewAliasSuffix`にはproviderで所有・使用可能な
   非production専用suffixを固定し、production domain、その親domain、そのsubdomainは指定しない。
   P0Aのseed/recovery/closureはこのP0A policyだけをpreview containment authorityとして使うため、
   `config/artifact-control-store-drill.json`の構成を前提にしない。P0Cは未構成のままP0Aを完了できる。
2. merge後の40桁main SHAを`source_sha`にし、
   `seed-foundation-bootstrap-deployment-binding`を`request_json={}`で実行する。このrunだけが
   pinned Node 24.19.0/npm 11.19.0でcurrent mainのraw distをbuildし、containment deployment、
   deployment binding、seed authorityをcreate-onlyで保存する。callerがsource以外のhash、run、
   artifact pathを入力する欄はない。
3. 成功runのSummaryに表示される次の4値をコピーする。
   `Bootstrap source SHA`、`Bootstrap raw-dist manifest SHA-256`、
   `Bootstrap deployment binding SHA-256`、`Bootstrap deployment seed authority SHA-256`である。
   Artifact内JSONやローカル再buildの計算値で置き換えない。
4. 次のPRでは`config/foundation-p0a-authorities.json`だけを正本として、上の4値をそれぞれ
   `bootstrapSourceSha`、`rawDistManifestSha256`、`deploymentBindingSha256`、
   `deploymentSeedAuthoritySha256`へ固定する。`bindingStatus`を`configured`、
   `blockerCodes`を空配列にしてmergeする。`config/foundation-baseline.json`は変更しない。
5. 4値を固定した新しいmain SHAで`collect-foundation-bootstrap-recovery`を
   `request_json={}`で実行する。collectorはP0Aに固定された完了済みseed runをGitHub Run APIで
   reviewし、seed runと異なるcurrent runのOIDCでforward/recovery preview、route/provider再観測、
   全preview cleanupを行う。deployment URL取得後はprovider解決やroute probeが失敗してもそのURLを使って
   compensating deletionを行う。collector自身のrunをreviewしてはならない。
6. 5と同じmain SHAの後続runで`produce-foundation-baseline-closure`を
   `request_json={}`で実行する。CLIはcurrent runを除外して、同じsourceの完了済みrecovery
   artifactを自動検出し、Run API、Artifact API digest、ZIP、exact
   `foundation-bootstrap-recovery.json`をreviewする。run ID、attempt、hash、pathは入力しない。
   保存される`foundation-baseline-closure/v2`自体がreviewed recovery artifact authorityを参照し、
   readback時にも同じchainを再検証する。
7. 6の成功runのSummaryに表示される`Foundation baseline closure SHA-256`をコピーする。
   `P0-BASELINE`用の`produce-phase-exit-authority-bundle`を、次のexact `request_json`で別runとして
   実行する。closure/recovery/seedのrun ID、attempt、artifact path、個別evidence hashは入力しない。

   ```json
   {
     "phase_authority_foundation_baseline_closure_sha256": "<Summaryの64桁SHA-256>",
     "target_gate": "P0-BASELINE"
   }
   ```

   producerはclosureをRelease Stateからreadbackし、closure内のprovider、application DB read-only
   binding、sequence/headが0の未初期化control store、approval/OIDC、review済みrecovery artifactを
   再検証して、既存の二つのformal authority (`external-bindings`と`bootstrap-recovery-drill`)を生成する。

8. 成功したbundle producerのSummary/artifactからpackage SHA-256、review SHA-256、run ID/attemptを確認し、
   別runの`publish-phase-exit-authority-bundle`へ渡す。seed、recovery、closure、bundle producer、publisherは
   それぞれ別runにし、同じaccountで順番に実行してよい。

workflow が呼ぶ下位CLIは次のとおりである。local実行結果はformal authorityに昇格しない。

```powershell
npm run provider:foundation-bootstrap-deployment:seed -- `
  --namespace $env:RELEASE_STATE_NAMESPACE `
  --binding $bindingPath `
  --output $seedAuthorityPath

npm run provider:foundation-bootstrap-recovery:collect -- `
  --namespace $env:RELEASE_STATE_NAMESPACE `
  --output $bootstrapRecoveryPath

npm run release:produce-baseline-closure -- `
  --namespace $env:RELEASE_STATE_NAMESPACE `
  --output $closureResultPath

```

`provider:foundation-external-bindings:collect`はprovider/DB/store/approvalの独立診断には使用できるが、
そのartifactまたはrun selectorをP0-BASELINE bundleへ渡す経路はない。formal bundleの唯一の上流入力は、
上記のreview済みclosure SHA-256である。

`config/foundation-baseline.json` は historical baseline の正本であり、production binding が
確定しても書き換えない。Phase 0A の解消結果は、clean closure producer source と独立した
P0Aのprovider-bound `bootstrapSourceSha`、historical `baselineEvidenceSha256`、provider
observation/deployment binding、application DB provisioning binding、control store、raw-dist
manifest、recovery rehearsal、reviewed recovery artifactを束縛するimmutable baseline closure
として保存する。

`foundation-p0a-authorities-policy/v1`はFormal authorityがまだ0件のpre-admission draft中に、
上記4値、`previewAliasSuffix`、`bootstrap-seed-pending`を追加して置換した。最初の正式seedをadmitした後は
同じv1を再定義せず、将来shapeを変更する場合はv2へ上げる。bootstrap recoveryのraw authorityと
公開observationは、P0A-safe preview authorityと補償cleanupを含む現在shapeをそれぞれ
`foundation-bootstrap-recovery-raw/v2`、`foundation-bootstrap-recovery-observation/v2`として保存し、
旧v1 media/kind/schemaは受理しない。

Phase 0A の application DB authority は configured host/database/read-only observer role/TLS/CA
までを固定する。migration checksum、remote schema/privilege fingerprint、retention は Phase 0D
の authority で後から確定するため、baseline closure の作成に `remote-verified` observation を
要求しない。historical metrics DB fingerprint が `null` だった事実も closure に明示して残す。

先行する別の protected run で、次を Release State store に保存してreviewする。

1. fresh provider observation を使って作成した legacy bootstrap の deployment binding。producer が
   保存した provider observation SHA-256 と binding 内の provider policy reference を記録する。
2. deployment binding と同じ bootstrap source/raw-dist/archive を復元した recovery rehearsal。
   rehearsal は別 run の trusted OIDC receipt と reviewed successful workflow run を参照し、binding ID、
   deployment ID、archive SHA-256、raw-dist manifest SHA-256、復元時間、data-loss absence を exact に
   束縛する。

closure producer run はfull historyをcheckoutし、closure sourceのworktreeがcleanであること、
P0Aのbootstrap source commit/treeが存在することを確認する。seedのbootstrap/workflow sourceは
同じSHA、後続recovery/closureのworkflow sourceは新しいmain SHAでよい。provider binding、package
index、recovery rehearsalのsourceはbootstrap sourceと一致しなければならない。

下位の closure producerを診断する場合、protected environment には
`REQUESTED_OPERATION=produce-foundation-baseline-closure`、Release State
DB URL/CA、application DB observer URL/CA、GitHub OIDC request binding を設定する。CLI は provider
や DB の secret/URL/CA を出力せず、content-addressed support objects と closure を create-only で
保存して同じ media type/hash/bytes を readback する。結果 file も `wx` で作成する。

caller の `passed`/`status`/boolean、手作業 JSON、存在しない SHA-256 は authority にならない。
closure は1時間、provider observation は provider policy の freshness、recovery rehearsal は30日を
超えたら失効する。失効時は provider observation/rehearsal を新しい protected prior run で再採取し、
review 後に新しい closure を作る。同じ run で rehearsal と closure を閉じない。同じaccountが
先行runのimmutable resultを確認し、後続runでclosureを作ってよい。

## Production remote DB observation

Phase 0D の remote DB fingerprint は、local shell の `db:observe` 成功や手作業の JSON では
確定しない。`config/db-compatibility-contract.json` の observation authority（host、database、
observer role、production CA hash、freshness）と `config/release-state-store.json` を production 値へ
構成した後、protected `Foundation release` workflow を次の三つの別 run に分ける。

1. `collect-remote-db-observation` を protected `main` の exact `source_sha` だけで dispatch する。
   `db_observation_sha256`、`db_observation_production_sha256`、`db_observation_run_id`、
   `db_observation_run_attempt` は空のままにする。
   workflow は provider API から fresh observation を取得し、CSP report credential が application
   delivery edge に 0 件であることを検証してから、専用 read-only observer と pinned CA で production
   PostgreSQL を観測する。
2. collector は configured host/database/role、PostgreSQL major、migration checksum、required
   table/function/privilege、freshness を検証する。canonical `remote-db-observation.json` は新規作成だけを
   許し、secret、connection URL、CA、raw row を含めない。同じ canonical bytes を content-addressed
   Release State store へ保存し、URI、SHA-256、media type、byte length、committed bytes を readback
   検証する。CSP credential edge の判定に使用した exact provider observation bytes と configured
   provider policy も、それぞれ専用 media type の canonical object として同じ immutable store に保存し、
   readbackする。GitHub Actions OIDC token は trusted issuer/JWKS で検証し、protected environment、
   workflow ref、source、run ID/attempt を束縛した receipt だけを保存する。最後に operation、source、
   run ID/attempt、remote DB observation、provider observation/policy、OIDC receipt の全 reference を束縛した
   canonical production receipt を保存・readbackした後だけ成功する。

`operatorBoundedFunctionOnly`はDB全体の管理権限ではなく、production application dataに対する
**bounded application observer**の権限を示す。collectorは接続中の`foundation_db_observer`について、
role membershipが0、所有objectが0、`NOINHERIT`、current DBの`CONNECT`だけを許可し、`CREATE`は全DBで0件、
current DBのplatform既定`TEMPORARY`はgrant optionなしだけを許可する。`TEMPORARY`は一時object用であり、
application relationへの権限を表さない。`default_transaction_read_only=on`とproduction objectへのexact ACLを
別々に検証する。

relation/table/column/sequenceは`public`だけでなく、`auth`、`storage`、`net`、`extensions`を含む
contract記載のmanaged schemaと、未知のprivate schemaを含む全non-system schemaを列挙する。
application-data側で許可するrelation権限は`supabase_migrations.schema_migrations`の`SELECT`だけである。
一方、stock Supabaseが`PUBLIC`へ付与するplatform object権限は、`cron.job`の`SELECT`、
`cron.job_run_details`の`SELECT/DELETE`、`extensions.pg_stat_statements`と`_info`の`SELECT`、
`net._http_response`と`net.http_request_queue`の8 table権限、対応sequenceの`USAGE/SELECT/UPDATE`に限り、
object/table/column/sequenceの完全なmatrixをcontractへ固定したreview済みplatform baselineとして許可する。
これはapplication dataの閲覧・更新権限を表さず、`operatorBoundedFunctionOnly`をDB-wide権限証明へ拡張しない。
baseline外のcolumn-only grant、全grant option、未知object、missing/extra privilegeは拒否する。
schemaの実効`USAGE`は`public`、`supabase_migrations`、contractで固定したmanaged baselineの`net`だけ、
`CREATE`と全grant optionは0件とする。未知schemaの`USAGE`、object権限、managed schemaのrelation/sequence権限が
1件でもあれば証跡を作らない。

application routineは全non-system schemaから列挙し、`public`/`supabase_migrations`で実行可能なのは定義SHA-256、
owner、language、result signatureを固定した3つのbounded read functionだけとする。managed schemaで
platformが`PUBLIC`へ与えるroutine権限はSupabase管理面のbaselineであり、このapplication-data proofの対象外だが、
observerへの直接`EXECUTE`またはgrant optionは拒否する。`pg_catalog`/`information_schema`のsystem routineも
application proofの対象外である。managed relation/column/sequenceについてもobserverへの直接ACLは0件とし、
許可したmatrixが`PUBLIC`継承baselineと完全一致することを確認する。managed schemaの既存ACLをobserver migrationから
一括`REVOKE`してはならず、operatorへstock platform ACLの削除を要求しない。baseline driftはcontractを自動緩和せず、
Supabase changeとして独立reviewする。

同じsnapshotで、2つのraw tableのowner、RLS/force-RLS、全columnの型/null/default/identity、空のpolicy/trigger set、
全constraintの種類と定義SHA-256、5つのrequired routineすべての定義SHA-256/owner/language/resultを完全一致で確認する。
service_roleは両raw tableへのtable-level `INSERT`と対応identity sequenceへの`USAGE`だけを持ち、column-only
partial INSERTで代用できず、他のtable/column/sequence権限とgrant optionはすべてfalseでなければならない。
CSP dormant期間は`PUBLIC`、`anon`、`authenticated`のCSP table/column/sequence/routine権限が0件、policy setも
空であることをprovider credential不在とは独立して確認する。

Supabase migration historyはcontractで固定した6行のversion、name、statement count、statement bytes hashと
完全一致させる。expected rowだけをfilterして確認せず、後から追加された未review migrationが1行でもあれば拒否する。

remote DB observationの14-key v1 shape自体は変更していない。この強化はFormal admissionが0件の
pre-admission期間中に既存booleanの意味を狭めたreplacementであり、observer migration SHA-256を更新して
`db-compatibility-contract` fingerprintを変更した。従って旧collectorのv1 bytesは新contract fingerprint、
exact source SHA、protected producer runの照合を通らず、再利用できない。最初のFormal observationをadmitした後に
shapeまたは意味を変更する場合は同じv1を再定義せず、media/kind/schemaをv2へ上げる。

3. 完了した producer run の summary/artifact と GitHub Run API 上の `completed` / `success`、source、
   workflow path を review し、observation SHA-256、production authority SHA-256、run ID、run attempt を
   記録する。artifact に含まれる authority output は reference だけであり、secret や OIDC token を含まない。
4. state 初期化では `produce-state-initialization-subject`、既存 state の DB 更新では
   `produce-db-contract-activation-subject` を別の reviewed run で dispatch し、上記四値と DB contract
   hash、operation ID、その他その操作に必要な evidence hash を渡す。CLI は GitHub Run API の raw
   response と canonical reviewed-run receipt を immutable store に保存し、producer run が同じ source、
   workflow、completed/success であり、現在 run とは異なることを再検証する。
   production receipt、reviewed GitHub run receipt、observation reference の対応を閉じた canonical
   authority bundle にして保存するため、別operationの成功runと任意observation hashの組合せは拒否する。5. subject bytes と SHA-256 を review した後、さらに別 run の `initialize-release-state` または
   `activate-db-contract` で実行する。実行直前にも reviewed producer receipt、remote observation の
   canonical bytes/media type/hash/freshness に加え、provider observation/policy と OIDC receipt の
   canonical bytes/media type/hash/semantic binding/freshness、current Release State を再読込する。

configured freshness window（既定 300 秒）を producer、subject review、execute の途中で超えた場合は、
window を延長したり古い subject を再利用したりしない。古い subject と production authority を不採用にし、
新しい `collect-remote-db-observation` run を dispatchして provider/DB observation と production authority を
再収集・reviewし、その新しい四値から新しい subject を生成して review後に実行する。同じoperator accountが
各 run の完了直後に immutable hash を確認し、期限切れならこの再収集手順へ戻る。

producer と subject consumer を同じ run にまとめない。caller supplied observation JSON、status、
conclusion、任意の store URI、ローカルで生成した observation を代用しない。secret は workflow step の
environment 以外へ渡さず、artifact や step summary に値を出力しない。

## Formal phase exit external authority

正式な phase exit 判定は Release State の live namespace と immutable evidence だけを読む。namespace や
review済み package reference がない repository/quality snapshot は、安全側の `0/16` を維持する。
repository mechanism は次の14 external authorityすべてで producer と readerを実装済みである。
checked-in bindingは未構成で、live observationは `0/14` のため、実装済みという事実だけではgateを閉じない。

| Gate           | Authority                                                                       | Collector                                |
| -------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `P0-BASELINE`  | `external-bindings`、`bootstrap-recovery-drill`                                 | protected release                        |
| `P0-TOOLCHAIN` | `quality-run`                                                                   | protected main `quality.yml`             |
| `P0-ARTIFACT`  | `artifact-provider-control-store-drill`                                         | protected release                        |
| `P0-DATA`      | `remote-db`、`retention`、`backup-restore-rehearsal`、`startup-waf-observation` | protected release / retention workflow   |
| `P0-RELEASE`   | `physical-performance`                                                          | protected release                        |
| `P1-PWA`       | `pwa-multiclient-drill`                                                         | strict receipt + 3 reviewed stage        |
| `P2A-LOCAL`    | `production-request-graph`                                                      | protected production observation job     |
| `P2B-REPORT`   | `csp-report-observation`                                                        | protected production observation job     |
| `P4-CSP`       | `deployed-csp-flow`                                                             | protected production observation job     |
| `P7-IDB`       | `idb-device-compatibility`                                                      | managed Windows runner、3 reviewed stage |

review/publishはgate単位に行う。

1. exact sourceの必要collectorをそれぞれ別runで完了する。同じrunでproducerとreview actionを兼ねないが、
   同じaccountが各別runを順番に担当してよい。
2. `produce-phase-exit-authority-bundle`をdispatchする。`request_json`には`target_gate`と、対象gateが
   必要とするexact selectorだけを含める。`P0-BASELINE`は上記closure SHA-256の1件、その他のgateは
   exact run ID/attemptまたはremote DBの4 referenceを使う。
3. producerはGitHub Run API → Artifact API digest → downloaded ZIP bytes → ZIP内exact single file →
   authority固有semantic verifierの順に照合する。API response、ZIP、file、closed receiptをimmutable
   storeへ保存・readbackしてから`phase-exit-authority-package.json`を生成する。
4. 同じoperator accountがproducer完了後に、package SHA-256、bundle SHA-256、review receipt SHA-256、
   run ID/attemptを別review actionとして確認する。
5. 別runの`publish-phase-exit-authority-bundle`へ`target_gate`、producer run ID/attempt、package SHA-256、
   review receipt SHA-256を渡す。publisherは全上流とcurrent Release State subjectを再解決し、published
   bundle referenceをcreate-only保存・readbackする。

callerが作ったcandidate directory、collector manifest、手動downloadしたJSON、generic release eventの
`evidenceRefs`は入力経路ではない。producer/publisherとcollectorを同じrunにせず、stale、future、wrong source、
wrong workflow/gate/kind/media、duplicate、extra key、tamper、generic substitutionは新しいrunで再収集して解消する。

## P0C artifact/control-store drill

`config/artifact-control-store-drill.json`をproduction namespaceと分離したprovider/DB値で構成する。
credentialはadministrator、drill executor、denied-reader projectionの3種類を混用しない。
denied-reader projectionは同じdisposable drill DBにだけ作るnon-production credentialであり、production
Release Stateのcredentialをdrill DBへ渡してはならない。旧
`ARTIFACT_DRILL_PRODUCTION_READER_DATABASE_URL`は互換fallbackとして扱わず、
`ARTIFACT_DRILL_DENIED_READER_DATABASE_URL`を別credentialとして設定する。

protected releaseで`operation=collect-artifact-control-store-drill`、`request_json={}`を実行する。
collectorは専用non-promotable build purpose、standard/containment二重build、preview deploy/route、
CAS/idempotency、stale transaction、実SQLSTATE `40001` / `42501`、denied-reader projectionによる
drill evidenceの直接`SELECT`とfunction経由writeがともに`42501`で拒否されること、
alias/deployment/schemaのcleanupと404/absenceを確認する。production alias/domainへの
接触があれば失敗する。artifactをreview後、`P0-ARTIFACT`のauthority bundleへrun ID/attemptを渡す。

## Backup/restore rehearsal

`config/backup-restore-provider-contract.json`と`config/phase-exit-external-prerequisites.json`を構成し、
restore targetはnonproductionに限定する。tracked migration
`20260810000000_foundation_application_observer.sql`と
`20260810010000_foundation_backup_integrity.sql`は通常のSupabase migration history経由でproductionへ
適用し、SQLだけをDashboardで個別実行しない。既存の同名roleが見つかってmigrationが`42710`で止まった場合は
衝突として調査し、既存roleを自動変更・削除して続行しない。

migrationはpasswordを保存しない。production source側で`foundation_db_observer`、
`foundation_backup_source_reader`、`foundation_backup_restore_reader`へそれぞれ別passwordを外部secret管理から
設定する。3 roleは同じ一人が管理できるが、credentialを共用しない。physical backupはcustom roleのpasswordを
新projectへ引き継ぐ証明にならないため、clone作成後はrestore project側の
`foundation_backup_restore_reader` passwordを別値で再設定してからprotected secretへ登録する。

Supabase Dashboardのsource projectで`Database` → `Backups`から対象recovery pointを選び、
**Restore to a New Project**で新しいprojectを先に作る。public Management APIにはこのclone provenanceを
取得・検証するdocumented endpointがないため、collector自身はcloneを作成しない。また
`restore-pitr`によるsource projectへのin-place restoreは一切呼ばない。Management APIが返すlatest PITR
recovery pointはDashboardで選択したpointのprovenanceではない。実行者はDashboardでlatest recovery pointを
明示的に選択し、その画面と作成されたproject refをreview対象の外部証跡として保存する。これを確認できないrunは
Formal evidenceとして承認しない。

新projectはsourceと同じorganization/region、sourceとは異なるproject ref、
`restoreTarget.namespacePrefix`で始まる固有名、選択recovery point以後かつ
`maximumProjectAgeSeconds`以内の作成時刻にする。Dashboardでrefを再確認したうえで
`restoreTarget.projectRef`へexact値を設定し、削除対象であることを確認して
`cleanupApproval=delete-exact-project-after-verification`を維持する。この承認は、identity safety checkを通過した
exact projectをcollectorが最終的にDELETEする明示許可であり、DB integrity検証が失敗した場合も安全確認後なら
cleanupを実行する。残したいprojectを指定してはならない。protected secretは設定が許可する環境変数名だけを使う。

`operation=collect-backup-restore-rehearsal`、`request_json={}`で実行する。collectorはprovider APIの
completed physical backup/PITR recovery pointとsource/restore両projectをGETで観測する。DELETE前にexact ref、
別project、同一`organization_slug`/region、name prefix、作成時刻/freshness、各`database.host`を
fail-closed照合する。DB URLはManagement APIのexact direct host、port `5432`、database `postgres`だけを許可し、
source/restoreでhost・role・passwordが異なる別TLS credentialを使う。URL内の`sslmode`は検証後にruntime URLから
除去し、pin済みCAと`rejectUnauthorized=true`だけを`pg`へ渡す。両DBのmigration headと、各rowをcore PostgreSQL
SHA-256で正規化した内容hashが一致した時点までをRTOとする。その後restore projectをもう一度GETし、ref /
`organization_slug` / region / name / created_at / `database.host`が最初のinspectionから不変であることを
確認してからだけDELETEする。
APIだけではclone由来を証明できないという限界は、このmanual Dashboard action、
project identity/freshness、DB cryptographic equalityの組合せで閉じる。

read-only証明はrole属性、membership、ownership、schema/table/function privilegeに加え、read-write
transactionでの実DML/DDLがSQLSTATE `42501`になることを含む。backup readerはraw tableをSELECTできず、
`read_foundation_backup_restore_integrity()`だけを実行できる。collectorはexact restore projectをDELETEし、
`GOING_DOWN`等の限定transitionでもproject identityが不変であることを再検証しながら404までpollする。
cleanup/absenceを一つのclosureにし、review後に`P0-DATA` bundleへrun ID/attemptを渡す。

## Managed-device PWA / IDB drill

`config/phase-exit-external-prerequisites.json`へmanaged Windows runner group/labels、exact Chromium、
enrollment hash、distinct absolute profile root/path、installed PWA policy/app ID、Ed25519 public key
fingerprintを構成する。秘密鍵はmanaged runner secretだけに置く。

`P1-PWA`では、まずprotected `collect-pwa-multiclient-drill`を独立した先行runとして
`request_json={}`で実行する。通常browser tabと実installed PWAをpolicyで指定したdistinct profile pathから
起動し、明示的save/flush、close前controller不変、全client解放後のnatural activation、current → rollback →
currentのcontroller/source遷移をstrict signed receiptへ記録する。

このstrict runを開始する時点で、current accepted standardと唯一のeligible rollback standardはどちらも
canonical stable/versioned capability・identityを持ち、`pwaLifecycle=prompt-close-all-v1`でなければならない。
legacy auto-update artifactをformal strict receiptへ流用しない。まずprompt対応rollback predecessorを、fresh
exact-source evidence、24時間以上のcontinuous observation、三役分のrole-bound approval
（同一provider reviewerによる兼任可）で`P1-PWA` standardとして
acceptする。次にsource、build、binding、provider deployment ID/URLがすべて異なるprompt対応current candidateを、
`candidate_gate=P1-PWA`を維持した独立のbuild/acceptance run群で同じfloorへacceptする。same-floor時のformal
predecessorは`P1-PWA`自身ではなく`P0-RELEASE`であり、終端`P8-CLEAN`ではsame-floor replacementを禁止する。

二つ目のacceptance後、current candidateだけがactiveで、最初のprompt standardだけがsole eligible rollback
standardであることをRelease Stateから確認してstrict runへ進む。caller flag、合成identity、以前のevidence、
approval receiptを再利用してこのbootstrap順序を迂回しない。

次に`collect-managed-device-live-stage`を3つの別runで current → rollback → current の順に実行する。stage 1の
採取後にreviewed archive recoveryでcurrentからsole eligible rollbackへ切り替え、stage 2の採取後にもう一度
reviewed archive recoveryを実行して元のcurrentへ戻してからstage 3を採取する。二つのterminal eventはどちらも
`rollback-activated`でなければならず、rollback inventoryは各terminalで原子的に入れ替わる。各collectorは
`request_json={}`で、通常browser tabは通常URL、installed PWAはOSの実shortcut/app IDから起動する。すべての
client processをstage間でclose/reopenし、同じdevice/profile、current Release State history、accepted deployment、
Service Worker/capability bytes、IndexedDB controller/raw observationをEd25519署名する。

`P1-PWA`のbundle producerにはstrict runのID/attemptを
`phase_authority_pwa_receipt_run_id` / `phase_authority_pwa_receipt_run_attempt`で渡し、続けて3 stageの
各run ID/attempt selectorを渡す。producer/readbackはstrict runが3 stageより前で、4 collector runとproducer
runがすべてdistinctであることを検証する。さらにcomposite authorityがexact source/device、current/rollback
deployment、各stageのcontroller、strict receiptとstageの時刻・current → rollback → current順序を再検証する。

compositeを作っただけではExitにならない。`produce-phase-exit-authority-bundle`を
`target_gate=P1-PWA`で実行し、exact package bytes/hashを別runでreviewしてから
`publish-phase-exit-authority-bundle`を実行する。最後に`attest-phase-exit`を`target_gate=P1-PWA`で実行し、
immutable Release Stateへ`P1-PWA` attestationがappendされたことをreadbackする。

`P7-IDB`はstrict PWA receiptを要求せず、従来どおり3 stageのrun ID/attemptだけをbundle producerへ渡す。
単一run、standalone風browser window、loopback、異なるprofile、caller supplied stage/status/hashは正式証跡に
ならない。

## 16-gate attestation と pre-initialization seed

formal sequenceは `P0-BASELINE`、`P0-TOOLCHAIN`、`P0-ARTIFACT`、`P0-DATA`、`P0-PROMOTE`、
`P0-RELEASE`、`P1-PWA`、`P2A-LOCAL`、`P2B-REPORT`、`P3-XLSX`、`P4-CSP`、
`P5-DUAL`、`P5-LIST`、`P6-APP`、`P7-IDB`、`P8-CLEAN` の16件である。

Release State初期化前は次の順序を厳守する。

1. published `P0-BASELINE` bundleを指定して`attest-phase-exit`を実行する。
2. そのattestation SHAをpredecessorにして`P0-TOOLCHAIN`をattestする。
3. `P0-TOOLCHAIN` attestationをpredecessorにして`P0-ARTIFACT`をattestする。
4. `produce-state-initialization-subject`へ上記3件のexact attestation SHAをそれぞれ渡す。
5. subjectを別runでreviewし、`initialize-release-state`を実行する。seedのskip/reorder/substitutionは拒否される。

初期化後は、対象gateのpublished bundle、直前gateのattestation、live supporting event/current accepted
deploymentを再解決して`attest-phase-exit`を順に実行する。P0-PROMOTEはnormal
`promotion-prepared` → `promote-standard` → `deployment-assigned` → `assignment-validated`の同一operation
chainだけを許し、reconcile/recovery assignmentで代替しない。P0-RELEASE以降は対象gateのexact
`release-accepted`とobservation startを使う。rollback後のstale accepted snapshotは再利用できない。

P8はP7 attestationをpredecessorとするfloor QA/execution/closureからpolicy floorをactivateした後に
`P8-CLEAN`をattestする。P8自身のattestationをfloor activationの前提にして循環させない。

dispatchは`source_sha`、`operation`、canonical `request_json`の3入力だけである。現行registryの50
operationはclosed schemaで検証され、unknown/unused/missing fieldを拒否する。operation数とworkflow
coverageはtestがregistryから導出するため、文書の手作業一覧をdispatch正本にしない。

## Source-hardened pair の build

build は二つの protected run に分ける。

1. `produce-artifact-build-requirements` はrequestの必須`candidate_gate`をcurrent Release Stateから再導出する。
   通常はexact next gate、非終端のsource-only replacementだけはcurrent gateとexactly equalなfloorを許し、
   source再利用、gate skip/regression、floor drift、`P8-CLEAN` replacementを拒否する。active policy、source、
   provider/DB/toolchain/CSP authority と expected standard/containment dimensionsをcanonical
   `artifact-build-requirements.json` にする。これを
   `foundation-artifact-build-requirements-<sourceSha>` として upload する。
2. 人が requirements bytes の SHA-256 を review する。
3. `build-and-verify` は distinct prior run ID と reviewed SHA-256 で exact artifact を downloadし、
   current Release State から同じ requirementsを再導出する。このoperationへ`candidate_gate`を再入力せず、
   reviewed requirements内の`targetGate`をauthorityとする。head/policy/source/hashが変化した場合、同一run、
   caller supplied dimension、proposed policyからのproduction buildを拒否する。

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

bootstrap は一時 containment 専用であり、standard acceptance には使わない。先にP0Aの
provider-bound `bootstrapSourceSha`、recorded Node/npm/lockfile、raw-dist manifest hashをseed
authorityへ確定する。final DB fingerprintは後続のP0D authorityで確定する。

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

npm run release:deploy-prebuilt -- -- `
  --package $packageRoot `
  --role standard `
  --provider-observation $providerObservation `
  --idempotency-key $idempotencyKey `
  --receipt $receiptPath

npm run release:produce-deployment-binding -- -- deployment-binding `
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
   `releaseOwner` と `dataSafetyReviewer` のrole-bound receipt（同一provider reviewer可）を保存して
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
12. `produce-acceptance-requirements` は必須`candidate_gate`、current Release State、pending standard、active
    release policyの`phaseSequence`をreplayし、通常のexact next gateまたは許可された非終端same-floor gateと
    performance evidenceの要否・kindをcanonical `acceptance-requirements.json`にする。人がbytesのSHA-256を
    reviewし、後続runはexact prior run IDとhashでartifactをdownloadする。後続runはcurrent stateから同じ要件を
    再導出し、bytes/hash/candidate gateが一致しない場合、同一runのartifact、unknown/surplus gateを拒否する。
13. performance evidence は accepted gate ごとに固定する。`P0-RELEASE` は
    `P0-TOOLCHAIN` own-gate envelope、`P3-XLSX`、`P5-DUAL`、`P5-LIST` は各 own-gate
    envelope、`P8-CLEAN` は四つの historical accepted event と live archive readback を束縛した
    `performance-inherited-closure/v1` だけを許可する。P8 closure は
    `produce-performance-inherited-closure` の別 run で作り、同じ artifact name/file/hash 契約で review
    する。その他の accepted gate は performance bytes/hash とも `null` とし、dummy evidence を拒否する。
14. `produce-acceptance-inputs` は同じ必須`candidate_gate`を維持し、reviewed requirements、evidence/source、必要時だけ reviewed
    performance bytes から canonical `continuous-production-probe.json` を生成する。P1 以降で legacy
    bootstrap を解除する場合は、companion 固有の recovery drill を実施し、reviewed
    `companion-recovery-drill-source.json` から `companion-recovery-drill.json` も生成する。同じ保護 run で
    三役分の実approval receipt（同一provider reviewer可）、candidate event、DB/policy/provider/assignment/continuous probe と optional
    performance ref の全 object closure を持つ `acceptance-final` bundle を生成し、bundle/object-set の
    SHA-256 を別途 review する。source v2とfinal v1はそれぞれclosed JSON schemaで検証し、unknown field、
    source workflow authority、sample/chain commit、HTTP/provider receiptの欠落またはkeyword制約違反を拒否する。
15. `accept-standard` は同じ必須`candidate_gate`を維持し、reviewed requirements、evidence、continuous probe、必要時の performance と
    companion drill、terminal bundle/object-set、current head/provider identities、三役分のrole-bound approval
    chain を再検証する。performance の full gate verifier は immutable evidence 保存前と CAS commit 直前の
    二回実行し、完全一致した candidate event だけを CAS appendして standard だけを
    `release-accepted` にする。

三つのcandidate-aware acceptance operationは`candidate_gate`をexact一致で伝播し、requirementsの
`acceptedGate`とterminal `release-accepted.payload.acceptedGate`も同値でなければならない。same-floor
replacementでも24時間観測、全sample、三役分のapproval（兼任可）、assignment validationを省略しない。

collectorの下位CLIは`npm run release:acceptance-collector -- -- initialize|append|finalize`、final inputの
下位CLIは`npm run release:acceptance-input -- -- continuous-probe|companion-recovery`である。productionでは
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
