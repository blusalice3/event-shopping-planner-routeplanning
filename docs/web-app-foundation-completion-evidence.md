# Web App Foundation 完全性・Exit 証跡

記録日: 2026-08-10 (Asia/Tokyo)

## 結論

repository 内で実装可能な formal external authority の producer、closed contract、semantic
verifier、reviewed artifact、immutable readback、Release State replay、protected workflow は
`14/14` 実装済みである。これは「証跡を正しく採取・審査する機構」の完了を示す。

外部環境での採取・配布・承認は実行していない。そのため現在の正式判定は次のとおりである。

- formal phase exit: `0/16`
- `productionActivationReady=false`
- external authority observation: `0/14`
- production deploy / promotion / 24時間観測 / acceptance: 未実行

blocker 件数と code は文書へ固定転記しない。現在値は次の machine-readable verifier を正本とする。

```powershell
node scripts/verify-foundation-policy.mjs --json
node scripts/verify-phase-exit-external-prerequisites.mjs --json
node scripts/verify-phase-exit-readiness.mjs --json
```

checked-in DB contract は意図的に `contractStatus=local-specification`、
`remote.observationStatus=unobserved` である。`remote-verified` / `observed` は production
collector と reviewed authority が成立した後だけ許される terminal state であり、現在値ではない。

## 実装した repository mechanism

### Windows exact-file authority

- Windows の `dev` / `ino` を `Number` へ変換せず `bigint` のまま比較する。
- deployment receipt、provider observation、assignment validation を open descriptor の identity、
  size、nanosecond timestamp、bytes に束縛する。
- unsafe integer inode、same-size/same-inode race、descriptor swap、hard-link alias、既存 output、
  symlink 差替えを決定論的な負例で拒否する。

### Formal authority admission 14/14

現行の `PHASE_EXIT_EXTERNAL_AUTHORITIES` と reader branch は次の14種を一対一で実装している。

| Gate           | External authority                                                              |
| -------------- | ------------------------------------------------------------------------------- |
| `P0-BASELINE`  | `external-bindings`、`bootstrap-recovery-drill`                                 |
| `P0-TOOLCHAIN` | `quality-run`                                                                   |
| `P0-ARTIFACT`  | `artifact-provider-control-store-drill`                                         |
| `P0-DATA`      | `remote-db`、`retention`、`backup-restore-rehearsal`、`startup-waf-observation` |
| `P0-RELEASE`   | `physical-performance`                                                          |
| `P1-PWA`       | `pwa-multiclient-drill`                                                         |
| `P2A-LOCAL`    | `production-request-graph`                                                      |
| `P2B-REPORT`   | `csp-report-observation`                                                        |
| `P4-CSP`       | `deployed-csp-flow`                                                             |
| `P7-IDB`       | `idb-device-compatibility`                                                      |

すべて `collectorImplemented=true` であり、caller supplied status/boolean/hash、generic JSON、
別 workflow の successful run、手動 download file では代用できない。GitHub Run/Artifact API、
artifact digest、ZIP bytes、ZIP 内 exact single file、source/run/attempt、authority ごとの意味論を
再検証し、Release State store へ create-only put/readback した reference だけを受理する。

### P0A / P0C / backup / managed device

- P0A は configured provider、application DB read-only binding、未初期化 control store、approval/OIDC
  を採取し、historical bootstrap source の raw dist/archive を build せず forward → recovery
  redeploy する。executor source と bootstrap source は別 authority として保持する。
- P0C は production alias/namespace を拒否する non-promotable drill で、standard/containment の
  二重 build、preview deploy、route probe、3分離DB credential、CAS/idempotency、SQLSTATE
  `40001` / `42501`、cleanup を閉じる。
- backup/restore は provider API の backup/PITR/restore status、nonproduction restore、DB TLS
  connectivity、integrity、RPO/RTO、privilege/所有権、実 DML/DDL `42501` denial、cleanup を閉じる。
- P1 managed deviceは、fresh 24時間観測と三役approvalを独立に完了した二つのdistinct-source prompt standardを
  same `P1-PWA` floorで受理した後、Windows 11 managed self-hosted runner上でprotected strict signed
  prompt-close receiptを先行runとして採取する。その後、二つのreviewed archive recoveryを挟み、current →
  rollback → currentの3 reviewed stageをdistinct runで実行する。compositeはsource/device、current/rollback
  deployment、controller、二つの`rollback-activated`、原子的inventory swap、時刻・run順序を再検証する。
