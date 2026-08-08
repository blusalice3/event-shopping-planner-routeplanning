import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

export interface CommittedStateController<T> {
  readonly value: T;
  readonly valueRef: MutableRefObject<T>;
  readonly commit: (next: T) => void;
  readonly set: Dispatch<SetStateAction<T>>;
  readonly update: (updater: (current: T) => T) => T;
}

/**
 * State command port whose ref is committed synchronously before React renders.
 *
 * App commands can therefore compose multiple updates in one event without
 * reading a stale render snapshot.
 */
export const useCommittedState = <T>(
  initialValue: T,
): CommittedStateController<T> => {
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(initialValue);

  const commit = useCallback((next: T) => {
    valueRef.current = next;
    setValue(next);
  }, []);

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      commit(
        typeof next === "function"
          ? (next as (current: T) => T)(valueRef.current)
          : next,
      );
    },
    [commit],
  );

  const update = useCallback(
    (updater: (current: T) => T): T => {
      const next = updater(valueRef.current);
      commit(next);
      return next;
    },
    [commit],
  );

  return { value, valueRef, commit, set, update };
};
