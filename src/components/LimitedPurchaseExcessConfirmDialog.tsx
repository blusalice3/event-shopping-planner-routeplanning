import LimitedPurchaseConfirmDialog from "./LimitedPurchaseConfirmDialog";

type LimitedPurchaseExcessConfirmDialogProps = {
  isOpen: boolean;
  isModal?: boolean;
  onFix: () => void;
  onConvertToPurchased: () => void;
};

export default function LimitedPurchaseExcessConfirmDialog({
  isOpen,
  isModal = true,
  onFix,
  onConvertToPurchased,
}: LimitedPurchaseExcessConfirmDialogProps) {
  return (
    <LimitedPurchaseConfirmDialog
      isOpen={isOpen}
      isModal={isModal}
      title="実購入数が購入予定量を超過しています"
      message="修正しますか"
      cancelLabel="修正する"
      confirmLabel="購入済にする"
      initialFocus="cancel"
      onCancel={onFix}
      onConfirm={onConvertToPurchased}
    />
  );
}
