# 共有・連携機能 運用計画

> 状態: Draft／未着手
>
> 本書は新規実装後の有効化、監視、停止、rollback、保持のrunbookである。現時点では共有機能、
> Supabase migration、共有用DB試験、E2E runnerは存在しない。

## 1. 運用原則

- local-first: 共有障害や無効化で既存local eventを失わせない。
- default off: clientとserverのgateを明示的に開くまで共有を起動しない。
- default deny: RLSとRPCで許可されていないaccessを拒否する。
- forward-only: DB修正は原則として前方migrationで行う。
- secret minimization: client、log、診断、XLSXへ秘密を残さない。
- staged rollout: local、staging、限定pilot、productionの順に開放する。
- evidence separation: 日々のconsole出力や長い作業記録をこの規範文書へ追記しない。

## 2. feature gate

### 2.1 client gate

追加予定:

```text
VITE_SHARING_ENABLED=true
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

規則:

- `VITE_SHARING_ENABLED`は文字列`true`との厳密一致だけを有効とする。
- 未設定、false、URL／anon key欠落時は共有入口、Auth、Realtime、outbox senderを起動しない。
- URLとanon keyだけでrelease可と判定しない。
- service role key、DB password、invite用server秘密を`VITE_`変数へ入れない。
- `.env`の実値をcommitしない。
- Auth sessionを永続化する場合はSupabase SDK管理storageだけを使い、独自copyを作らない。
- logout時にSDK sessionを削除し、共有端末でsessionが残るriskを利用者へ案内する。

### 2.2 server gate

server側で次を独立して停止できるようにする。

- room作成
- 新規参加
- 通常業務write

安全なread、room終了、資格失効などをwrite gate停止時に許可するかはRPC catalogで明示する。
client gateを閉じても旧clientが動く可能性があるため、incident時はserver gateを先に閉じる。

## 3. 環境

| 環境 | 用途 | data |
| --- | --- | --- |
| local | migration、RLS、RPC、破壊試験 | fixtureだけ |
| staging | browser、PWA、rollout rehearsal | synthetic dataだけ |
| pilot | 限定利用と上限実測 | 同意したpilot data |
| production | 正式利用 | retentionと監視を適用 |

要件:

- stagingとproductionは別Supabase project、別frontend設定、別secretを使う。
- deploy前にproject URL、environment名、gate状態を二者確認する。
- local reset、負荷fixture、破壊的試験をremote projectで実行しない。
- production schemaをstaging代わりに使わない。

現行repoにはSupabase CLI構成がないため、導入されるまではremote migration手順を「未整備」とする。
CLI versionとcommandは実装時に固定し、存在しないcommandを本書へ実行済みとして記録しない。

### 3.1 pilot creator code

- operatorだけが短期・一回限りのcreator codeを発行できるようにする。
- serverにはHMAC、期限、使用／失効状態だけを保存する。
- 生codeをticket、chat log、diagnosticへ転載しない。
- 紛失時は旧codeを失効し、新codeを発行する。
- productionで公開作成へ移る場合は、rate、abuse、費用の再設計後にprotocolを変更する。

## 4. secretとprivacy

clientへ配布可能:

- Supabase project URL
- anon key

clientへ配布禁止:

- service role key
- DB password
- invite codeのHMAC secret
- backup credential
- operator credential

log、analytics、diagnosticへ記録禁止:

- invite URL、fragment、QR payload、manual code
- Auth access／refresh token
- 商品名、remarks、価格などの業務payload
- nickname、生のuser ID
- request payload、request hash

error code、app／protocol version、件数、遅延、gate状態など、運用に必要な非秘密metadataだけを記録する。

## 5. 通常deploy

共有資材が実装された後の順序:

1. Git管理下のclean working tree、対象commit、環境、責任者を確認する。
2. [検証計画](./sharing-feature-verification.md)のcode gateとlocal DB gateを実行する。
3. backup、forward fix、client rollbackの手順を確認する。
4. server gate OFFのまま互換的なmigration、RLS、RPCを適用する。
5. 生成型とclientをgate OFFでdeployする。
6. local-only機能と共有入口非表示をsmoke testする。
7. stagingでserver gateを開き、作成、参加、同期、退出、終了、fallbackを確認する。
8. 限定pilot対象だけclient gateを開く。
9. error、outbox、Auth、Realtime、費用、cleanupを観測する。
10. pilotの中止条件を満たさないことを確認してからproduction拡大を判断する。

DBとclientを同時に非互換変更しない。serverは少なくとも直前clientを安全に拒否またはread-onlyへ
移行できるprotocol境界を持つ。

## 6. quality command

現行repoで利用できるcommand:

- `npm run typecheck`
- `npm run lint`
- `npm run test:run`
- `npm run format:check`
- `npm run build`

将来追加するもの:

- local Supabase migration reset／forward upgrade
- DB contract／RLS／競合試験
- 複数browser context E2E
- accessibility自動補助検査

追加後は`package.json`または再現可能なtool設定を正本とする。手作業だけの秘密値付きcommandを
文書へ貼り付けない。

## 7. 即時停止とrollback

### 7.1 停止順序

1. serverの通常業務write gateをOFFにする。
2. 必要に応じてjoinとroom作成もOFFにする。
3. client gate OFF版をdeployし、Auth／Realtime／senderの新規起動を止める。
4. 必要なら直前の互換clientへrollbackする。
5. outboxを削除せず`blocked`または隔離状態で保持する。
6. 影響、復旧、再開条件を秘密なしで記録する。

### 7.2 禁止するrollback

- local eventや既存10 storeの削除
- IndexedDB versionのdowngrade
- 未送信outboxの無条件削除
- 適用済みmigration fileの書換え
- production dataを失うdown migrationの即時実行
- gate OFFだけでcross-room accessを修復済みと判断すること

schema不具合はgate OFFとclient停止を先に行い、原則としてforward fix migrationで修復する。

### 7.3 即時停止条件

- cross-room read／write
- 未認証または退出済みmemberのaccess
- local dataの消失または別eventへの誤merge
- 同じoperationの重複副作用
- 購入状態と限数購入数の不整合
- invite／Auth／server secretの漏えい
- offline復帰でoutboxが消失または無限再送
- 対象browserで繰り返すcrash
- keyboardだけでは終了できない重大なaccessibility blocker

## 8. 障害別の初動

### 8.1 Auth障害

- 新規create／joinを停止する。
- 既存sessionのwrite成功を推測しない。
- 401 operationは同一operation IDを保ったままrefresh後に再試行する。
- refresh不能ならoutboxをblockedにしてlocal継続を案内する。

### 8.2 RPC／DB障害

- timeoutを失敗確定とみなさず`outcome_unknown`にする。
- 同一operationのreceipt確認または冪等再送で結果を確定する。
- error率とDB状態を確認し、必要なら通常write gateを閉じる。
- 復旧後に別operation IDで同じ副作用を自動作成しない。

### 8.3 Realtime障害

- RPC writeの成否とRealtime接続を分けて表示する。
- control／revisionをpollし、差分またはsnapshotで収束させる。
- Realtime復旧だけで未送信operationをconfirmedにしない。

### 8.4 invite漏えい

- 対象credentialを失効する。
- 新規joinを一時停止する。
- active memberをhostが確認する。
- 必要なら新credentialを発行する。
- tokenやcode自体をincident記録へ貼らない。

### 8.5 RLS逸脱

- 全通常writeとjoinを即時停止する。
- 影響tableとroom境界を特定する。
- client rollbackだけで直さず、policy／grantのforward fixとnegative testを行う。
- 影響範囲、通知、credential失効、再開条件を判断する。

### 8.6 容量／費用超過

- room作成を先に停止する。
- snapshot、Realtime、receipt、retentionの増加源を確認する。
- 既存roomの安全な終了とexportを優先する。
- 上限を無検証で引き上げない。

## 9. offlineとfallback

- `navigator.onLine`は参考表示にだけ使い、実際のrequest結果で接続状態を判断する。
- 自動retryはbackoffとjitterを使い、永久errorを繰り返さない。
- create／invite rotationはoffline queueへ入れない。応答喪失後は非秘密operation IDからroomを確認し、
  新credentialへrotateする。
- 共有中のapplication writerは1 tabに限定し、非owner tabをread-onlyにする。
- `blocked`と`outcome_unknown`を利用者が確認できるようにする。
- MVPのfallbackは端末単位とし、他memberやserver roomを一括変更しない。
- fallback開始前に未送信件数と結果不明operationを表示する。
- onlineの一般memberは退出、hostはroom終了を試みる。hostはopen roomから直接退出しない。
- offlineならserver資格を変更できないことを表示し、outboxをblockedとして隔離してsenderを停止する。
- fallback後はsenderを停止し、local変更を旧roomへ戻さない。
- 必要に応じて既存XLSX exportでlocal copyを退避する。
- serverが復旧しても自動的に旧room共有へ戻さない。再共有は別の明示操作とする。

## 10. 監視

最低限のsignal:

- Anonymous Auth成功／失敗率
- RPC operation別成功／安定error／予期しないerror
- Realtime接続失敗と再接続
- outbox件数、最古entry時刻、`outcome_unknown`件数
- revision conflictとidempotency conflict
- open／closing／expired room件数
- cleanup成功／失敗
- app／protocol version mismatch
- DB容量、egress、Realtime、Auth利用量

個人や商品内容をlabelへ使わない。room IDを扱う場合もaccessを制限し、公開dashboardへ出さない。

alert閾値はpilot実測後に決める。旧版の件数、割合、Free枠をそのまま固定値へしない。

## 11. retentionと削除

実装前にtableごとに次を決める。

- 保存目的
- retention起点
- 保存期間
- export可否
- delete方法
- cascade対象
- backupからの消去方針

cleanup要件:

- active roomを削除しない。
- closed／expired roomを設定期間後に物理削除する。
- invite、receipt、rate metadataを業務dataと別期間にできる。
- jobは冪等で、部分失敗後に再実行できる。
- cleanup失敗を監視する。
- 利用者に保存期間とlocal退避方法を表示する。

## 12. 定期rehearsal

pilot前と重要変更後に次を行う。

- server gate停止と再開
- client gate OFF deploy
- 直前clientへのrollback
- migrationのlocal resetと前方upgrade
- backup／restore
- invite失効
- Realtime断とpolling収束
- outbox timeout／結果不明
- room終了とfallback
- retention cleanup
- RLS negative test
- CSPとService Worker cache確認

実施結果は対象commit、環境、日時、reviewerを持つrelease証跡へ保存し、本書へ長い時系列を追記しない。
