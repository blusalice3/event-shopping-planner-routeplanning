# Webアプリ実装基盤 改修計画

- 文書状態: 実装照合・再レビュー反映済み
- 基準日: 2026-08-05
- 基準commit: `806794df6222053235139e7ef6684f4aa6538b3d`
- 対象リポジトリ: `event-shopping-planner-routeplanning-1.9.6.7`
- 対象範囲: フロントエンドの配信、PWA更新、性能、保守性、自動テスト基盤

## 1. 目的

現在の利用者向け機能と保存データの互換性を維持しながら、次を段階的に改善する。

1. 一般操作E2E、アクセシビリティ検査、性能計測、CIを先に整備する。
2. 既存の遅延チャンクを安全に扱えるPWA更新ライフサイクルを確立する。
3. Tailwind CSSをCDN実行からローカルビルドへ移し、CSPを強制する。
4. ExcelJSを初期読込経路から外し、XLSX処理をWeb Workerへ移す。
5. 長い買い物一覧を、既存操作を維持したまま仮想化する。
6. `src/App.tsx` と `src/utils/indexedDB.ts` を既存の分離済み境界を再利用して縮小する。
7. React Hooks関連を中心とするlint警告を、挙動をテストで固定しながら0件にする。

本計画では、構造変更、配信変更、性能変更、保存仕様変更を同じPRへ混在させない。各フェーズは、依存する品質ゲートとロールバック手段が実在し、成功した後にだけ次へ進む。

## 2. 実装照合済みの現状

### 2.1 基準環境と検証結果

| 項目           | 2026-08-05時点の実測                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| 調査環境       | Windows 11、Node `20.20.0`、npm `10.8.2`                                                                    |
| TypeScript     | `npm run typecheck` 成功                                                                                    |
| lint           | エラー0件、警告130件                                                                                        |
| lint内訳       | `react-hooks/exhaustive-deps` 83件、未使用38件、その他9件                                                   |
| Vitest         | 120ファイル、1,198テスト成功                                                                                |
| 大規模ファイル | `App.tsx` 5,844行、`indexedDB.ts` 9,176行、`ShoppingList.tsx` 4,414行、`useIndexedDbPersistence.ts` 1,050行 |
| 文字コード     | 対象ソース・設定・MarkdownはUTF-8、BOMなし                                                                  |
| 対象文書       | UTF-8、BOMなし、LF、U+FFFDなし                                                                              |

Node 20は基準計測に使われたローカル環境であり、今後のサポート対象ではない。Node公式のリリース情報ではNode 20はEOLであるため、フェーズ0でNode 24 LTSへ更新して固定する。

### 2.2 配信・PWA・バンドル

| 項目              | 現状                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| Tailwind          | `index.html:14` の `https://cdn.tailwindcss.com` を実行時読込                         |
| インライン資産    | `index.html` にインラインstyle 1箇所、実行可能なインラインscript 3箇所                |
| PWA登録           | `vite-plugin-pwa` が `registerSW.js` を自動生成                                       |
| PWA更新           | `registerType: "autoUpdate"`、`skipWaiting: true`、`clientsClaim: true`               |
| PWA cleanup       | `cleanupOutdatedCaches: true`                                                         |
| runtime cache     | Tailwind CDNを30日間 `CacheFirst`                                                     |
| 既存lazy chunk    | `AppMainContent.tsx` が `ImportScreen` と `FocusModeContainer` を `React.lazy` で読込 |
| XLSX              | `xlsxMapParser.ts` と `exportImport.ts` がExcelJSを静的import                         |
| 初期modulepreload | `xlsx-parser` manual chunkが初期HTMLからpreloadされる                                 |
| Worker            | アプリ本体にWeb Workerなし                                                            |
| CSP               | `vercel.json` に強制CSP、Report-Only CSPともになし                                    |
| Vite manifest     | 通常buildでは生成していない                                                           |

基準buildでは、主entryが約912 kB、`xlsx-parser` が約972 kB、既存lazy chunkが約17 kBと約138 kBであった。Workboxはこれらを含む19資産、約3.0 MiBをprecacheした。値は未圧縮のminified出力を含む一時点の値であり、フェーズ0の再現可能な計測で正式な基準へ置き換える。

既にlazy chunkが存在するため、Service Workerの世代不一致は将来のXLSX Worker導入後だけの問題ではない。PWA更新安全化はTailwind、CSP、XLSXより前に行う。

### 2.3 既存の分離済み境界

`App.tsx` は巨大だが、次は既に分離されている。

- `AppHeaderShell`、`AppMainContent`、`AppOverlayLayer`
- `features/events` の更新、取込、バックアップ、品目操作
- `features/map` の取込、再取込、ホール操作、selector
- `features/lists` の範囲選択、移動plan、操作state
- `features/space-navigation`
- `components/focus` の一部hook、panel、dialog

ただし、`App.tsx` から各shellへ多数のprops、生のsetter、handlerを渡しており、バックアップ、XLSX、マップ、イベントライフサイクルの調停も残っている。`App.tsx:5795-5839` にはshell外のoverlayと永続化UIも残る。`ActiveTab` 等には `features/app-shell/types.ts` と重複する型もある。

永続化は `indexedDB.ts` だけではなく、次へ既に一部分離されている。

- `useIndexedDbPersistence.ts`: hydration、autosave queue、排他restore、画面向けstatus
- `mapDataPersistence.ts`: map payloadの正規化・圧縮・展開
- `persistenceResilience.ts`: digest、checkpoint、fallback、復旧snapshot
- `persistenceCleanupCoordinator.ts`: cleanupのlock、Service Worker、client quiescence判定
- `persistenceReleaseAMetrics*.ts`: Release Aメトリクス
- `persistenceRecoveryExport.ts`: 復旧用JSON出力

後続の分割では、これらを重複実装または無計画に移動しない。

### 2.4 品質基盤の不足

- `.github/workflows` とbranch protectionの必須checkは未導入。
- Playwright、axe連携、Vitest coverage、architecture検査は未導入。
- `quality:local`、`quality:pr`、`quality:artifact`、`quality:release` は未定義。
- `test:release-a-browser` はbuild済みpreviewを別途起動しなければ動かない。
- 現行rollback rehearsalは旧commitを現在の `node_modules` で再buildしており、不変artifactの試験ではない。
- `test:release-a-evidence` はvalidator自体のNodeテストであり、実証跡JSONの検証は `verify:release-a-evidence -- <path>` である。
- 一部integration testは `App.tsx` のソース文字列とhandler名を直接検査するため、そのままでは責務抽出に追随できない。
- `.gitattributes` の全体LF指定と、Prettierの2ファイルに対するCRLF指定が一致していない。
- format、encoding、typecheck、lintはroot設定、HTML、将来のE2E設定を一部検査しない。
- `npm audit` は全依存でCritical 1 / High 19、production依存でHigh 4を既に報告するため、単純な「High以上0件」ゲートは現状では通らない。

## 3. 対象外

次は本計画へ混在させない。

- 共有、認証、Supabase同期の機能追加
- 経路探索アルゴリズム、訪問順、購入状態の業務仕様変更
- IndexedDBのDB version、store名、key、保存schemaの変更
- イベント名を安定IDへ移行するデータモデル変更
- XLSX、CSV、JSONバックアップのファイル仕様変更
- 画面全体のデザイン刷新
- 新しい本番telemetry endpointやCSP report収集APIの追加
- 将来の共有機能originを現行CSPへ先行追加すること

semantic element、label、dialog focus、ズーム許可など、品質ゲートを成立させる局所的なアクセシビリティ修正は対象に含める。

## 4. 用語と不変条件

### 4.1 用語

- **論理commit**: 1つの利用者操作について、React側の複数stateへ同じ現行snapshotから導出した結果を適用すること。
- **永続化commit**: IndexedDB transactionが完了し、checkpoint等の永続化不変条件を満たすこと。
- **artifact**: 1つのsource SHA、lockfile、toolchain、build mode、機能フラグ、precache responseへ影響するdelivery revisionから作成され、hashで固定された配布物。
- **release package**: artifact archive、artifact manifest、provider header/config snapshot、release-package manifestから成るdeployable payload。試験前にrelease package IDとarchive hashで固定する。
- **release evidence**: release packageを変更せず、package ID/hash、試験結果、provider deployment IDを参照して試験後に作るdetached immutable証跡。独自のevidence ID/hashを持つ。
- **safe-hold package**: 互換floor以上、prompt protocol対応、事前検証済みのimmutable release package。古いfloorへ戻さず、更新問題を収束させるforward deploymentに使う。
- **互換floor**: それより古い更新方式または保存仕様へrollbackしてはならない最低artifact。
- **blocker**: reloadすると未保存入力、処理中state、またはautosave済みでも取消可能な未確定intentを失うため、PWA更新適用を止める明示的な状態。

論理commitと永続化commitを同一視しない。App分割の論理commit導入だけで、複数storeのIndexedDB書込が原子的になるとは扱わない。

### 4.2 保存データ

- `DB_VERSION = 5`、前方互換上限、store名、key、metadata、checkpoint、journal、archive形式を変えない。
- `src/utils/indexedDB.ts` のimport path、named/default `db` export、公開型、`db.STORES`、method shapeを維持する。
- 旧localStorage移行、runtime fallback、競合、復旧候補、原子的復元を常に回帰対象にする。
- schema変更が必要になった場合は該当PRを止め、別の移行計画へ切り出す。

### 4.3 配信とロールバック

- PWA更新方式、Tailwind、CSPは別PR・別artifactで配布する。
- 高リスク最適化はbuild-timeフラグでrollout旧経路を保持するが、切替には再build・再配布が必要である。
- rollback先は旧commitの再buildではなく、事前検証済みの不変release packageまたはproviderのimmutable deploymentとする。
- 互換floor設定後は、それより古い `autoUpdate` artifactへ戻さない。
- 初回installと未取得runtime資産にはonline接続が必要になり得るが、「PWA準備完了」後の既存主要操作、reload、更新、rollbackはoffline回帰対象にする。
- 初期表示に外部CDNを必要とせず、offline保証を変更する資産は画面表示、cache方針、受入条件を同じPRで更新する。

### 4.4 変更単位

- 1 PRは原則として1種類の主リスクだけを持つ。
- ファイル移動だけのPRへ挙動変更、lint挙動修正、保存変更を混ぜない。
- Hooks警告修正で動作が変わる場合は、構造変更PRと分ける。
- テストを削除または弱体化して通さない。
- 既存ファイルのencoding、BOM、改行を維持する。新規文書はUTF-8、BOMなし、LFとする。