- P7 managed deviceは通常browser tabと実installed PWAをdistinct absolute profileで実行する既存の
  A → B → A 3-stage契約を維持し、Ed25519 device attestation、Service Worker / capability / IndexedDB raw
  authorityを同一device/profileへ束縛する。

### Phase 1 prompt-close-all

- waiting Workerの初回blocker snapshotは`flush=false`で取得し、画面へ明示的な保存操作を出す。
- user click後だけ`flush=true`を全clientへ送り、nonempty、全client responsive、blocker 0、flush error 0を
  同時に満たすまでclose guidanceへ進まない。空応答、未応答、保存失敗、snapshot error、waiting Worker
  差替えはretryまたはnotice除去へfail-closedにする。Workerへ強制activation messageは送らない。
- outer agentのSW responderとrole entryのstateful registryは別bundleに分離し、same-window/same-originの
  exact-key bridgeで接続する。UUID、client ID、source/origin、waiting Worker ownership、timeout、late/duplicate/
  malformed responseを検証し、bridge failureはunresponsive snapshotへ変換する。`event-autosave`のMapとflushは
  role bundleだけが所有し、containment roleは空registryで応答する。
- noticeはReactの`#root`外にある専用outer-agent hostへ描画し、waiting Workerごとの世代・所有権tokenで
  cleanupする。旧Workerの遅延snapshot/flushは新Workerのnoticeを上書き・削除できない。
- UIはphase、snapshot/responsive/blocker/unresponsive/flush failure数、操作種別・回数、close guidanceを
  `data-*`で公開し、authorityが日本語文言を解析しない契約にした。
- Release A forward browser drillは同一profileのprimary、secondary、standalone-equivalentを制御し、
  `save-required`観測後にsecondaryをfreezeする。実clickで`save-incomplete`を確認し、thaw後のretryで
  `ready-to-close`、production bridge上の実`event-autosave` blocker/flush、IndexedDB commit、全clientの
  clean response、close前controller不変、全client解放後だけのnatural activationを確認する。合成responseは
  初回`flush=false`表示だけに限定し、`flush=true`はproduction responderへ通す。
- prompt UI非搭載のhistorical baselineは`disabled`で従来のnatural activationを回帰し、version付き
  capabilityの両ファイルが成果物にない場合だけ`legacy-absent`を許可する。prompt対応predecessorはrepository
  bundleのdetached cloneからclean SHAで再buildし、`-RequirePromptCloseDrill`で上記操作とoffline capabilityを
  必須化する。rollback activationはcapability有無と分離し、exact `pwaLifecycle`から導出する。
  対応能力のないbaselineをrequired modeへ渡した場合はfail-closedにする。
- drillの`promptCloseAll` objectは共通closed verifierで各階層のunknown/missing field、request欠落、
  premature controller change、failure中のclose guidance、client残存、activation順序改ざんを拒否する。
  このloopback drillはrepository regressionであり、実managed Windows/PWAの外部authorityを代替しない。
- 正式P1 collectorはprotected `collect-pwa-multiclient-drill`のstrict signed receiptを先行runで採取し、
  後続の`collect-managed-device-live-stage` 3 runとimmutable compositeへ束縛する。bundle inputはcallerが
  作った成否やhashではなく、strict run ID/attemptと3 stageのexact run ID/attempt selectorだけを受理する。
- 二つ目のprompt standardは`candidate_gate=P1-PWA`をbuild/acceptance chainで維持するsource-only replacementで、
  exact floorとdistinct source/build/binding/provider deploymentを必須にする。24時間観測、全sample、三役approvalを
  再利用・省略せず、最初のstandardがsole eligible rollbackになった後だけstrict collectorへ進む。終端
  `P8-CLEAN`ではsame-floor replacementを許可しない。

### 16-gate attestation と Release State

正式順序は `P0-BASELINE` から `P8-CLEAN` までの16 gateで固定している。

1. Release State 初期化前に `P0-BASELINE` → `P0-TOOLCHAIN` → `P0-ARTIFACT` の immutable
   pre-initialization attestation chainを作る。
2. `initialize-release-state` subject は上記3件の exact seed referenceを必須にし、初期 ledgerへ取り込む。
3. `P0-DATA` 以降は live state replay、exact supporting event、current accepted deployment、
   predecessor attestation、reviewed external authority bundleを再解決する。
4. protected `attest-phase-exit` operationだけが `phase-exit-attested` を CAS appendする。
5. `P8-CLEAN` は P7 attestation を predecessor とした floor QA/execution/closure/activation の後に
   attestationを作り、循環した自己証明を許さない。

