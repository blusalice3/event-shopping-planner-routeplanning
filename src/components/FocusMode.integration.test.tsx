import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FocusMode from './FocusMode';
import {
  StatefulFocusModeHarness,
  completedFixture,
  completedWithLastChangeFixture,
  incompleteSessionFixture,
  minimalProps,
  singleVisitNoneItemFixture,
} from './FocusMode.fixtures';

// fake timers は必要なテストだけでスコープを絞る。
// runAllTimersAsync は setInterval 等も一気に走って過剰進行するため、pending な timer だけを複数回 drain する。
const flushAsync = async (cycles = 3) => {
  for (let i = 0; i < cycles; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
};

describe('FocusMode resume dialog - integration', () => {
  it('completed resume state with no visits renders the empty visit state', () => {
    render(<FocusMode {...minimalProps({ resumeState: completedFixture })} />);

    expect(screen.getByText('訪問先がありません')).toBeInTheDocument();
    expect(screen.queryByText('全ての訪問先を確認しました')).toBeNull();
  });

  it('同一マウントで resumeState=null → non-null (isCompleted=true) 遷移時に再開ダイアログが表示される', async () => {
    const { rerender } = render(
      <FocusMode {...minimalProps({ resumeState: null, ...singleVisitNoneItemFixture })} />,
    );
    expect(screen.queryByText('集中モードを再開しますか？')).toBeNull();

    rerender(
      <FocusMode
        {...minimalProps({ resumeState: completedFixture, ...singleVisitNoneItemFixture })}
      />,
    );

    expect(await screen.findByText('集中モードを再開しますか？')).toBeInTheDocument();
  });

  it('初回 resumeState=isCompleted=true → 再開ダイアログが表示される', async () => {
    render(
      <FocusMode
        {...minimalProps({ resumeState: completedFixture, ...singleVisitNoneItemFixture })}
      />,
    );
    expect(await screen.findByText('集中モードを再開しますか？')).toBeInTheDocument();
  });

  it('初回 resumeState=isCompleted=true → ダイアログ表示中に isCompleted=false の書き戻しが発生しない', async () => {
    vi.useFakeTimers();
    try {
      const onSessionStateChange = vi.fn();
      render(
        <FocusMode
          {...minimalProps({
            resumeState: completedFixture,
            onSessionStateChange,
            ...singleVisitNoneItemFixture,
          })}
        />,
      );
      await flushAsync();
      expect(screen.getByText('集中モードを再開しますか？')).toBeInTheDocument();
      await flushAsync();

      const hasFalseWrite = onSessionStateChange.mock.calls.some(
        ([payload]) => payload.isCompleted === false,
      );
      expect(hasFalseWrite).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('pointer 選択で完了画面が表示される (lastPurchaseChangeAt あり)', async () => {
    const user = userEvent.setup();
    render(
      <FocusMode
        {...minimalProps({
          resumeState: completedWithLastChangeFixture,
          ...singleVisitNoneItemFixture,
        })}
      />,
    );
    await screen.findByText('集中モードを再開しますか？');
    await user.click(screen.getByRole('button', { name: /離脱時のポインタ位置/ }));
    expect(await screen.findByText('全ての訪問先を確認しました')).toBeInTheDocument();
  });

  it('normalStart 選択で通常フェーズ先頭の訪問 UI が表示される(完了画面ではない)', async () => {
    const user = userEvent.setup();
    render(
      <FocusMode
        {...minimalProps({ resumeState: completedFixture, ...singleVisitNoneItemFixture })}
      />,
    );
    await screen.findByText('集中モードを再開しますか？');
    await user.click(screen.getByRole('button', { name: /通常フェーズの最初から/ }));

    // 完了画面でも訪問先なし画面でもなく、通常の訪問 UI が出ること
    expect(screen.queryByText('全ての訪問先を確認しました')).toBeNull();
    expect(screen.queryByText('訪問先がありません')).toBeNull();
    expect(
      await screen.findByRole('button', { name: /Current status:/ }),
    ).toBeInTheDocument();
  });

  it('pointer 選択後も lastPurchaseChangeAt が親 payload に保持される', async () => {
    const user = userEvent.setup();
    const onSessionStateChange = vi.fn();
    render(
      <FocusMode
        {...minimalProps({
          resumeState: completedWithLastChangeFixture,
          ...singleVisitNoneItemFixture,
          onSessionStateChange,
        })}
      />,
    );

    await screen.findByText('集中モードを再開しますか？');
    await user.click(screen.getByRole('button', { name: /離脱時のポインタ位置/ }));
    await screen.findByText('全ての訪問先を確認しました');

    const latestCall = onSessionStateChange.mock.calls.at(-1);
    expect(latestCall).toBeDefined();
    const payload = latestCall![0];
    expect(payload.isCompleted).toBe(true);
    expect(payload.lastPurchaseChangeAt).toEqual(
      completedWithLastChangeFixture.lastPurchaseChangeAt,
    );
  });

  it('auto-advance 起動中に non-null → null 遷移すると、タイマーが発火せず phase/phaseIndex が動かない', async () => {
    const onSessionStateChange = vi.fn();

    // Phase 1: real timers でクリック操作を行い、auto-advance を起動させる
    const { rerender } = render(
      <StatefulFocusModeHarness
        initialItems={singleVisitNoneItemFixture.items}
        executeModeItemIds={singleVisitNoneItemFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
        onSessionStateChange={onSessionStateChange}
      />,
    );
    expect(screen.queryByText('集中モードを再開しますか？')).toBeNull();

    // 購入状態トグル button を 4 回クリック(None → Purchased → SoldOut → Absent → Postpone)
    // fireEvent.click は fake timers に依存せず同期的に click を発火する
    const statusButton = () => screen.getByRole('button', { name: /Current status:/ });
    fireEvent.click(statusButton()); // → Purchased
    fireEvent.click(statusButton()); // → SoldOut
    fireEvent.click(statusButton()); // → Absent
    fireEvent.click(statusButton()); // → Postpone

    // カウントダウン UI 出現で auto-advance 起動を目視検証
    expect(
      await screen.findByText(/秒後に次の訪問先へ移動します/),
    ).toBeInTheDocument();

    // Phase 2: fake timers に切り替えて遷移と進行を検証
    vi.useFakeTimers();
    try {
      rerender(
        <StatefulFocusModeHarness
          initialItems={singleVisitNoneItemFixture.items}
          executeModeItemIds={singleVisitNoneItemFixture.executeModeItemIds}
          resumeState={null}
          onSessionStateChange={onSessionStateChange}
        />,
      );
      await flushAsync();

      const baselineCall = onSessionStateChange.mock.calls.at(-1);
      expect(baselineCall).toBeDefined();
      const baselinePhase = baselineCall![0].phase;
      const baselinePhaseIndex = baselineCall![0].phaseIndex;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      const latestCall = onSessionStateChange.mock.calls.at(-1);
      expect(latestCall).toBeDefined();
      expect(latestCall![0].phase).toBe(baselinePhase);
      expect(latestCall![0].phaseIndex).toBe(baselinePhaseIndex);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('null → non-null (isCompleted=true) 遷移直後、遷移中ガードで isCompleted=false の書き戻しが発生しない', async () => {
    vi.useFakeTimers();
    try {
      const onSessionStateChange = vi.fn();
      const { rerender } = render(
        <FocusMode
          {...minimalProps({
            resumeState: null,
            ...singleVisitNoneItemFixture,
            onSessionStateChange,
          })}
        />,
      );
      await flushAsync();

      const callCountBefore = onSessionStateChange.mock.calls.length;

      rerender(
        <FocusMode
          {...minimalProps({
            resumeState: completedFixture,
            ...singleVisitNoneItemFixture,
            onSessionStateChange,
          })}
        />,
      );
      await flushAsync();

      expect(screen.getByText('集中モードを再開しますか？')).toBeInTheDocument();

      const postTransitionCalls = onSessionStateChange.mock.calls.slice(callCountBefore);
      expect(postTransitionCalls).toHaveLength(0);
      const hasFalseWrite = postTransitionCalls.some(
        ([payload]) => payload.isCompleted === false,
      );
      expect(hasFalseWrite).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