## 5. 対応ブラウザとテスト層

| tier           | 対象                                                   | 自動化と責務                                     |
| -------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Tier 1         | desktop Chromium、mobile Chromium相当                  | 全利用者E2E、a11y、XLSX、仮想化                  |
| Tier 1 release | Windows Chrome / Edge、Android Chromeの実installed PWA | 既存runbookに沿う手動release gate                |
| Tier 2         | Playwright WebKit                                      | CSP強制前、Worker有効化前、仮想化有効化前のsmoke |
| 参考確認       | iOS Safari / installed PWA                             | zoom、offline、更新、主要導線の手動確認          |

WebKit smokeとiOS確認は、全機能の正式な互換保証と同一ではない。Workerや仮想化の採用可否はTier 1を必須とし、Tier 2で重大な起動・データ破損・操作不能があれば配布を止める。

通常E2Eは `serviceWorkers: "block"` と一意なbrowser contextを使用し、cacheと更新状態を混入させない。PWA E2EだけはService Workerを許可し、専用origin、専用profile、serial実行とする。

## 6. 実施順

| フェーズ | 内容                                    | 次へ進む条件                       |
| -------- | --------------------------------------- | ---------------------------------- |
| 0A       | toolchain、検査範囲、CI骨格             | fresh cloneで基礎check成功         |
| 0B       | E2E、a11y、操作契約                     | 現行アプリで代表6シナリオ成功      |
| 0C       | bundle・性能計測、品質ゲート必須化      | 再現可能な基準と予算を固定         |
| 1        | PWA更新安全化、artifact識別、検証器追随 | 既存lazy chunkと複数client試験成功 |
| 2        | Tailwindローカル化                      | 見た目とoffline動作が一致          |
| 3        | インライン実行除去、CSP強制             | 実responseで違反・許可漏れ0        |
| 4        | XLSX境界分離、遅延読込、Worker          | 3操作、取消、offline、往復一致     |
| 5        | 一覧行モデル、scroll adapter、仮想化    | DnD・focusを含む全モード成功       |
| 6        | `App.tsx` 責務分割                      | 客観的なApp完了gateを通過          |
| 7        | `indexedDB.ts` 責務分割                 | 公開API・物理形式・復旧互換        |
| 継続     | lint警告削減                            | 最終的に警告0件                    |
| 観測後   | rollout旧経路とフラグの削除             | 観測条件を満たす別PR               |

フェーズ1は既存lazy chunkを守るため、TailwindとCSPより先に完了する。フェーズ6が完了するまでフェーズ7を始めず、root stateの分割と永続化内部の分割を同時進行させない。

## 7. フェーズ0: 安全網と基準計測

### 7.1 フェーズ0A: toolchainと検査範囲

1. Node 24 LTSを正式対象とし、フェーズ開始時の最新security patchを選定して、全既存test、build、rollback関連scriptの互換性を確認する。
2. `.node-version` とCIは同じNode exact patch、`package.json.engines` は24系だけを許可するrange、`packageManager` とCIは同じnpm exact versionへ固定する。
3. `npm ci` を唯一のCI install手順とし、Playwright browser binaryのinstall stepを別途明記する。
4. `.gitattributes` に既存CRLF 2ファイルの例外を追加するか、改行専用PRでLFへ統一し、Prettier設定と一致させる。
5. encoding検査を、git管理対象と未追跡の対象拡張子へ広げる。少なくとも `index.html`、lockfile、tsconfig群、Vitest、PWA、ESLint、Prettier、Playwright、Tailwind、PostCSS、workflowを含める。
6. format対象へHTML、CJS、YAMLを追加する。
7. app、tooling、Worker、E2E用tsconfigを分け、集約typecheckですべてを検査する。
8. lint対象へVitest、PWA、Playwright、Tailwind/PostCSS config、E2Eを追加する。
9. `playwright-report/`、`test-results/`、一時profile、計測出力を `.gitignore` へ追加する。

既存のencoding/BOM/改行を一括変更するPRにしない。検査範囲の拡張で既存不整合が見つかった場合は、ファイル単位で根拠を記録して修正する。

### 7.2 lint・disable・依存監査baseline

- ESLint JSONをrepo相対path、rule ID、message ID、位置で正規化し、130件のidentity baselineを生成する。
- 既存警告の削除と別の新規警告の追加を相殺して通さない。
- baseline生成、比較、意図した移動・renameの更新を別コマンドにする。
- 既存 `eslint-disable` のidentity baselineを作り、新規または適用範囲拡大を失敗させる。
- `npm audit --json` の既存advisoryは、package、advisory ID、到達可能性、owner、期限を持つwaiverへ記録する。
- PRではlockfile差分により追加されたCritical/Highを拒否し、全体auditは定期・release jobでbaselineと比較する。

フェーズ0完了前のlint gateは「エラー0、baseline外警告0」である。警告0へ到達した後にbaselineを削除し、`--max-warnings 0` へ切り替える。

### 7.3 フェーズ0B: E2E基盤

正確なversionをlockfileへ固定して、`@playwright/test` とPlaywright用axe連携を導入する。初期E2Eは選択肢を残さず、次の6ケースに固定する。

1. 固定CSV fixtureを取り込み、20件・2日・複数ホールのイベントを作成する。
2. 指定IDの品目を編集列から実行列へ移し、並べ替え、範囲選択、購入状態変更後にreloadして保存を確認する。
3. 集中モードで指定品目の状態・価格・数量を変更し、reload後も品目値は残る一方、進行ポインタと一時的な限数延期はリセットされることを確認する。
4. 固定会場map XLSXを取り込み、preview中は無変更、取消時無変更、確定後に地図とホール設定が反映されることを確認する。
5. 固定イベントをfull XLSXで出力し、固定した別名へ再取込して主要項目、実行列、地図設定の往復一致を確認する。
6. JSONバックアップを出力し、固定した別名へ復元して、対象eventだけが追加され、取消・失敗時は無変更であることを確認する。

各ケースはretry 0で3回連続成功を初期安定条件とする。CIの通常運用でretryを設ける場合も、retry成功を安定成功へ数えずflakeとして記録する。

通常ケースは画面操作でデータを作る。300件、1,000件、旧DB、競合、復旧候補はテストhelperから専用contextのIndexedDBへ投入してよいが、本番bundleへテストAPIを追加しない。

localeは `ja-JP`、timezoneは `Asia/Tokyo`、reduced motion、theme、時計をテスト側で固定する。Google SheetsはPRではfixture応答を使い、実通信はprovider canaryへ分離する。

通常E2EはPlaywright `webServer` または同等のmanaged wrapperがbuild、preview起動、ready待ち、終了を所有する。開発者が別terminalでserverを起動していることを成功条件にしない。

### 7.4 操作契約

次の操作について、前提、読取state、書込state、永続対象、session限定state、取消・失敗結果、focus・scroll結果、unit/integration/E2E IDを表にする。

- イベント名称変更・削除
- spreadsheet更新・重複解決
- map取込・再取込
- 訪問リスト編集・確定・取消
- バックアップ復元
- 集中モードreload
- 平坦・ホール・スペース表示
- PWA更新と処理blocker

この契約をApp分割、仮想化、IndexedDB分割の回帰規範とする。

### 7.5 アクセシビリティ

対象はイベント一覧、取込、編集、実行、集中、地図、バックアップ復元、永続化復旧とする。

フェーズ0Bでは、rule、画面state、target fingerprint、impact、issue、owner、期限を持つbaseline manifestを作る。判定は次の2段階とする。

- baseline導入直後: baseline外の新規違反をimpactにかかわらず失敗させる。
- アクセシビリティ修正PR後: 主要導線の `critical` / `serious` は例外なし0件とし、`moderate` / `minor` は期限付きbaselineだけを許可する。

`maximum-scale=1.0, user-scalable=no` は削除する。SearchBarの入力へaccessible name、結果へlive regionを追加する。dialogは既存のrole実装を一律置換せず、初期focus、Escape、focus trap、呼出元復帰を実測して不足だけを直す。クリック可能な非semantic要素もaxeとkeyboard walkで確認してから修正する。

自動検査だけでなく、keyboardのみ、200%拡大、狭いviewportのreflow、focus可視性を確認する。

### 7.6 フェーズ0C: 計測

次の成果物を `docs/baselines/web-foundation/` 配下のversion付きJSONとMarkdownへ保存する。

- 初期request graph、modulepreload、各chunkのraw / gzip / Brotli
- Workbox precache総量、lazy chunk、ExcelJSの収録位置
- 300件・1,000件のDOM数、初期描画、入力応答、scroll frame、long task
- 小・中・大XLSXのread、parse/write、clone、合計時間
- PWA初回準備とoffline再起動の転送量

通常のproduction artifactへ計測用manifestを混入させない。`measure:bundle` はproductionと同じPWA構成を維持した専用analysis modeと一時outDirでVite manifestを追加生成し、終了時に一時出力を削除する。client初期graphはHTMLとmanifest、Service Worker登録・precache転送はbrowser traceと `sw.js` から別々に測る。

測定scriptはfixture hash、browser、OS、CPU、Node、試行数、warm-up、観測区間、集計式をJSONへ記録する。blocking指標と参考指標を分け、フェーズ0の変更前データで絶対上限と許容回帰率を固定する。実装後に予算を変更する場合は、別レビューと根拠を必要とする。

フェーズ0Cで `measure:bundle`、`measure:list`、`measure:xlsx`、`measure:pwa` と集約 `measure:web-foundation` をpackage scriptとして追加する。各個別scriptもfixtureと出力先を自分で準備し、単独実行できるようにする。

### 7.7 実在させる品質コマンド

| コマンド                                                                | 実行場所          | 内容                                                                                              |
| ----------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `quality:local`                                                         | dirty worktree可  | encoding、format、全typecheck、lint identity、Vitest、通常build                                   |
| `quality:pr`                                                            | clean CI checkout | local gate、evidence validator test、coverage/architecture導入済み分、通常E2E、a11y               |
| `quality:artifact`                                                      | clean CI checkout | release buildを1回だけ作成、manifest生成・検証、同じdistのmanaged preview、Release A browser、PWA |
| `quality:transition -- --scenario ...`                                  | 検証済みpackage群 | 同一profileで複数versionのupdate、rollback、cache migration。1Aで導入                             |
| `quality:release -- --preview-url ... --package ... --evidence-out ...` | provider候補      | 実header、provider E2E、release package往復、detached証跡生成・validator                          |

