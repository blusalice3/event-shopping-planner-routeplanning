import {
  useCallback,
  useReducer,
  type Dispatch,
  type SetStateAction,
} from "react";

export type TypedStateGroupAction<T extends object> = {
  [K in keyof T]: {
    readonly type: "set-field";
    readonly key: K;
    readonly value: SetStateAction<T[K]>;
  };
}[keyof T];

export const typedStateGroupReducer = <T extends object>(
  state: T,
  action: TypedStateGroupAction<T>,
): T => {
  const current = state[action.key];
  const next =
    typeof action.value === "function"
      ? (action.value as (previous: typeof current) => typeof current)(current)
      : action.value;

  return Object.is(current, next)
    ? state
    : ({ ...state, [action.key]: next } as T);
};

export interface TypedStateGroupController<T extends object> {
  readonly state: T;
  readonly setField: <K extends keyof T>(
    key: K,
    value: SetStateAction<T[K]>,
  ) => void;
  readonly dispatch: Dispatch<TypedStateGroupAction<T>>;
}

export const useTypedStateGroup = <T extends object>(
  createInitialState: () => T,
): TypedStateGroupController<T> => {
  const [state, dispatch] = useReducer(
    typedStateGroupReducer<T>,
    undefined,
    createInitialState,
  );
  const setField = useCallback(
    <K extends keyof T>(key: K, value: SetStateAction<T[K]>) => {
      dispatch({ type: "set-field", key, value } as TypedStateGroupAction<T>);
    },
    [],
  );

  return { state, setField, dispatch };
};