`workflow_dispatch` の入力は `source_sha`、`operation`、`request_json` の3件だけである。
現行 registry の50 operationは operation別 closed schemaで正規化され、unknown/unused/missing field、
wrong predecessor、同一 run による自己 review を checkout 後の早い段階で拒否する。operation 数は
testが registryから導出し、workflowの silent-success branchがないことを検査する。

## Gate 別の正式状態

| Gate           | Repository admission                                  | 正式状態と残る外部作業                                           |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `P0-BASELINE`  | baseline、external bindings、bootstrap recovery       | 未達。provider/DB/control store/approval binding と drill 未観測 |
| `P0-TOOLCHAIN` | exact toolchain、reviewed quality                     | 未達。protected quality artifact 未観測                          |
| `P0-ARTIFACT`  | provider/control-store disposable drill               | 未達。configured provider/PostgreSQL drill 未実行                |
| `P0-DATA`      | remote DB、retention、backup/restore、WAF、state init | 未達。production authority 未構成・未観測                        |
| `P0-PROMOTE`   | normal promotion/assignment chain                     | 未達。production assignment 未実行                               |
| `P0-RELEASE`   | accepted gate、physical performance                   | 未達。30 samples、24時間観測、三者承認 未実行                    |
| `P1-PWA`       | accepted gate、strict receipt + managed 3-stage PWA   | 未達。2-source acceptance、strict、live往復、attestation未実行   |
| `P2A-LOCAL`    | accepted gate、production request graph               | 未達。deployed origin 未観測                                     |
| `P2B-REPORT`   | accepted gate、CSP report observation                 | 未達。production sink/DB/WAF 未観測                              |
| `P3-XLSX`      | accepted gate                                         | 未達。固定実機30 samplesと acceptance 未実行                     |
| `P4-CSP`       | accepted gate、deployed CSP 7-flow                    | 未達。production header/sink/full-flow 未観測                    |
| `P5-DUAL`      | accepted gate                                         | 未達。full/virtual 30 samplesと acceptance 未実行                |
| `P5-LIST`      | accepted gate                                         | 未達。renderer-selection 30 samplesと acceptance 未実行          |
| `P6-APP`       | accepted gate                                         | 未達。production配布と acceptance 未実行                         |
| `P7-IDB`       | accepted gate、managed device IDB                     | 未達。3-stage compatibility drill 未実行                         |
| `P8-CLEAN`     | accepted gate、minimum safety floor                   | 未達。production floor activationと最終 acceptance 未実行        |

## 固定環境で取得した local regression 証跡

Node 24.19.0 / npm 11.19.0 の固定 PATH で次を確認した。

| Suite                     |      結果 |
| ------------------------- | --------: |
| Foundation                |   785/785 |
| Release State             |   279/279 |
| Unit                      | 1127/1127 |
| Integration               |   393/393 |
| Worker                    |     67/67 |
| API                       |     17/17 |
| Coverage subsystem floors |       6/6 |
| Quality verifier chain    |      PASS |
| Clean Release A build     |      PASS |
| Chromium clean overlay    |     22/22 |

coverageは対象全体 lines `90.03%` / branches `81.72%`、PWA recovery lines `90.77%` /
branches `83.58%`で、6 subsystem floorを満たした。

これらは repository regression の証跡であり、external observation や正式 Exit の代替ではない。
最終合流時は同じ固定 runtime で再実行し、差異があればこの表ではなく実行 logを優先する。

```powershell
$exactRoot = Join-Path $env:NVM_HOME 'v24.19.0'
$env:Path = "$exactRoot;$env:Path"
node --version
npm --version
npm run verify:toolchain
npm run test:encoding
npm run format:check
npm run test:foundation
npm run test:unit
npm run test:integration
npm run test:worker
npm run test:api
npm run test:coverage
```

## 正式 Exit までの残作業

1. machine verifier が報告する provider、DB、control store、approval、backup、managed device の
   unconfigured bindingを外部の正本値で構成する。
2. protected workflowで14 authorityを対象 gateごとに採取・review・publishする。
3. pre-initialization 3-gate seed、Release State initialization、以後の gate attestationを順に実行する。
4. standard/containmentをproductionへ配布し、promotion、assignment validation、recoveryを実行する。
5. canonical physical profileの30 samples、P1 strict + 3-stageとP7 3-stageのmanaged-device drill、
   24時間観測、必要承認を完了する。
6. live namespaceとpublished authority referenceを指定して readinessを再実行し、`16/16` を確認する。

上記を外部で実行していない現在の状態を `production complete`、`eligible`、`accepted` と記録してはならない。