`test:e2e` と `test:e2e:a11y` は単独実行時もmanaged previewを所有する。`quality:pr` は同じbuildとpreviewを共有して両Playwright projectを実行する。`quality:artifact` はrelease build、manifest生成・検証、preview起動、Release A browserとPWA project、終了を1つのorchestratorで順に実行し、内側のtestは再buildしない。`git diff --check` はCIでbase SHAとhead SHAを指定する。

coverageは `@vitest/coverage-v8` を導入し、保存、復元、XLSX契約、一覧行モデル、App横断commandの変更行と高リスク境界から開始する。architecture検査は導入した境界だけを対象にし、依存禁止と循環を失敗させる。

### 7.8 CI

- GitHub Actionsの安定したrequired check名を作る。
- PR gateは原則 `windows-latest` でPowerShell手順も確認し、必要に応じて通常unit jobを並列化する。
- Playwright browser version、Node/npm、locale/timezoneを固定する。
- browser動画、trace、screenshot、DB dumpへ実利用者payloadを含めない。
- branch protectionはrepository外設定なので、設定画面の証跡をフェーズ0成果物に残す。

### 7.9 フェーズ0完了条件

- Node 24 LTSのfresh cloneで `npm ci` と全基礎checkが成功する。
- 代表6 E2Eがretry 0で3回連続成功する。
- a11y baseline外違反、lint identity外警告、新規disableを検出できる。
- 主要導線のcritical/serious違反が0件である。
- 300件、1,000件、XLSX、bundle、precacheの基準と予算が再現できる。
- `quality:local`、`quality:pr`、現行autoUpdate用 `quality:artifact` が実在し、CI required checkとして機能する。

## 8. フェーズ1: PWA更新安全化

### 8.1 採用する更新方式

`vite-plugin-pwa` のprompt registrationを使い、次を採用する。

- `registerType: "prompt"`
- `injectRegister: null` とし、自動 `registerSW.js` を生成・挿入しない
- `strategies: "injectManifest"` とし、`src/sw.ts` にprecache、runtime route、update protocolを明示する
- `srcDir: "src"`、`filename: "sw.ts"`、`injectManifest.injectionPoint: "self.__WB_MANIFEST"` を明示し、injection pointがsourceと生成物に各1件だけあることをbuild verifierで確認する
- install時の `skipWaiting` を無効化
- `clientsClaim` を無効化
- `virtual:pwa-register/react` から登録し、更新UIを表示
- `cleanupOutdatedCaches` は維持するが、安全なactivateまたは旧client 0件の自然activate後だけcleanupが起きる構成にする

1Aで現行 `generateSW` と同じprecache、navigation fallback、Tailwind runtime route、offline動作を `injectManifest` 版でgolden比較し、custom Service Workerへ移行可能かをhard gateにする。必要な `workbox-*` packageはtransitive dependencyに頼らずdirect devDependencyへ正確なversionで追加し、Service Worker用tsconfigはWebWorker globalを検査する。`cleanupOutdatedCaches()` と `precacheAndRoute(self.__WB_MANIFEST)` を明示し、source SHA、artifact ID、protocol versionはService Worker bundleへbuild時に埋め込む。parityが証明できなければprompt実装へ進まず、client列挙を実装できないままgenerateSWへ継ぎ足さない。

`virtual:pwa-register/react` はwaiting/offline/registration stateの購読に使うが、公開される汎用 `updateServiceWorker()` をactivationに直接使わない。custom registration adapterとwaiting Workerが `PREPARE_UPDATE` / `APPLY_UPDATE` のnonce付きprotocolを実装し、waiting Worker自身がclient再列挙、protocol/artifact照合、permit検証後にだけ `skipWaiting()` を呼ぶ。無条件の `SKIP_WAITING` message handlerは置かない。

permitは要求元client ID、active/waiting artifact ID、protocol versionへ束縛し、短い期限とsingle-useを持つ。期限切れ、再利用、要求元消失、client集合変化ではrejectし、waitingのままにする。

初回のprompt対応版は、旧 `autoUpdate` clientがすべて閉じるまでwaitingのままにする。旧clientには更新UIも後述のlock protocolもないため、pre-floor controllerからは「今すぐ更新」を無効にし、`skipWaiting` を送らない。全旧client終了後の自然activateによってprompt対応版を互換floorにする。

### 8.2 単一client証明とfail-closed

startupはService Worker登録前の状態をsnapshotし、次の3分岐にする。

1. `navigator.serviceWorker.controller === null` かつ既存active/waiting registrationなしはfresh installとみなし、現HTMLを通常mountしてから登録する。このnavigationでは強制更新を無効にし、controller不在を理由にreloadしない。
2. controller不在だが起動前からactive/waiting registrationがある場合は、active化待ちと通常navigation reloadを1回だけ行う。`sessionStorage` のattempt marker後もuncontrolledならAppをmountせず、close/reopenを案内するfail-closed画面にする。
3. controllerが存在してprompt protocolへ応答した場合だけ、controllerとHTMLのartifact IDを比較する。不一致時のreconcile reloadも1回までとし、解消しなければfail-closed画面にする。

prompt floor以降、Service WorkerとWeb Locksを利用できるcontrolled clientは、Appをmountする前にclient-presence用Web Lockをshared modeで取得する。Service Workerがないbrowserは通常起動し、Service WorkerはあるがWeb Locks非対応のbrowserはidentity一致を確認して通常起動する一方、強制更新を常に無効化する。「今すぐ更新」は、次をすべて満たす場合だけ許可する。

attempt markerのread/writeに失敗した場合は自動reloadせず、直ちにfail-closed画面へ進む。identity一致後はmarkerを削除する。

1. 更新要求者が別名のelection lockをexclusive・`ifAvailable` で取得する。取得できない要求者はshared presence lockを解放しない。
2. leaderだけが新規変更操作を凍結し、自分のshared presence lockを解放して、presence lockをexclusive・`ifAvailable` で取得する。
3. Service Workerの `clients.matchAll({ type: "window", includeUncontrolled: true })` とversion handshakeで、window clientが要求元1件だけと確認できる。
4. 要求元、active controller、waiting Workerがprompt protocol対応で、source/artifactの関係が期待どおりである。
5. exclusive presence lock取得後のblocker再確認がsafeである。

- 他のtab、installed PWA、uncontrolled client、旧protocol client、応答しないclientがある場合は適用せず、閉じるよう案内する。
- Web Locks非対応、lock状態不明、休止clientの可能性を排除できない場合は `skipWaiting` を送らない。
- exclusive lock中に起動したprompt clientはAppをmountせず待機し、lock取得後のartifact照合で必要ならreloadする。
- 利用者が全clientを閉じた場合は、標準Service Worker lifecycleによる自然activateに任せる。
- `clientsClaim` は無効なので、`controllerchange` だけをreload triggerにしない。waiting Workerの `statechange` を送信前から監視し、`activated` を期限付きで確認してから要求元を1回だけreloadする。
- waiting Workerが `APPLY_UPDATE` を受理したackまたは `activating` への遷移の早い方をpoint-of-no-returnとする。それ以前に明示rejectされ、Workerがwaitingのままと確認できた場合だけ、shared presence lockを再取得して操作凍結を解除できる。
- point-of-no-return後はexclusive presence lock、election lock、操作凍結をreload/unloadまで維持する。timeoutやack不明でも旧UIを再開せず、artifact一致reloadの再試行またはpage closeだけを案内する。
- point-of-no-return前の失敗は保存データを消さず、shared presence lockを再取得してから操作凍結とelection lockを解き、再試行または全client終了を案内する。

BroadcastChannelだけを安全性の証明に使わない。画面間通知へ使う場合も、exclusive lock、client列挙、version handshakeを必須とする。

### 8.3 blockerと所有者

`src/features/pwa-update/` に状態機械、registration adapter、blocker registry、UI、`PwaUpdateBlockerProvider` を置く。フェーズ1時点では後続controllerの存在を前提にせず、現行 `App.tsx` と各componentのstateから小さなadapter hookでregistryへ接続する。フェーズ6では契約を変えずにownerだけをcontrollerへ移す。各blockerはID、現行owner、将来owner、開始、解除、取消・失敗、owner unmount時の処理を契約にする。

| blocker                                          | フェーズ1のowner                                | 開始                                  | 解除                                     |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| hydration / recovery                             | `useIndexedDbPersistence`                       | startup開始                           | startup readyまたは安全な復旧画面        |
| autosave / retry待ち                             | `useIndexedDbPersistence`                       | debounce、save request、write開始     | すべて空でstatus `saved`                 |
| exclusive restore / recovery adoption            | `useIndexedDbPersistence`                       | 排他処理開始                          | restore、読戻し、検証完了                |
| dirty item edit / new item                       | `ItemEditDialog` / `ShoppingList` adapter       | 入力が初期値と異なる                  | 保存または明示取消                       |
| dirty manual import form                         | `ImportScreen` adapter                          | 手入力・選択内容が初期値と異なる      | 確定または明示取消                       |
| dirty event rename / URL update                  | `EventRenameDialog` / `UrlUpdateDialog` adapter | name、URL、sheet名が初期値と異なる    | 確定または明示取消                       |
| duplicate / post-event / limited-purchase intent | 対応dialog adapter                              | alias、choice、配布、限数の未確定変更 | 確定または明示取消                       |
| map reimport confirmation draft                  | `MapReimportConfirmationDialog` adapter         | 未確定の再取込選択開始                | 確定または明示取消                       |
| spreadsheet / file import                        | 現行event import adapter                        | file処理開始                          | 確定、取消、失敗処理完了                 |
| map preview / import                             | 現行map import adapter                          | preview requestまたは未確定設定開始   | request失効と確定/取消完了               |
| hall / block / cell / vertex draft               | 現行App/map editing adapter                     | 未確定選択・定義開始                  | 確定または明示取消                       |
| backup restore                                   | 現行backup adapter                              | 検証または適用開始                    | transactionとUI反映または失敗処理完了    |
| 訪問リスト未確定編集                             | 現行App/list adapter                            | live stateへの暫定反映開始            | 確定または取消の補償適用                 |
| XLSX実行                                         | フェーズ4で追加する `XlsxExecutionPort` adapter | request開始                           | result適用、error、adapter固有cancel完了 |

