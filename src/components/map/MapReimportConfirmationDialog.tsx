import { useEffect, useState } from "react";
import type {
  MapReimportOptions,
  MapReimportPlan,
} from "../../features/map/domain/mapReimport";

export interface MapReimportConfirmationDialogProps {
  isOpen: boolean;
  plan: MapReimportPlan | null;
  onCancel: () => void;
  onConfirm: (options: MapReimportOptions) => void;
}

const countLabel = (count: number, unit: string): string =>
  `${count.toLocaleString("ja-JP")}${unit}`;

export default function MapReimportConfirmationDialog({
  isOpen,
  plan,
  onCancel,
  onConfirm,
}: MapReimportConfirmationDialogProps) {
  const [preserveMaplessHalls, setPreserveMaplessHalls] = useState(true);

  useEffect(() => {
    if (isOpen) setPreserveMaplessHalls(true);
  }, [isOpen]);

  if (!isOpen || !plan) return null;

  const { impact } = plan;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0, 0, 0, 0.55)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-reimport-confirmation-title"
        style={{
          width: "min(620px, 100%)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          borderRadius: 12,
          padding: 24,
          color: "#1f2937",
          background: "#ffffff",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.3)",
        }}
      >
        <h2
          id="map-reimport-confirmation-title"
          style={{ margin: "0 0 12px", fontSize: 22 }}
        >
          マップを入れ替える前の確認
        </h2>

        <p style={{ margin: "0 0 12px", lineHeight: 1.7 }}>
          新しいマップに入れ替えると、古い地図上の位置を使う設定はそのまま使えません。
          買い物リスト、購入状態、実行順、経路線の表示ON/OFF、別の日・別のイベントは残ります。
        </p>

        <div
          style={{
            marginBottom: 16,
            borderRadius: 8,
            padding: 12,
            background: "#f3f4f6",
          }}
        >
          <strong>入れ替える対象</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 24 }}>
            {plan.targets.map((target) => (
              <li key={`${target.eventDate}:${target.mapTabName}`}>
                {target.eventDate}（{target.mapTabName}）
              </li>
            ))}
          </ul>
        </div>

        <strong>確認後に初期化される内容</strong>
        <ul style={{ margin: "8px 0 16px", paddingLeft: 24, lineHeight: 1.7 }}>
          <li>
            古い地図上の訪問地点：
            {countLabel(impact.visitPointCount, "件")}
          </li>
          <li>
            古いマップから作った会場：
            {countLabel(impact.mapHallDefinitionCount, "件")}
          </li>
          <li>
            消える会場への手動割り当て：
            {countLabel(impact.manualAssignmentCount, "件")}
          </li>
          <li>
            会場を回る順番・会場内リスト：
            {countLabel(impact.hallRouteDayCount, "日分")}
          </li>
          <li>
            拡大率と表示位置：
            {countLabel(impact.viewportDayCount, "日分")}
          </li>
          <li>
            回転状態：
            {countLabel(impact.rotationDayCount, "日分")}
            （取り込み時の角度に戻ります）
          </li>
        </ul>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginBottom: 12,
            border: "1px solid #d1d5db",
            borderRadius: 8,
            padding: 12,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={preserveMaplessHalls}
            onChange={(event) =>
              setPreserveMaplessHalls(event.currentTarget.checked)
            }
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>マップを使わない会場設定を残す（推奨）</strong>
            <br />
            手入力で作った会場と、その会場を回る順番は引き続き利用できます。
          </span>
        </label>

        {!preserveMaplessHalls && (
          <div
            role="alert"
            style={{
              marginBottom: 16,
              border: "1px solid #f59e0b",
              borderRadius: 8,
              padding: 12,
              color: "#92400e",
              background: "#fffbeb",
            }}
          >
            マップを使わない会場も削除します。会場
            {countLabel(impact.maplessHallDefinitionCount, "件")}、手動割り当て
            {countLabel(impact.maplessManualAssignmentCount, "件")}、巡回設定
            {countLabel(impact.maplessHallRouteDayCount, "日分")}
            が追加で初期化されます。
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ preserveMaplessHalls })}
            style={{
              border: 0,
              borderRadius: 6,
              padding: "8px 14px",
              color: "#ffffff",
              background: "#b45309",
              fontWeight: 700,
            }}
          >
            理解してマップを入れ替える
          </button>
        </div>
      </section>
    </div>
  );
}
