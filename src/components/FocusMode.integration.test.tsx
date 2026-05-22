import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { ShoppingItem } from '../types/item';

// fake timers は必要なテストだけでスコープを絞る。
// runAllTimersAsync は setInterval 等も一気に走って過剰進行するため、pending な timer だけを複数回 drain する。
const flushAsync = async (cycles = 3) => {
  for (let i = 0; i < cycles; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
};

const limitedItemsFixture = {
  items: [
    {
      id: 'limited-1',
      eventDate: '2026-01-01',
      block: 'A',
      number: '01a',
      circle: 'サークル1',
      title: '限数1',
      price: 1000,
      quantity: 5,
      purchaseStatus: 'LimitedPurchase',
      priorityLevel: 'none',
      remarks: '',
      url: '',
    },
    {
      id: 'limited-2',
      eventDate: '2026-01-01',
      block: 'A',
      number: '01a',
      circle: 'サークル1',
      title: '限数2',
      price: 1200,
      quantity: 5,
      purchaseStatus: 'LimitedPurchase',
      priorityLevel: 'none',
      remarks: '',
      url: '',
    },
    {
      id: 'next-visit',
      eventDate: '2026-01-01',
      block: 'A',
      number: '02a',
      circle: 'サークル2',
      title: '次の訪問先',
      price: 500,
      quantity: 1,
      purchaseStatus: 'None',
      priorityLevel: 'none',
      remarks: '',
      url: '',
    },
  ] satisfies ShoppingItem[],
  executeModeItemIds: ['limited-1', 'limited-2', 'next-visit'],
};

const clickLimitedDeferAt = (index: number) => {
  fireEvent.click(screen.getAllByRole('button', { name: '-/5' })[index]);
  fireEvent.click(screen.getByRole('button', { name: 'この商品を後で入力' }));
};

const clickNextVisitButton = () => {
  fireEvent.click(screen.getByTitle('次の訪問先'));
};

const clickPrevVisitButton = () => {
  fireEvent.click(screen.getByTitle('前の訪問先'));
};

const fillLimitedActualAndSaveAt = (index: number, actual: string) => {
  fireEvent.click(screen.getAllByRole('button', { name: '-/5' })[index]);
  const dialog = screen.getByRole('dialog', { name: '限数購入の数量' });
  const [actualInput] = within(dialog).getAllByRole('textbox');
  fireEvent.change(actualInput, { target: { value: actual } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
};

const expectCurrentVisitBlockedByLimited = async () => {
  clickNextVisitButton();
  expect(
    await screen.findByText('限数未入力があります。実購入数を入力してください'),
  ).toBeInTheDocument();
  expect(screen.getByText('A-01A')).toBeInTheDocument();
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

  it('全アイテムを後回しにしても自動遷移せず phase/phaseIndex が動かない', async () => {
    const onSessionStateChange = vi.fn();

    // Phase 1: real timers でクリック操作を行い、全アイテムを後回しにする
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

    expect(screen.queryByText(/秒後に次の訪問先へ移動します/)).toBeNull();

    // Phase 2: fake timers に切り替えても自動遷移しないことを検証
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

describe('FocusMode limited purchase defer - integration', () => {
  it('blocks moving forward when only part of the current visit is deferred', async () => {
    render(
      <StatefulFocusModeHarness
        initialItems={limitedItemsFixture.items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
      />,
    );

    clickLimitedDeferAt(0);
    clickNextVisitButton();

    expect(await screen.findByText('限数未入力があります。実購入数を入力してください')).toBeInTheDocument();
    expect(screen.getByText('A-01A')).toBeInTheDocument();
  });

  it('allows moving forward after every missing limited purchase item in the visit is deferred', async () => {
    render(
      <StatefulFocusModeHarness
        initialItems={limitedItemsFixture.items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);
    clickNextVisitButton();

    expect(await screen.findByText('A-02A')).toBeInTheDocument();
  });

  it('allows moving forward after every missing limited purchase item is deferred from bulk limited flow', async () => {
    const items = limitedItemsFixture.items.map((item) =>
      item.id.startsWith('limited-')
        ? { ...item, purchaseStatus: 'None' as const }
        : item,
    );

    render(
      <StatefulFocusModeHarness
        initialItems={items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '全限数' }));
    fireEvent.click(screen.getByRole('button', { name: 'この商品を後で入力' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この商品を後で入力' }));
    clickNextVisitButton();

    expect(await screen.findByText('A-02A')).toBeInTheDocument();
  });

  it('keeps the deferred exception when returning to the same visit during the same focus session', async () => {
    render(
      <StatefulFocusModeHarness
        initialItems={limitedItemsFixture.items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);
    clickNextVisitButton();
    expect(await screen.findByText('A-02A')).toBeInTheDocument();

    clickPrevVisitButton();
    expect(await screen.findByText('A-01A')).toBeInTheDocument();
    clickNextVisitButton();

    expect(await screen.findByText('A-02A')).toBeInTheDocument();
  });

  it('keeps price blocking active even when limited purchase checks are deferred', async () => {
    const items = [
      ...limitedItemsFixture.items.slice(0, 2),
      {
        ...limitedItemsFixture.items[0],
        id: 'price-missing',
        title: '価格未定',
        purchaseStatus: 'Purchased' as const,
        price: null,
      },
      limitedItemsFixture.items[2],
    ];

    render(
      <StatefulFocusModeHarness
        initialItems={items}
        executeModeItemIds={['limited-1', 'limited-2', 'price-missing', 'next-visit']}
        resumeState={incompleteSessionFixture}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);
    clickNextVisitButton();

    expect(await screen.findByText('価格未定のアイテムがあります。価格を入力してください。')).toBeInTheDocument();
    expect(screen.getByText('A-01A')).toBeInTheDocument();
  });

  it('preserves the existing global limited purchase check disable behavior', async () => {
    render(
      <StatefulFocusModeHarness
        initialItems={limitedItemsFixture.items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
        disableLimitedPurchaseQuantityCheck
      />,
    );

    clickNextVisitButton();

    expect(await screen.findByText('A-02A')).toBeInTheDocument();
  });

  it('resets deferred limited purchase state after remounting focus mode', async () => {
    const first = render(
      <StatefulFocusModeHarness
        initialItems={limitedItemsFixture.items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);
    clickNextVisitButton();
    expect(await screen.findByText('A-02A')).toBeInTheDocument();
    first.unmount();

    render(
      <StatefulFocusModeHarness
        initialItems={limitedItemsFixture.items}
        executeModeItemIds={limitedItemsFixture.executeModeItemIds}
        resumeState={incompleteSessionFixture}
      />,
    );
    clickNextVisitButton();

    expect(await screen.findByText('限数未入力があります。実購入数を入力してください')).toBeInTheDocument();
    expect(screen.getByText('A-01A')).toBeInTheDocument();
  });

  it('clears deferred state after a limited item receives an actual quantity and later becomes missing again through props', async () => {
    const { rerender } = render(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);

    const withActualQuantity = limitedItemsFixture.items.map((item) =>
      item.id === 'limited-1' ? { ...item, limitedPurchasedQuantity: 2 } : item,
    );
    rerender(
      <FocusMode
        {...minimalProps({
          items: withActualQuantity,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '2/5' })).toBeInTheDocument());

    rerender(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(2));

    await expectCurrentVisitBlockedByLimited();
  });

  it('clears deferred state after a limited item changes to another status and later becomes missing again through props', async () => {
    const { rerender } = render(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);

    const withPurchasedItem = limitedItemsFixture.items.map((item) =>
      item.id === 'limited-1' ? { ...item, purchaseStatus: 'Purchased' as const } : item,
    );
    rerender(
      <FocusMode
        {...minimalProps({
          items: withPurchasedItem,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(1));

    rerender(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(2));

    await expectCurrentVisitBlockedByLimited();
  });

  it('clears deferred state when a deferred item leaves and re-enters execute scope', async () => {
    const { rerender } = render(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);

    rerender(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: ['next-visit'],
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText('A-02A')).toBeInTheDocument());

    rerender(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText('A-01A')).toBeInTheDocument());

    await expectCurrentVisitBlockedByLimited();
  });

  it('clears deferred state when a deferred item visit key changes', async () => {
    const { rerender } = render(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);

    const movedItems = limitedItemsFixture.items.map((item) =>
      item.id.startsWith('limited-') ? { ...item, block: 'B' } : item,
    );
    rerender(
      <FocusMode
        {...minimalProps({
          items: movedItems,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText('B-01A')).toBeInTheDocument());

    clickNextVisitButton();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
    expect(screen.getByText('B-01A')).toBeInTheDocument();
  });

  it('clears deferred state when an empty visit removes blinking state and deferred items are re-added', async () => {
    const { rerender } = render(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);

    rerender(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: [],
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText('訪問先がありません')).toBeInTheDocument());

    rerender(
      <FocusMode
        {...minimalProps({
          items: limitedItemsFixture.items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText('A-01A')).toBeInTheDocument());

    await expectCurrentVisitBlockedByLimited();
  });

  it('clears deferred state when a deferred item is saved from the limited dialog and later becomes missing again', async () => {
    let items: ShoppingItem[] = limitedItemsFixture.items;
    let view: ReturnType<typeof render>;
    const onUpdateItem = vi.fn((updatedItem: ShoppingItem) => {
      items = items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
      view.rerender(
        <FocusMode
          {...minimalProps({
            items,
            executeModeItemIds: limitedItemsFixture.executeModeItemIds,
            onUpdateItem,
            resumeState: incompleteSessionFixture,
          })}
        />,
      );
    });

    view = render(
      <FocusMode
        {...minimalProps({
          items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          onUpdateItem,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);
    fillLimitedActualAndSaveAt(0, '2');
    await waitFor(() => expect(screen.getByRole('button', { name: '2/5' })).toBeInTheDocument());

    items = limitedItemsFixture.items;
    view.rerender(
      <FocusMode
        {...minimalProps({
          items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          onUpdateItem,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(2));

    await expectCurrentVisitBlockedByLimited();
  });

  it('clears deferred state when a deferred item is committed as purchased and later becomes missing again', async () => {
    let items: ShoppingItem[] = limitedItemsFixture.items;
    let view: ReturnType<typeof render>;
    const onUpdateItem = vi.fn((updatedItem: ShoppingItem) => {
      items = items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
      view.rerender(
        <FocusMode
          {...minimalProps({
            items,
            executeModeItemIds: limitedItemsFixture.executeModeItemIds,
            onUpdateItem,
            resumeState: incompleteSessionFixture,
          })}
        />,
      );
    });

    view = render(
      <FocusMode
        {...minimalProps({
          items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          onUpdateItem,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );

    clickLimitedDeferAt(0);
    clickLimitedDeferAt(1);
    fillLimitedActualAndSaveAt(0, '5');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '購入済として保存しますか？' })).getByRole(
        'button',
        { name: '購入済にする' },
      ),
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(1));

    items = limitedItemsFixture.items;
    view.rerender(
      <FocusMode
        {...minimalProps({
          items,
          executeModeItemIds: limitedItemsFixture.executeModeItemIds,
          onUpdateItem,
          resumeState: incompleteSessionFixture,
        })}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(2));

    await expectCurrentVisitBlockedByLimited();
  });

  it('clears deferred state when all-limited toggle clears missing limited items and they later become missing again', async () => {
    let items: ShoppingItem[] = limitedItemsFixture.items;
    let view: ReturnType<typeof render>;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onUpdateItem = vi.fn((updatedItem: ShoppingItem) => {
      items = items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
      view.rerender(
        <FocusMode
          {...minimalProps({
            items,
            executeModeItemIds: limitedItemsFixture.executeModeItemIds,
            onUpdateItem,
            resumeState: incompleteSessionFixture,
          })}
        />,
      );
    });

    try {
      view = render(
        <FocusMode
          {...minimalProps({
            items,
            executeModeItemIds: limitedItemsFixture.executeModeItemIds,
            onUpdateItem,
            resumeState: incompleteSessionFixture,
          })}
        />,
      );

      clickLimitedDeferAt(0);
      clickLimitedDeferAt(1);
      fireEvent.click(screen.getByRole('button', { name: '全限数' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: '-/5' })).toBeNull());

      items = limitedItemsFixture.items;
      view.rerender(
        <FocusMode
          {...minimalProps({
            items,
            executeModeItemIds: limitedItemsFixture.executeModeItemIds,
            onUpdateItem,
            resumeState: incompleteSessionFixture,
          })}
        />,
      );
      await waitFor(() => expect(screen.getAllByRole('button', { name: '-/5' })).toHaveLength(2));

      await expectCurrentVisitBlockedByLimited();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