dialogを開いているだけ、pristineなform、検索文字列、表示tabだけではblockしない。取消・失敗時は `finally` で処理blockerを解放し、dirty draftは明示破棄後にだけ解放する。React StrictModeの二重mount/unmountでも漏れや早期解除が起きない、idempotentなtokenまたは参照カウント方式にする。

1Bで全dialog/componentのlocal `useState` と未確定modeをinventoryし、表にないreload消失stateを0件にする。各行はdirty/pristine、確定、取消、失敗、unmount、StrictModeのregistry testを持つ。

`useIndexedDbPersistence` は表示用の `persistenceStatus` から推測させず、startup、debounce、save request、in-flight write、restore、recovery adoptionを一括評価する専用reload-safety portを公開する。`saved` かつ全処理なしだけをsafeとし、`unsaved`、`saving`、`failed`、不明はfail closedにする。同期確認とAbortSignal付き待機を分け、たとえば `getReloadSafety()` / `waitUntilSafe(signal)` とする。

### 8.4 既存cleanup安全判定との統合

`persistenceCleanupCoordinator.ts` のwaiting Worker、client version、quiescenceのfail-closed判定を別実装で迂回しない。共通のclient version / quiescence契約を抽出し、次を固定する。

- waiting Worker中はlegacy cleanupを延期する。
- update blocker中またはclient証明不明時はcleanupを延期する。
- activate・reload後に新artifact IDとclient quiescenceを再検証してからcleanupを再開する。
- PWA更新用lockとcleanup用lockの取得順を固定し、deadlockを試験する。

### 8.5 artifact識別

現行の `buildId = sourceSha` はRelease A証跡用に維持し、別に `artifactId` を導入する。

`artifactId` は少なくともsource SHA、lockfile hash、Node/npm、build mode、機能フラグ、bundle bytesへ影響するpublic build入力、precache responseへ影響するdelivery revisionの正規化digestから決定する。現行ではderived outputである `VITE_APP_BUILD_ID` を入力から除き、`VITE_PERSISTENCE_RELEASE_CHANNEL`、`VITE_PERSISTENCE_LEGACY_CLEANUP`、`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` をcatalog化する。CSP header名、policy ID、Report-Only/強制mode、precache対象へ影響するheader config hashはdelivery revisionに含める。public build入力の値自体は証跡へ出さず、key名、設定有無、digestだけを記録する。未登録のpublic build入力がbundleで参照された場合はbuildを失敗させる。

source SHA、artifact ID、delivery revisionはHTMLとService Worker bundleへ別々に埋め込む。これによりheader modeだけが変わる場合もindex/SW bytesとprecache revisionが変わり、新Workerがinstallされる。同じartifact IDのままprecache対象headerを差し替えない。

provider headerはdist外にあるため、artifact IDだけでreleaseを識別しない。`releasePackageId` はartifact archive hash、provider-onlyの非secret deployment入力、CSP policy ID、`vercel.json` 等の配信設定hashから決定する。precache responseへ影響する設定はartifactのdelivery revisionとrelease packageの両方へ、providerだけに影響する設定はrelease packageだけへ含める。secretの値はmanifestへ入れず、provider側version referenceまたは設定有無だけをrelease evidenceへ記録する。

post-buildでversion付き `artifact-manifest.json` を生成し、次を記録する。

- source SHA / source state
- artifact ID
- lockfile hash
- Node / npm
- build modeと機能フラグ
- byte-affecting public build input catalog versionとdigest
- delivery revision、CSP policy ID/mode、precache header config digest
- PWA更新方式
- index、Service Worker、主要assetのhash
- 実行済みbuild verifier version

artifact生成後、packaging orchestratorが別の `release-package-manifest.json` をdist外に作り、artifact manifest/archiveのhash、CSP policy ID、provider header/config hash、release package IDを記録する。artifact manifestへrelease package IDを逆向きに埋め込まない。

release package IDはself fieldを除くcanonical package descriptorから計算し、manifestへ記録する。package archive作成後はarchive hashも固定する。後続試験はpayloadをread-onlyで使い、結果をpackageへ追記しない。

同一source SHAでもフラグが異なるartifactは異なるIDを持たなければならない。

### 8.6 Release A検証の追随

1Aでbuild/browser/rollback verifierを旧auto/new promptの両方を識別できる形へ先行更新し、現行artifactで合格させる。1Bのprompt切替PRで期待値をpromptへ切り替え、どの中間PRでも既存required checkを壊さない。1Dでimmutable rehearsal、runbook、evidence schemaを確定する。

- `verify-release-a-build.mjs`: `registerSW.js` 固定必須をやめ、virtual registrationを検証
- `verify-release-a-browser.mjs`: update UI、blocker、exclusive lock、明示承認を操作
- rollback rehearsal: 即時 `controllerchange` 前提を廃止
- READMEと `persistence-recovery-runbook.md`
- evidence template / validatorのartifact IDとPWA更新証跡

現行rollback scriptは「source互換rehearsal」として名前と責務を明確にし、別に保存済みdist archive、artifact manifest、provider header/config snapshotを入力とする「immutable release package rehearsal」を追加する。旧commitを現在の `node_modules` で再buildしたものをrollback合格には使わない。

### 8.7 必須試験

- 旧版で未読込の `ImportScreen` / `FocusModeContainer` を、新版waiting中も旧版clientから開ける。
- autosave、map取込、restore、未確定訪問リスト中に更新できない。
- blocker解放後、単一client時だけ明示承認でactivate・reloadできる。
- 2 tabまたはtab + installed PWA相当ではexclusive lockを取得できず、更新しない。
- Web Locks非対応時は強制activateせず、全client終了後に自然更新する。
- pre-floor controllerでは明示activateせず、全旧client終了後にprompt floorが自然activateする。
- clean profileの初回navigationは1回でmount・登録でき、controller不在によるreload loopがない。
- 既存registrationがあるuncontrolled pageと永続的artifact不一致は、各1回のreconcile後にfail-closed画面となり、reload loopしない。
- 2 clientが同時に更新を要求してもleaderは1件だけで、clientが残る限りactivateせず、失敗側を含めshared presence lockと操作可否を復元する。
- exclusive lock取得後に新clientが起動してもmount前照合で世代を揃える。
- waiting Workerのactivation、reload、errorの競合で二重reloadせず、`clientsClaim` 無効でも更新が完了する。
- StrictModeのmount/unmount、保存失敗、dirty formの取消・画面離脱でblocker tokenの漏れ・早期解除がない。
- waiting中のlegacy cleanupはdeferredになり、更新後に安全判定をやり直す。
- A artifact → B artifact → 受入済み互換artifactの往復でoffline起動と保存データを維持する。

### 8.8 互換floorとロールバック

prompt対応版を受入後、そのartifactをPWA互換floorとする。以後、`skipWaiting: true` のpre-floor artifactを配布しない。

初回移行の問題には、事前作成したsafe-hold packageまたはforward fixをforward deploymentする。PWA更新方式だけを旧 `autoUpdate` へ戻すrollbackは行わない。

## 9. フェーズ2: Tailwindローカル化

### 9.1 方針

設定形式を変えるTailwind 4へのmajor upgradeを混在させず、Tailwind 3.4系の正確なversion、PostCSS 8、Autoprefixerをlockfileへ固定する。現在のversion未固定CDN表示を視覚baselineとし、major upgradeは別計画とする。

### 9.2 実装

1. Tailwind / PostCSS configを作り、`darkMode: "class"` と `index.html`、`src/**/*.{ts,tsx}` をcontentへ指定する。
2. `src/styles/app.css` にTailwind layerと現在のインラインCSSを移す。
3. `src/index.tsx` からCSSをimportする。
4. `index.html` からTailwind CDN、インラインTailwind設定、インライン `<style>` 要素を除く。
5. `vite.config.ts` の `tailwind-cache` runtime cachingを削除するが、最初のlocal CSS artifactでは旧cacheをまだ消さない。
6. local CSS artifactを観測・受入し、同じ構成のsafe-hold release packageを保存してTailwind互換floorにする。
7. floor設定後のcleanup artifactだけにbuild-time markerを埋め、custom Service Workerの `activate` eventが `event.waitUntil(caches.delete("tailwind-cache"))` で正確な旧cacheだけを削除する。通常の `cleanupOutdatedCaches()` へ任せない。
8. 動的class tokenを静的な完全classへ直す。safelistは理由、使用箇所、削除条件を記録した最小限だけを許可する。
9. loading画面がCSS entry読込前後で崩れないことを確認する。

このフェーズでは残るテーマ・loading・viewportのインラインscriptを移動せず、CSP作業と分離する。

### 9.3 受入条件

- Tailwind CDNへのrequest、runtime cacheのread/write、残存 `tailwind-cache` がない。
- `index.html` にインライン `<style>` 要素がない。
- light / dark / system、desktop / mobile、主要dialog、sticky、z-indexの視覚差分が承認される。
- prompt更新の前後とoffline再起動で装飾が一致する。
- CSS未適用のloading画面を表示しない。

safe-hold → cleanup artifactの遷移は、同一browser profileでcacheの存在、activate後削除、offline再起動を確認する。prompt lifecycleにより旧client不在または単一client凍結が成立する前にはcleanup artifactをactivateしない。旧cache削除前の問題は受入済みprompt floorへ戻せる。削除後はlocal CSSのTailwind floorより前へ戻さず、事前検証したsafe-hold packageまたはforward fixを使う。PWA更新方式は戻さない。

## 10. フェーズ3: インライン実行除去とCSP

### 10.1 インラインscriptの除去

hash付きinlineを候補に残さず、自己ホストの外部scriptへ統一する。

- 初期theme適用は、小さな同期classic script `public/theme-bootstrap.js` としてheadから読込み、最初の描画前に実行する。
- 保存値は `system` / `light` / `dark` だけを許可し、localStorage例外時も `system` で起動する。
- loading終了とviewport高さ更新は `src/bootstrap/browserLifecycle.ts` 等へ移し、cleanup可能なlistenerとして登録する。
- 実行可能なインラインscriptとインラインstyleを0箇所にする。

### 10.2 CSP候補

実違反を確認する前の最小候補は次とする。

```text
default-src 'self';
script-src 'self';
script-src-attr 'none';
style-src 'self';
style-src-elem 'self';
style-src-attr 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' https://docs.google.com;
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'self';
frame-ancestors 'none';
form-action 'self';
```

Reactのstyle属性を利用しているため `style-src-attr 'unsafe-inline'` は当面必要である。`script-src` に `unsafe-inline` / `unsafe-eval` は追加しない。共有無効の現行clientでSupabase originを許可しない。

