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
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/[0.55] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-reimport-confirmation-title"
        className="max-h-[calc(100vh-32px)] w-[min(620px,100%)] overflow-y-auto rounded-xl bg-white p-6 text-gray-800 shadow-[0_20px_50px_rgba(0,0,0,0.3)]"
      >
        <h2 id="map-reimport-confirmation-title" className="mb-3 text-[22px]">
          マップを入れ替える前の確認
        </h2>

        <p className="mb-3 leading-[1.7]">
          新しいマップに入れ替えると、古い地図上の位置を使う設定はそのまま使えません。
          買い物リスト、購入状態、実行順、経路線の表示ON/OFF、別の日・別のイベントは残ります。
        </p>

        <div className="mb-4 rounded-lg bg-gray-100 p-3">
          <strong>入れ替える対象</strong>
          <ul className="mt-2 pl-6">
            {plan.targets.map((target) => (
              <li key={`${target.eventDate}:${target.mapTabName}`}>
                {target.eventDate}（{target.mapTabName}）
              </li>
            ))}
          </ul>
        </div>

        <strong>確認後に初期化される内容</strong>
        <ul className="mb-4 mt-2 pl-6 leading-[1.7]">
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

        <label className="mb-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-gray-300 p-3">
          <input
            type="checkbox"
            checked={preserveMaplessHalls}
            onChange={(event) =>
              setPreserveMaplessHalls(event.currentTarget.checked)
            }
            className="mt-[3px]"
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
            className="mb-4 rounded-lg border border-amber-500 bg-amber-50 p-3 text-amber-800"
          >
            マップを使わない会場も削除します。会場
            {countLabel(impact.maplessHallDefinitionCount, "件")}、手動割り当て
            {countLabel(impact.maplessManualAssignmentCount, "件")}、巡回設定
            {countLabel(impact.maplessHallRouteDayCount, "日分")}
            が追加で初期化されます。
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ preserveMaplessHalls })}
            className="rounded-md border-0 bg-amber-700 px-3.5 py-2 font-bold text-white"
          >
            理解してマップを入れ替える
          </button>
        </div>
      </section>
    </div>
  );
}
