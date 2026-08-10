export const LIST_RENDERER_PREFERENCE_STORAGE_KEY =
  "__esp_internal__:list-renderer-preference:v1";

export type ListRendererPreference = "auto" | "full";

export type ListRendererPreferenceReadResult =
  | {
      readonly status: "ok";
      readonly value: ListRendererPreference;
    }
  | {
      readonly status: "missing" | "invalid" | "unavailable";
    };

export interface ListRendererPreferencePort {
  read(): ListRendererPreferenceReadResult;
  write(value: ListRendererPreference): boolean;
}

export const resolveListRendererPreference = (
  result: ListRendererPreferenceReadResult,
): ListRendererPreference =>
  result.status === "ok"
    ? result.value
    : result.status === "missing"
      ? "auto"
      : "full";