Google Sheetsの実responseがredirectする場合は、provider canaryで最終originを記録し、その正確なoriginだけを `connect-src` へ追加する。開発serverのWebSocket要件を本番policyへ混ぜない。

### 10.3 段階導入

追跡対象のCSP policy catalogを唯一のsource of truthにし、delivery mode入力からローカルheader server設定、provider header config、delivery revisionを同時生成する。3者を正規化比較し、手書きのpolicy複製を許可しない。

1. `test:e2e:csp` は単独実行時だけrelease buildを作るwrapperとし、内部の `test:e2e:csp:project` は渡されたread-only dist / URLだけを検査する。`vercel.json` と同じheaderを返すローカルproduction-like serverの起動、ready待ち、試験、終了までwrapperまたは上位orchestratorが所有してReport-Onlyを試す。
2. 同じsource/app入力からdelivery revisionだけが異なるReport-Only、強制、safe rollbackの3artifact/packageを作り、各artifact IDとSW bytesが異なることを確認する。
3. 最初のnavigation前から `securitypolicyviolation` とconsoleを収集する。
4. responseに期待するCSP headerが1件だけあり、policy ID、mode、内容が一致することをassertする。
5. 通常E2E、Google fixture、XLSX現行操作、バックアップ、PWA、offlineを実行する。
6. provider Previewでも実headerと実Google canaryを確認する。
7. 違反0になってから強制packageへ進み、同じ試験を再実行する。
8. `quality:transition` で同一installed profileをReport-Only → 強制 → safe rollback → 強制の順に進め、各activate後のonline/offline navigationとCache Storage内 `index.html` Responseが期待headerを持つことを確認する。

本計画では本番CSP report収集APIを作らない。Report-Onlyは隔離previewと自動証跡に限定する。

### 10.4 受入条件

- 実行可能なinline script、inline `<style>` 要素、Tailwind CDN参照がない。
- `script-src` に `unsafe-inline` / `unsafe-eval` がない。
- `style-src` / `style-src-elem` に `unsafe-inline` がなく、必要なReact style属性だけを `style-src-attr` で許可する。
- 実responseの強制CSPが自動検査される。
- installed PWAのprecache済みnavigationでも最新delivery revisionの強制headerが有効である。
- 現時点の主要操作、Google Sheets、同一origin metrics API、PWAが違反なしで動作する。
- `worker-src 'self'` はpolicyに存在する。実XLSX WorkerのCSP試験はフェーズ4で行う。

CSP問題時は、同じsource/app入力から直前の受入済みheader policyとdelivery revisionで作成・検証したsafe rollback artifact/packageへ切り替え、TailwindやPWAまで同時に戻さない。同じartifactの本番headerだけを編集しない。

## 11. フェーズ4: XLSX遅延読込とWorker

### 11.1 先に分離する境界

挙動を変えないPRで次を分離する。

- `itemNumberParsing.ts`: `extractNumberFromItemNumber` 等。ExcelJSへ依存しない。
- `xlsxContracts.ts`: ExcelJS classを公開しないrequest/result型。
- `downloadBlob.ts`: JSON復旧出力を含むdownload共通処理。
- `xlsxMapParser.ts`: map Workbook変換。
- event XLSX codec: 現在の `exportImport.ts` のimport/export変換。

`App.tsx` と `persistenceRecoveryExport.ts` は `downloadBlob.ts` を直接利用する。`ExportData`、`ImportResult`、fallback warning等の公開契約を `xlsxContracts.ts` へ移し、`features/events/exportFlow.ts` からExcelJS実装への静的importを除く。`FocusMode`、`FocusModeMapCanvas`、`hallGrouping`、`MapCanvas`、`MapView`、訪問panelからもExcelJS依存を除く。

UIへは3操作を持つ共通 `XlsxExecutionPort` だけを公開し、literal build flagでadapterを1つだけ選ぶ。

- Worker ON artifact: 専用Worker entryだけがcodecとExcelJSを静的importし、UIはExcelJS非依存の薄いWorker adapter / constructorをdynamic importする。
- Worker OFF artifact: legacy main-thread adapterを操作時にdynamic importし、同じcodecとresult契約を使う。
- runtime中にON/OFFを切り替えず、未選択adapter、Worker chunk、不要なExcelJS経路がdead-code eliminationで消えることをmanifestで検証する。

### 11.2 Worker契約

request/resultは構造化複製可能なplain dataだけにする。

```text
request:
  schemaVersion
  requestId
  operation
  fileName       # import時は必須
  buffer         # transferable ArrayBuffer
  options

result:
  schemaVersion
  requestId
  operation
  stage
  success
  payload | error
```

現行event XLSX importは `file.name` をfallback event名に使うため、`ArrayBuffer` だけでは互換にならない。`fileName` を必ず渡し、同じfallback結果をgolden testで固定する。

Worker ON artifactではWorker内部だけでExcelJS Workbookを生成する。exportはArrayBufferを返し、main threadでBlob化・downloadする。Worker request/resultへFile、DOM、React state、ExcelJS instanceを含めない。OFF adapterも同じplain resultと後段pipelineを返す。

`XlsxExecutionPort` はrequestのsettleとcancel outcomeを共通化する。ON adapterはcancel時にrequestを失効してWorkerをterminateし、OFF adapterは現行の同期処理を途中完了したと偽らず、実際にsettleするまでblockerを保持する。

Workerのevent import責務はWorkbookからplainな `ImportResult` への変換までとする。main threadの `toImportedEventData` → `buildXlsxEventRestoreSource` → `createAppBackup` → `parseAppBackup` → `pendingBackup`、続く `runExclusiveRestore` / `db.restoreAppDataAtomically` と完了通知を維持し、parse結果を直接React stateへ適用しない。

### 11.3 feasibility hard gate

小さなfixtureで、採用browser tierのmodule Worker内からExcelJSのread/writeが動くことを先に証明する。

- Tier 1で失敗した場合はWorker実装を止める。
- classic Worker、別library、main-thread fallbackへ自動的に切り替えない。
- 失敗時は「dynamic importだけを導入する案」を別ADRで評価し、Worker完了とは扱わない。

### 11.4 実装順

1. typed `XlsxExecutionPort` adapterをdynamic importし、同時に1つのCPU集約処理だけを許可する。
2. map解析を移し、既存preview raceとrequest失効を維持する。
3. event XLSX importを移す。
4. event XLSX exportを移す。
5. 観測可能なstageだけを表示し、根拠のない百分率を出さない。
6. cancel時はrequestを無効化してWorkerを `terminate()` し、次回に再生成する。
7. timeout、crash、二重実行、古いrequest、retryを処理する。
8. transfer後のbufferをretryへ再利用せず、必要なら元Fileから再読込する。
9. dynamic import境界を確認し、不要になったmanual chunkを削除する。
10. Vite manifestと初期HTMLを解析し、ExcelJSへの静的経路とmodulepreloadが0件であることを自動検査する。

### 11.5 PWA cacheとfallback

現在はlazy chunkもprecacheされている。既存の「PWA準備後はXLSXをoffline利用可能」という期待を維持するため、初期方針は選択されたXLSX adapterとExcelJS chunkのprecacheとする。ON artifactはWorker entry/ExcelJS、OFF artifactはlegacy adapter/ExcelJSを含み、未選択側は含めない。

フェーズ0のprecache予算を超える場合だけ、初回利用時runtime cacheへ変更するADRを作る。その場合は、初回online準備前はoffline XLSXを使えないことを画面に明示する。

rollout中のWorker OFF経路は別artifactへbuildし、1つのartifactへWorker版とmain-thread版のExcelJSを二重収録しない。dead-code eliminationに失敗して両方が残るartifactはmanifest/size gateで不合格にする。ON artifactでruntime main-thread fallbackは採用せず、Worker再生成と回復可能なerrorを使う。

既存 `React.lazy` と新しいWorker/dynamic importのchunk load failureはroot error boundaryで分類する。waiting更新がある場合もblockerを無視して自動reloadせず、保存安全性を確認した更新導線または再試行を提示する。

### 11.6 受入条件

- 初期entryと初期modulepreloadからExcelJSが外れる。
- page clientの初期module graphではExcelJS chunkをrequest・evaluateしない。Service Worker install時のprecache転送は別予算として計測する。
- ON artifactでmap解析、event import、event exportがWorkerで成功する。
- OFF artifactで同じ3操作がlegacy adapterから成功し、ON/OFFのplain resultと往復goldenが一致する。
- file名fallback、sheet、列、値、地図設定、往復結果が変更前と一致する。
- importは既存backup schema検証と原子的restore経路を通り、検証失敗・復元失敗・取消時はReact stateとIndexedDBがともに変更されない。
- cancel後の古い結果を適用しない。
- ON artifactでは大file中もmain threadのUIが応答する。
- OFF artifactのmain-thread時間と入力応答は既存baseline以下へ悪化せず、3操作、互換、rollbackが成立する。
- 強制CSP、prompt更新、fresh install後offlineでWorkerが動く。
- feature flag別artifact IDが異なる。
- ON manifestにlegacy adapter/client-side ExcelJS経路がなく、OFF manifestにWorker adapter/chunkがなく、どちらにも未選択実装が混在しない。

Workerは既定OFFのQA artifact、既定ON artifact、観測中artifactの順に進める。既定ON配布前だけでなく観測完了までの各release candidateで、同じsource、lockfile、public build入力、Tailwind/CSP/PWA設定からWorker flagだけをOFFにしたpaired release packageも検証・保存する。問題時は同じcandidateのpaired packageへ戻し、無関係なフェーズを巻き戻さない。

## 12. フェーズ5: 買い物一覧の仮想化

### 12.1 現状リスク

`ShoppingList.tsx` は、平坦・ホール・スペース表示、可変高card、見出し、折りたたみ、PC/touch DnD、範囲選択、検索、警告jump、space navigation、window scroll、PC二列を持つ。`elementFromPoint`、`getBoundingClientRect`、`querySelectorAll`、window scrollへ依存する処理がある。

drag開始中に全件描画と仮想描画を切り替える方式は採らない。DOM差替えでdrag source、scroll、focusが失われるためである。

### 12.2 PR A: 行モデル

