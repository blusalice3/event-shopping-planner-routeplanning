export type EventUpdatePreviewResult = "committed" | "failed" | "stale";

type SettleEventUpdatePreviewOptions<T> = {
  loadPreview: () => Promise<T>;
  isCurrent: () => boolean;
  commit: (preview: T) => void;
  onError: (error: unknown) => void;
};

export async function settleEventUpdatePreviewIfCurrent<T>({
  loadPreview,
  isCurrent,
  commit,
  onError,
}: SettleEventUpdatePreviewOptions<T>): Promise<EventUpdatePreviewResult> {
  let preview: T;
  try {
    preview = await loadPreview();
  } catch (error) {
    if (!isCurrent()) {
      return "stale";
    }

    onError(error);
    return "failed";
  }

  if (!isCurrent()) {
    return "stale";
  }

  commit(preview);
  return "committed";
}
