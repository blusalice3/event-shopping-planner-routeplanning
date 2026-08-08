# Performance evidence contract

## 状態

`config/ui-scenarios.json` と `config/performance-budgets.json` は、Phase 0 の5シナリオに
加えて、Phase 3 の XLSX Worker 7シナリオと Phase 5 の list renderer
5シナリオを定義する。現時点の machine、Chromium version、30 samples、absolute ceiling、
regression ceiling は外部実測されていない。このため全シナリオの `pendingState` は
`external-blocked`、budget値は `null` のままであり、production exit は受理されていない。

この pending 状態は欠損値の代用品ではない。値を推測して埋めたり、ローカルの一回の実行を
30 samples として扱ったりしない。

## Canonical scenario

Phase 3 は次を個別に測定する。

- valid Worker import、export round trip
- corrupt archive、compressed input上限超過、ZIP compression-ratio超過の拒否
- progress後のcancel acknowledgement
- 30秒のrequest/Worker timeout acknowledgement
- UI heartbeat、peak memory、single terminal result、partial commit/downloadが0であること

Phase 5D は同じ10,000 row fixtureで full/virtual initial render、virtual scroll anchor、
keyboard focus restorationを測定する。Phase 5E は renderer selectorを測定し、drag中、
multiple columns、unsupported zoom、modal、recovery、unknown stateが必ずfullへ倒れることを
assertionとして記録する。

各 post-baseline fixture は `scripts/fixtures/performance/` にあり、
`fixtureSha256` はraw bytesへ結び付く。Phase 0 fixtureだけは
`measurementSourceSha=638dc0d2b05a09da9ea09e3f25e00bb36e1b2994` のGit objectから再検証する。
これにより後続phaseのシナリオ追加がPhase 0の証跡を上書きしない。

## Evidence collection

実測runnerはcanonical physical machineで、各scenarioをfresh browser contextにより30回実行
する。warm-upはsamplesへ含めず、outlierを除去しない。中央値は偶数個の中央2値の平均、
p95はnearest-rankで再計算する。evidence envelopeは
`config/performance-evidence.schema.json` に従い、次へsource-bindする。

- clean Git commitとsource closure SHA-256
- build artifact SHA-256とgateに対応するrelease variant
- machine CPU、memory、power mode
- exact Chromium version/channel
- UI scenario policy、performance budget contract、XLSX limit policy
- fixture hash、30件のraw samplesとそのcanonical SHA-256
- fixtureが要求するfunctional assertion

budget contract hashは循環参照を避けるため、各scenarioの `evidenceSha256` だけを `null` へ
射影して計算する。measurement、ceiling、pending state、blockerは射影から除外しない。

## Verification

policyとfixtureの整合だけを検証する。

```powershell
node scripts/verify-performance-policy.mjs
```

production exitを検証する場合はgateとevidenceを明示する。

```powershell
node scripts/verify-performance-policy.mjs --require-exit P3-XLSX --evidence <evidence.json>
node scripts/verify-performance-policy.mjs --require-exit P5-DUAL --evidence <evidence.json>
node scripts/verify-performance-policy.mjs --require-exit P5-LIST --evidence <evidence.json>
node scripts/verify-performance-policy.mjs --require-exit P8-CLEAN --evidence <evidence.json>
```

gate modeは、継承scenarioのpending、gate blocker、machine/browser binding欠損、
30 samples未満、統計不一致、fixture/policy/source/artifact hash不一致、functional assertion
未達、absolute/regression ceiling超過のいずれかで失敗する。P8は全P0/P3/P5 scenarioを
再検証し、`temporaryExceptions` が空でないpolicyを受け付けない。

外部実測後は、raw evidenceから計算したmeasurementとレビュー済みceilingをpolicyへ
commitし、該当pending blockerを削除してからevidence envelopeを生成する。最後にその
envelope digestを該当scenarioの `evidenceSha256` へ設定し、gate verifierを再実行する。