- `ShoppingListPresentationModel` に `renderRows`、`logicalGroups`、`itemIdToLogicalIndex`、`itemIdToMountTarget` を持たせる。
- `renderRows` は見出し、item、drop zone等を明示し、`logicalGroups` は折りたたみ中もgroup内の全item IDを保持する。
- range選択は既存 `rangeSelection.ts` と同じlogical membershipを唯一の情報源にし、仮想化用に別group modelを並行生成しない。
- 折りたたみ見出しの全group drag sourceと先頭item anchorの現行意味を維持する。
- logical indexとmount対象を事前計算し、render中の反復的な `findIndex` とDOM探索を置き換える。
- 現行の全件rendererを行モデル経由にし、まだ仮想化しない。

### 12.3 PR B: scroll / focus adapter

- 既存 `useExecutionSpaceNavigator` の非同期scroll、snapshot、reveal契約を拡張し、window scrollとPC二列を維持する。
- `ensureMounted -> scrollToRow` を基礎async契約にし、操作契約で必要な導線だけ `focusRow` / `announce` を続ける。
- visible range、drop index、request cancelを契約へ含める。
- Appのmode切替・検索、編集保存後scroll、space navigationの直接DOM操作を同じadapterへ寄せる。編集保存後は現行どおりscrollのみとし、focus移動を追加する場合はa11y挙動変更として別に検証する。
- 対象keyへevent、day、column、view mode、list scopeを含め、古いrequestをepochで破棄する。PC二列でscopeを省略しない。
- 全件rendererでも同じadapterを使う。

### 12.4 PR C: QA-only feasibility

可変高、window scroll、PC二列、sticky見出し、touch、native DnD、画面外focusを候補libraryまたは自前prototypeで検証する。このPRの仮想rendererはQA-onlyフラグで、production既定ONにしない。

次を満たさなければproduction仮想化へ進まない。

- drag sourceがunmountされず、画面外drop indexをrow modelから決定できる。
- pointer/touchとwindow端auto scrollが両立する。
- card展開、倍率変更、viewport変更後に再測定できる。
- search / warning / navigationで画面外rowをmount後にfocusできる。
- 採用ARIA patternとscreen reader結果が承認される。

失敗時は行モデルとadapterだけを維持し、仮想化完了を宣言しない。別のDnD方式または一覧UX変更は別ADRとする。

### 12.5 PR D: production実装

- productionで仮想化を有効にする時点では、閲覧、状態変更、range、検索、PC/touch DnDをすべて仮想rendererで扱う。
- drag中にrendererを切り替えない。
- active / focused / dragged rowを必要な間pinまたはoverlay化する。
- overscan、測定cache、sticky責務を分離する。
- 小規模listは単純rendererを使う閾値を、フェーズ0計測から固定する。
- full rendererはbuild-time rollbackとアクセシビリティfallbackとして保持する。

利用者が非仮想表示を選ぶ場合は、drag中やfocus移動中に切り替えず、idle時にscroll anchorを保存してrendererを切り替える。

### 12.6 合否

既定の仮想表示経路について次を満たす。

- 300件・1,000件でitem DOM数が全件数ではなくviewport + overscanに連動する。
- 300件の初期描画と入力応答が基準より改善し、1,000件で長時間taskとmemoryが予算内である。
- 75% / 100% / 125%倍率、desktop / mobile、card展開後に空白・重なりがない。
- 平坦・ホール・スペース、編集・実行二列、drag、touch移動、上下移動、range、一括変更が一致する。
- 折りたたみ中も見出しからのgroup drag、非表示itemを含むrange、visit navigationの論理所属が一致する。
- 検索、未入力警告、space navigationから画面外itemへ移動できる。
- event/day/column/view mode/list scope切替後に古いscroll requestが別一覧をscrollまたはfocusしない。
- keyboard順、位置情報、live announcementを維持する。

明示的な非仮想アクセシビリティfallbackは「1,000件で全件DOMを作らない」条件の例外であり、既定経路の性能合格を免除しない。

production既定ON前から観測完了までの各release candidateで、同じsource、lockfile、public build入力、Tailwind/CSP/PWA設定からvirtual flagだけをOFFにしたpaired release packageを検証・保存する。問題時は同じcandidateのpackageへ戻す。小規模listと明示的a11y用の全件rendererはrollout旧経路ではなく、承認済みの恒久fallbackとして扱う。

## 13. フェーズ6: `App.tsx` の責務分割

### 13.1 方針

既存shellとfeaturesを新設し直さず、残る調停をそれらへ寄せる。最初から全App stateを新しいglobal `AppStateSnapshot` / reducerへ書き換えない。

現在の `eventLists`、`eventMetadata`、`executeModeItems` はref-backed setterを持つが、他stateは同じ方式ではない。全stateを単一commit coordinatorへ変える場合は、単純分割ではなく独立した状態architecture PRとして扱う。

### 13.2 最初に固定する契約

1. state、ref、effect、handler、shell props、overlay、永続化経路のinventoryを作る。
2. 各stateのsource of truth、owner、session/persisted区分を記録する。
3. `PersistedStateValues` / `AppData` 相当のIndexedDB state、session/UI state、localStorageのblock detection設定を別境界として命名し、曖昧な「全state snapshot」を作らない。
4. rename、delete、import確定、restoreについて、論理commit、localStorage side effectと補償、autosave境界をintegration testで固定する。
5. backup restoreのIndexedDB原子性は既存 `restoreAppDataAtomically` / `runExclusiveRestore` に残し、React論理commitと混同しない。
6. 新しいcoordinatorが必要なら、snapshot寿命、失敗時結果、autosave順序をADRで決め、独立PRにする。

抽出前に、`App.eventUpdateSourceCommit`、`App.executeModeItemsCommit`、`App.mapImportFlow`、`App.movePlan` 等のAppソース文字列・handler名依存testを、同じ不変条件を検証するcontroller/domain/render integration testへ置き換える。assertionの削除や弱体化は行わない。

`App.tsx` の `components/map` barrel経由のstorage/domain importは、controller抽出前に直接utils/domain portへ向ける。polygon判定は現行の境界点包含挙動を固定し、異なる実装へ無検証で統合しない。`ActiveTab` 等の重複型は既存 `features/app-shell/types.ts` をsource of truthにする。

### 13.3 抽出順

1. selector、normalizer、plan builderなど副作用のない処理。
2. XLSX、JSON、Google Sheetsの画面調停。フェーズ4の `XlsxExecutionPort` を利用する。
3. イベント作成、選択、rename、delete、update、duplicate resolution。
4. item更新、列移動、一括操作。
5. map import、reimport、hall、visit list調停。
6. focus session調停。
7. search、tab、表示mode、overlay intent。
8. shellへ渡すpropsをfeature別view modelとactionへまとめる。
9. `App.tsx` に残るBackupRestore、MapReimport、DuplicateEvent、Persistence UIを適切なoverlay / root boundaryへ移す。

`ImportScreen.tsx` と `features/events/sheetImport.ts` に重複するGoogle Sheets fetch経路は、挙動を先にtestで固定してから共通化する。

dialog intent、対象のimmutable snapshot、確定actionはfeature側が所有し、portal、focus trap、focus復帰はshell側が所有する。同じdraftを両方で持たない。

`mapImportFlow` の複数setter effect、bulk add、rename、deleteは、現行snapshotからpatch / commandを返す形へ段階的に変える。event updateの既存snapshot方式を先行例とし、未変更sliceの参照同一性、現行のstore別保存順、部分成功、retryを維持する。論理commitをIndexedDB全storeの原子的transactionとは呼ばない。

訪問リストは現状、真の未保存draftではなくlive `executeModeItems` へ暫定反映し、取消時に元順序を再適用する未確定編集である。reload/crash時の挙動をフェーズ0で固定し、confirm時だけ反映する方式への変更は別の挙動変更PRにする。

### 13.4 Hooks警告

抽出前に対象effect/callbackの挙動をtestで固定し、次の順で判断する。

1. effectをevent処理または導出値へ置換できないか。
2. 関数形式updateでstale valueを避けられないか。
3. callbackを小さくできないか。
4. 外部購読だけ用途付きrefを使う。
5. 抑制が必要なら理由と回帰testを付ける。

依存配列変更で挙動が変わる修正は、移動PRと分ける。

### 13.5 完了gate

フェーズ7開始前にすべて満たす。

- `App.tsx` にXLSX codec、File読込、map import手順、backup restore詳細が残らない。
- 既存shellへ生のReact setterを渡さない。
- shell propsはfeature別の型付きview model / action bundleであり、巨大な無型objectへ置き換えていない。
- rename、delete、import、restoreの操作契約とautosave順序がintegration/E2Eで成功する。
- Appソース文字列に依存したintegration testがなく、置換後もevent source、execute-mode ref同期、map import一回commit、両列move planの不変条件を検証する。
- component barrelからstorage/domainへの逆向き依存がない。
- IndexedDB永続対象、session-only state、localStorage設定の型付き境界とbackup/import/restore対応が1つの契約として固定される。
- 各操作で未変更storeの参照同一性、保存対象store、保存回数・順序、部分失敗retryが分割前と一致する。
- 訪問リストの暫定順序がautosaveされ、取消で元順序を補償保存する現行挙動と、取消可能期間中にPWA reloadをblockする挙動が成功する。
- startup後のhall/map補正はowner、冪等性、autosave前後順序が固定される。
- 抽出したcontrollerをApp全体なしでtestできる。
- Appの依存fan-out、effect数、top-level handler数、shell props数がinventory基準から減る。
- `App.tsx` は2,000行以下を目標ではなくgateとする。超える合理的理由がある場合は、フェーズ7開始前のADRで残存責務と解消期限を承認する。
- 抽出範囲のlint警告が増えず、原則0になる。

## 14. フェーズ7: `indexedDB.ts` の責務分割

### 14.1 現行モジュールとの対応

| 現行                               | 方針                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `useIndexedDbPersistence.ts`       | React orchestrationとして維持。公開idle portとfacadeだけに依存           |
| `mapDataPersistence.ts`            | map codecとして当面path維持                                              |
| `persistenceResilience.ts`         | pure digest/checkpoint/recovery helperとして維持し、必要な単位だけ分割   |
| `persistenceCleanupCoordinator.ts` | fail-closed coordinatorとして維持                                        |
| `persistenceReleaseAMetrics*.ts`   | metrics責務を維持                                                        |
| `persistenceRecoveryExport.ts`     | UI向けexport adapterとして維持                                           |
| `indexedDB.ts`                     | connection、primitive、repository、migration、recovery、facadeへ段階抽出 |

既存helperの移動は `indexedDB.ts` 抽出と同じPRへ混ぜない。pathを変える場合は互換re-exportとimport migrationを別PRにする。

### 14.2 目標責務

```text
既存pathを維持:
  src/hooks/useIndexedDbPersistence.ts
  src/utils/mapDataPersistence.ts
  src/utils/persistenceResilience.ts
  src/utils/persistenceCleanupCoordinator.ts
  src/utils/persistenceReleaseAMetrics*.ts
  src/utils/persistenceRecoveryExport.ts

indexedDB.tsから新規抽出:
src/features/persistence/
  types.ts
  schema.ts
  runtimeContext.ts
  connection.ts
  idbPrimitives.ts
  repositories/
    appDataRepository.ts
    mapRepository.ts
  restore.ts
  migration/
    journal.ts
    legacyMigration.ts
    legacyCleanup.ts
  recovery/
    archive.ts
    adoption.ts
  facade.ts
```

digest、checkpoint、runtime fallback、recovery candidateの純粋処理は既存 `persistenceResilience.ts` を唯一のsource of truthとし、新規treeへ複製しない。残るmetadata I/Oだけをrepositoryへ置く。名前はdependency inventoryで調整してよいが、責務と依存方向は変更前に確定する。

### 14.3 owner境界

- `runtimeContext` は `dbInstance`、open Promise、writer ID、expected revision/checkpoint mapを保持するだけで、DB open手順を持たない。
- `connection` はopen、upgrade、blocked timeout、versionchange、closeを実装し、`runtimeContext` のconnection slotを変更できる唯一のmoduleとする。
- test resetは本番facadeへ公開せず、test-only factoryまたはmodule再読込で行う。
- `idbPrimitives` だけがrequest Promise化とtransaction完了補助を持つ。
- repositoryはmigration/recovery UIへ依存しない。
- recovery candidate生成はread-only portだけ、adoptionだけがcommit portを受け取る。
- cleanup、migration staging、通常write、adoptionを同じ広権限repositoryへ渡さない。
- facadeだけが各責務を組み立てる。

### 14.4 抽出順

1. 公開API shapeのtype testを追加する。
2. 公開型、schema定数、error型を抽出する。
3. runtime mutable stateを1つのcontextへ集約する。
4. request / transaction primitiveを抽出する。
5. 既存 `persistenceResilience.ts` のpure処理へ残存呼出を接続し、DB固有のmetadata I/Oだけをrepository候補へ分離する。
6. connectionとversion compatibilityを抽出する。
7. 通常repositoryとmap repositoryを抽出する。
8. 既存runtime fallbackとsnapshot検証を接続する。
9. atomic restoreを抽出する。
10. legacy migration / cleanupをjournal、検証、staging、commitに分ける。
11. recovery candidate / archive / adoptionを分ける。
12. capability portとarchitecture testを固定する。
13. 最後に互換facadeを新moduleから組み立てる。

各手順は原則独立PRとし、物理schema変更が必要になった時点で止める。

### 14.5 必須試験

- named `db`、default `db`、公開型、`db.STORES`、全method/property shape
- 初回起動、空DB、通常保存、reload
- DB v5、既知の前方互換v7、未知の新version拒否
- 複数store、map個別保存、CAS競合
- runtime fallback、壊れたmetadata/checkpoint/fallback
- legacy migration準備・再開・検証・cleanup延期
- recovery候補列挙、archive、adoption、再検証
- atomic restoreの成功、途中失敗、retry
- Release A browser、source互換rehearsal、immutable release package rehearsal
- 分割前後のraw record、metadata、checkpoint、journal、archiveのgolden一致
- 受入済み旧artifactのDBを新版で読み書きし、互換floor以降の旧artifactへ戻して再読込

transaction順序は、注入したprimitiveで契約上必要な順序だけをassertする。実browserの非決定的なevent/microtask順を丸ごとgolden化しない。

### 14.6 完了条件

- 同一fixtureと操作について既存の非決定値を正規化した後、DB version、store、key、物理record shape、metadata、checkpoint、journal、archiveのgolden差分が0件である。
- `src/utils/indexedDB.ts` がnamed/default exportを維持する薄い互換facadeである。
- connectionとruntime stateのownerが各1箇所である。
- migration、recovery、cleanup、通常writeのcapabilityが分離される。
- 循環依存と禁止依存がarchitecture gateで0件である。
- 既存永続化test、一般E2E、Release A gate、相互運用が成功する。

## 15. lint警告削減

警告は各フェーズで触る範囲から減らし、最後へ一括延期しない。

1. 保存、取込、map、focusの状態遷移に関係するHooks警告
2. `App.tsx`
3. `FocusMode.tsx`
4. `FocusModeMapCanvas.tsx`
5. `MapCanvas.tsx` / `MapView.tsx`
6. その他component
7. 未使用、`prefer-const`、不要escape、`no-explicit-any`

Hooks 83件を自動一括修正しない。各警告を「不足依存」「不要effect」「安定化callback」「一度だけの意図」「外部購読」に分類する。

最終条件はエラー0、警告0、新規disable 0、保存回数・listener数・render性能の回帰なしである。警告0になったPRでidentity baselineを削除し、CIを `--max-warnings 0` に固定する。

## 16. PR・品質ゲート

### 16.1 PR系列

| ID         | 内容                                                                           | 主リスク         |
| ---------- | ------------------------------------------------------------------------------ | ---------------- |
| 0A-1       | Node/toolchain固定、EOL解消                                                    | build環境        |
| 0A-2       | encoding/EOL/format/typecheck/lint範囲                                         | 品質設定         |
| 0A-3       | lint/disable/audit baseline、CI骨格                                            | gate判定         |
| 0B-1       | Playwright smokeとfixture                                                      | E2E基盤          |
| 0B-2..4    | 代表6シナリオを機能群ごとに追加                                                | 利用者操作       |
| 0B-5       | axe baselineと既存重大違反修正                                                 | a11y             |
| 0C         | bundle/list/XLSX計測、coverage、branch protection                              | 計測・CI         |
| 1A         | injectManifest parity、PWA harness、artifact ID、旧/新registration対応verifier | 配布識別         |
| 1B         | prompt registration、idle port、blocker、verifier期待値切替                    | 更新・保存       |
| 1C         | 複数client、既存cleanup統合                                                    | client協調       |
| 1D         | Release A verifier/runbook/immutable release package rehearsal                 | 運用             |
| 2A         | Tailwindローカル化、runtime route停止                                          | 視覚・offline    |
| 2B         | Tailwind floor設定、旧runtime cache削除                                        | rollback・cache  |
| 3A         | bootstrap外部化、Report-Only                                                   | 起動・CSP        |
| 3B         | CSP強制                                                                        | 配信             |
| 4A         | XLSX軽量境界                                                                   | dependency       |
| 4B         | Worker feasibilityとclient                                                     | browser/取消     |
| 4C         | map解析Worker                                                                  | map取込          |
| 4D         | event import/export Worker                                                     | file互換         |
| 5A         | row model                                                                      | 並び順           |
| 5B         | scroll/focus adapter                                                           | navigation       |
| 5C         | QA-only仮想化spike                                                             | feasibility      |
| 5D         | production仮想化とDnD                                                          | 描画・入力・a11y |
| 6以降      | App責務を1つずつ抽出                                                           | 状態調停         |
| App完了後  | persistenceを低リスク順に抽出                                                  | 保存互換         |
| lint final | baseline削除、警告0                                                            | lint挙動         |
| 観測後     | Worker rollout旧経路、virtual rollout flagを削除                               | rollback縮小     |

rollout旧経路・フラグ削除を「lint final」と同じPRにしない。既定ON後の観測を終えた別releaseで行う。

### 16.2 gateの層

**source PR gate**

```powershell
npm run quality:pr
```

`quality:pr` はencoding、format、全typecheck、lint identity、Vitest、evidence validator test、導入済みcoverage/architecture、通常build、同じmanaged preview上の通常E2E/a11yを順に実行する。未導入検査は担当フェーズでpackage scriptとrunnerを同時追加し、そのフェーズ以降のrequired checkにする。存在しないコマンドを先行フェーズの必須条件にはしない。

**clean artifact gate**

```powershell
npm run quality:artifact
```

`quality:artifact` は `build:release-a` を1回だけ実行する。`build:release-a` はapp build → version付きartifact manifest生成 → Release A build verifierの順で完了してから戻る。orchestratorはmanifest、dist hash、provider header/config snapshotからrelease packageを組み立ててID/archive hashを固定後、同じdistを同じheader設定で1回だけread-only serveし、Release A browserとPWA projectを実行する。試験後はpackage ID/hashを参照するdetached release evidenceを生成し、検証後の再build、dist/package書換えを禁止する。

複数version遷移は単一artifact gateへ混ぜず、次の専用commandで試験する。

```powershell
npm run quality:transition -- --scenario <transition-plan.json>
```

scenario manifestは順番付きrelease package path、期待ID/hash、操作、rollback先、browser profile IDを持つ。runnerは全packageを先にhash検証し、同じprofileでautoUpdate → prompt、A → B → rollback → B、Tailwind safe-hold → cache cleanup、CSP Report-Only → 強制 → safe rollback等を順にserveする。packageを再buildせず、途中失敗でもprofileと証跡を隔離保存してserverを終了する。

**provider / release gate**

- provider Previewの実CSP/security header
- 実Google Sheets canary
- immutable release package往復
- Windows Chrome/Edge、Android Chromeの実installed PWA
- 定期auditとwaiver照合
- 実証跡JSONに対する `verify:release-a-evidence -- <path>`

`quality:release` はpreview URL、release-package manifest、detached evidence出力先を必須引数にし、未指定で成功しない。完了時に `verify:release-a-evidence -- <path>` で生成物を検証する。

### 16.3 フェーズ昇格matrix

各source PRはsource gateでmergeできるが、次フェーズへの昇格、互換floor設定、既定ON、強制policyは次の列をすべて満たしてから行う。

| フェーズ      | source gate                    | clean artifact gate                                     | provider / release gate                                      |
| ------------- | ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| 0A–0B         | 必須                           | 未導入分は非適用                                        | provider変更なし                                             |
| 0C            | 必須                           | 現行autoUpdate artifactでbaseline必須                   | canary手順だけ固定                                           |
| 1 PWA         | 必須                           | prompt、複数client、rollback必須                        | installed PWAとimmutable往復後にprompt floor設定             |
| 2 Tailwind    | 必須                           | visual、offline、`quality:transition` で旧cache試験必須 | preview/installed PWA確認後にTailwind floor、続いてcache削除 |
| 3 CSP         | 必須                           | local header serverで必須                               | provider Previewと実Google canary成功後だけ強制              |
| 4 Worker      | 必須                           | 3操作、CSP、offline必須                                 | paired OFF packageと実browser確認後だけ既定ON                |
| 5 仮想化      | 必須                           | 300/1,000件、DnD、a11y必須                              | paired OFF packageと実desktop/mobile確認後だけ既定ON         |
| 6 App         | 必須                           | 通常/PWA smoke必須                                      | provider smoke成功後にフェーズ完了                           |
| 7 persistence | 必須                           | Release A、相互運用、rollback必須                       | immutable往復と復旧runbook成功後に完了                       |
| lint final    | 警告0必須                      | 通常artifact gate必須                                   | provider smoke。rollout分岐はまだ削除しない                  |
| M2            | rollout削除PRのsource gate必須 | 残る既定経路の全artifact gate必須                       | 観測条件と連続release条件を満たしてからrollout分岐削除       |

## 17. リリース、観測、ロールバック

### 17.1 milestone

- **M1 安定運用開始**: Workerと仮想化が既定ON、rollout旧経路を保持し、フェーズ0〜5の適用gateを通過。
- **M2 計画完了**: 各機能ADRで事前に固定した観測期間と連続release条件を満たし、rollout専用の旧経路とflagを削除。恒久fallbackは維持。

観測期間と必要release数は既定ON前に機能別ADRへ固定する。結果を見た後に短縮しない。

### 17.2 feature flag

Workerと仮想化は、`OFF QA` → `ON QA` → `既定ON・rollout旧経路保持` → `観測` → `rollout旧経路/flag削除` の順に進める。flag値はartifact IDの入力とmanifestへ含める。小規模listと明示的a11y用の全件rendererは削除対象にしない。

Workerとvirtualの観測期間が重なるrelease candidateは、`ON/ON`、`OFF/ON`、`ON/OFF`、`OFF/OFF` の4variantを作る。各variantは同一sourceと他設定を使い、固有artifact IDを持ち、対象経路のartifact gateを通す。観測完了したflagのvariantだけを次releaseから廃止する。

AppとIndexedDBの純粋な抽出はfeature flagではなく、小さいPRと互換facadeで戻せるようにする。

### 17.3 immutable release package

release packageにはdist archive、artifact manifest、release-package manifest、provider header/config snapshot、source SHA、artifact/release package ID、lockfile hash、toolchain、flags、delivery revision、CSP policy ID/mode、主要hashを含める。品質・遷移・provider証跡は、release package ID/archive hashとprovider deployment IDを参照するdetached release evidence/indexとして別保存する。providerで「現行 → rollback → 現行」を、保存済みpackageまたは対応するimmutable deploymentそのもので演習する。

PWA互換floor以前、保存schema互換外、旧localStorage原本を必要とするartifactへ戻さない。

### 17.4 観測

既存のprivacy-safe persistence metricsは継続利用する。Worker失敗率や仮想化失敗率の本番収集基盤は本計画で新設しないため、存在しない率を停止基準にしない。

| 兆候                          | データ源                            | 停止条件                       | 初動                                                                                                                         |
| ----------------------------- | ----------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 起動不能・CSP操作不能         | E2E、provider console、再現済み報告 | 1件再現                        | 配布停止、直前release package                                                                                                |
| 保存・復旧不能                | 既存metrics、復旧画面、再現済み報告 | 1件確認                        | 即時停止、既存runbook                                                                                                        |
| update中の世代不一致          | PWA E2E、artifact/build ID          | 1件再現                        | point-of-no-return前はactivate停止。以後/不明は凍結維持しmatching artifactへreloadまたはclose。safe-holdはforward deployment |
| Worker/XLSX失敗               | E2E、QA、再現済み報告               | 基準fixtureまたは主要操作で1件 | paired Worker OFF package                                                                                                    |
| 仮想化空白・誤drop・focus消失 | E2E、QA、再現済み報告               | 主要操作で1件                  | paired virtual OFF package                                                                                                   |

利用者の品目、備考、file内容をlogやartifactへ含めない。

## 18. 決定事項と期限

| 項目                 | 決定                                                                                                      | 期限 / owner                |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------- |
| Node                 | Node 24 LTSを正式対象                                                                                     | 0A / build owner            |
| PWA                  | injectManifest + prompt + `skipWaiting`/`clientsClaim`既定無効 + election/presence lock + permit protocol | 1A–1C / PWA owner           |
| 配布identity         | source SHA、artifact ID、release package IDを分離                                                         | 1A / release owner          |
| Tailwind             | 3.4系を固定し、4系upgradeを混在させない                                                                   | 2開始前 / frontend owner    |
| theme bootstrap      | 自己ホスト外部script。inline hash方式は採らない                                                           | 3A / security owner         |
| CSP delivery         | policy mode/revisionをartifact入力にし、同一artifactのheader差替え禁止                                    | 3A / security+release owner |
| XLSX cache           | 初期方針はprecache。予算超過時だけ再ADR                                                                   | 4B前 / PWA owner            |
| Worker fallback      | runtime main-thread fallbackなし。rollout中はflag別paired package                                         | 4B / performance owner      |
| 仮想化library / ARIA | QA spike合格後に固定                                                                                      | 5C / list+a11y owner        |
| App coordinator      | inventoryで必要性を証明した場合だけ独立PR                                                                 | 6開始時 / app owner         |
| persistence配置      | 現行module対応表を維持し、移動と分割を分離                                                                | 7開始時 / persistence owner |

未決事項は依存フェーズの開始前にADRで決定し、未決のまま実装PRへ入らない。

## 19. 全体完了条件

M2時点で次をすべて満たす。

- Node 24 LTSのfresh cloneから全required gateを再現できる。
- PWA更新は単一client・全blocker idle・明示承認時だけ強制適用され、複数clientではfail-closedになる。
- Tailwind CDN、Tailwind runtime cache、実行可能inline script、inline `<style>` 要素がない。Reactの必要なstyle属性はCSPで明示的に限定許可される。
- 強制CSPが実responseへ1件だけ適用され、installed PWAのonline/offline navigationを含む主要操作に違反がない。
- ExcelJSが初期request graphから外れ、3つのXLSX操作がWorkerで動く。
- 既定の仮想表示で300件・1,000件を全件DOM化せず、DnD、focus、a11yを維持する。
- `App.tsx` が客観的なフェーズ6 gateを満たす。
- `indexedDB.ts` がnamed/default APIを維持する互換facadeになり、保存・移行・復旧責務が分離される。
- lintエラー0、警告0、新規disable 0である。
- 新規Critical/High依存がなく、既存waiverにownerと未超過の期限がある。
- 通常E2E、a11y、PWA、永続化、immutable release package rollbackを継続実行できる。
- feature flag、Worker rollout旧経路、virtual rollout分岐が観測後の別PRで削除され、承認済みの小規模/a11y全件rendererは維持されている。
- README、runbook、開発手順、artifact/release package/evidence schemaが実装と一致する。
- UTF-8、BOMなし、既存改行方針を維持し、文字化け検査が成功する。

## 20. 再レビュー記録

2026-08-05に、文書内部、実装整合、tooling/品質ゲートの3観点で再レビューし、対象文書を直接編集しない独立レビュー結果を本改訂へ反映した。

| 重大指摘                                          | 解消内容                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| 既存lazy chunkがあるのにPWA安全化が遅い           | PWAをTailwind/CSPより前のフェーズ1へ移動                        |
| prompt化でRelease A検証が壊れる                   | build/browser/rollback/runbook/evidenceの追随を同フェーズへ追加 |
| inline外部化とhash案が矛盾                        | 自己ホスト外部bootstrapへ決定                                   |
| 未実装WorkerをCSP受入に含める                     | 実Worker試験をフェーズ4へ移動                                   |
| App分割と新state architectureを混在               | coordinatorを必要時の独立PRへ分離                               |
| PWA単一client証明がlockだけで不十分               | client列挙、version handshake、mount前照合を必須化              |
| `clientsClaim` 無効なのに `controllerchange` 待ち | waiting Workerのactivation監視後に明示reload                    |
| generateSWではcustom update protocolを持てない    | injectManifestとpermit付きService Workerへ移行                  |
| fresh installのcontroller不在でreload loop        | startupをfresh/uncontrolled/controlledへ分岐                    |
| blockerが現行local draftを網羅しない              | component adapter/contextと全draft inventoryを追加              |
| 既存persistence moduleと目標が重複                | 現行→目標の対応表とpath維持方針を追加                           |
| XLSX Workerが既存restore経路を省略                | plain resultまでに限定し、原子的restore pipelineを維持          |
| Worker OFF artifactとWorker-only依存が矛盾        | build-time選択の共通XlsxExecutionPortへ統一                     |
| 行モデルが折りたたみgroupを表現不足               | render rowとlogical group、mount targetを分離                   |
| App抽出でソース文字列testが破綻                   | 不変条件ベースのintegration testへ先行置換                      |
| 仮想化でDnDだけ途中から旧描画                     | QA hard gateを置き、productionではrenderer途中切替を禁止        |
| 品質コマンドが存在せず実行順も不成立              | source / artifact / provider gateとmanaged previewへ再設計      |
| rollbackが不変artifactではない                    | source互換試験とimmutable release package試験を分離             |
| build IDがflag違いを識別できない                  | source SHAとartifact IDを分離                                   |
| CSP header差替えがprecacheへ反映されない          | delivery revisionをartifact/SW入力にしinstalled遷移を試験       |
| packageへ試験後に証跡追記するとIDが変わる         | deployable payloadとdetached release evidenceを分離             |
| a11y baselineと0件条件が不一致                    | 段階別manifest判定を明記                                        |
| 最終PRのflag削除と観測期間が矛盾                  | M1とM2、観測後の別PRへ分離                                      |

この改訂の根拠は、対象commitのソース、設定、既存runbook、実build、および `typecheck`、lint、全Vitestの実行結果である。

## 21. 参考

- Node.js Releases: <https://nodejs.org/en/about/previous-releases>
- Vite PWA prompt registration: <https://vite-pwa-org.netlify.app/guide/prompt-for-update>
- Vite PWA injectManifest: <https://vite-pwa-org.netlify.app/guide/inject-manifest>
- Service Worker lifecycle: <https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API>
- Web Locks API: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API>
- Vercel custom headers: <https://vercel.com/docs/headers>
