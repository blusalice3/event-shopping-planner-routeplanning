import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ShoppingList from './ShoppingList';
import type { ShoppingItem } from '../types/item';

const baseItem: ShoppingItem = {
  id: 'item-1',
  circle: 'Circle',
  eventDate: 'Day1',
  block: 'A',
  number: '01',
  title: 'Title',
  price: 1000,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
};

const limitedMissingItem = (overrides: Partial<ShoppingItem>): ShoppingItem => ({
  ...baseItem,
  id: 'limited-item',
  circle: 'Limited Circle',
  block: 'A',
  number: '01',
  purchaseStatus: 'LimitedPurchase',
  quantity: 2,
  priorityLevel: 'none',
  ...overrides,
});

const StateFulShoppingListHarness = ({
  initialItems,
  onCollapseAndOpenNext = vi.fn(),
  columnType = 'execute',
  viewMode = 'execute',
  showPostponeFilterButton,
  onActivatePostponeFilter,
  showLateFilterButton,
  onActivateLateFilter,
  disablePriceUndefinedCheck,
}: {
  initialItems: ShoppingItem[];
  onCollapseAndOpenNext?: (groupKey: string) => void;
  columnType?: 'execute' | 'candidate';
  viewMode?: 'edit' | 'execute';
  showPostponeFilterButton?: boolean;
  onActivatePostponeFilter?: () => void;
  showLateFilterButton?: boolean;
  onActivateLateFilter?: () => void;
  disablePriceUndefinedCheck?: boolean;
}) => {
  const [items, setItems] = useState(initialItems);

  return (
    <ShoppingList
      items={items}
      onUpdateItem={(updatedItem) =>
        setItems((current) =>
          current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
        )
      }
      onMoveItem={vi.fn()}
      onEditRequest={vi.fn()}
      onDeleteRequest={vi.fn()}
      selectedItemIds={new Set()}
      onSelectItem={vi.fn()}
      layoutMode="pc"
      viewMode={viewMode}
      columnType={columnType}
      skipLimitedPurchaseForSingleQuantity
      showSpaceGroups
      onCollapseAndOpenNext={onCollapseAndOpenNext}
      onBulkStatusChange={vi.fn()}
      showPostponeFilterButton={showPostponeFilterButton}
      onActivatePostponeFilter={onActivatePostponeFilter}
      showLateFilterButton={showLateFilterButton}
      onActivateLateFilter={onActivateLateFilter}
      disablePriceUndefinedCheck={disablePriceUndefinedCheck}
    />
  );
};

const clickLimitedDeferForTitle = (title: string) => {
  const card = screen.getByText(title).closest('[data-item-id]');
  if (!card) throw new Error(`card not found: ${title}`);
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '-/2' }));
  fireEvent.click(screen.getByRole('button', { name: 'この商品を後で入力' }));
};

describe('ShoppingList purchase status control mode', () => {
  it('passes radial purchase status control mode to item cards', () => {
    render(
      <ShoppingList
        items={[baseItem]}
        onUpdateItem={vi.fn()}
        onMoveItem={vi.fn()}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        selectedItemIds={new Set()}
        onSelectItem={vi.fn()}
        layoutMode="pc"
        viewMode="execute"
        skipLimitedPurchaseForSingleQuantity
        purchaseStatusControlMode="radial"
      />,
    );

    expect(screen.getByRole('button', { name: /Current status/i })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });

  it('does not toggle already matching non-limited items when limited items are excluded from a bulk change', () => {
    const onBulkStatusChange = vi.fn();
    const limitedItem: ShoppingItem = {
      ...baseItem,
      id: 'limited-item',
      circle: 'Limited Circle',
      purchaseStatus: 'LimitedPurchase',
      quantity: 5,
      limitedPurchasedQuantity: 2,
    };
    const soldOutItem: ShoppingItem = {
      ...baseItem,
      id: 'sold-out-item',
      circle: 'Sold Out Circle',
      purchaseStatus: 'SoldOut',
    };

    render(
      <ShoppingList
        items={[limitedItem, soldOutItem]}
        onUpdateItem={vi.fn()}
        onMoveItem={vi.fn()}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        selectedItemIds={new Set()}
        onSelectItem={vi.fn()}
        layoutMode="pc"
        viewMode="execute"
        skipLimitedPurchaseForSingleQuantity
        showSpaceGroups
        onBulkStatusChange={onBulkStatusChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '全売切' }));

    expect(onBulkStatusChange).not.toHaveBeenCalled();
    expect(screen.getByText('変更対象のアイテムはありません')).toBeInTheDocument();
  });

  it('blocks moving to the next space when only some missing limited quantities are deferred', async () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          limitedMissingItem({ id: 'limited-1', title: '限数1' }),
          limitedMissingItem({ id: 'limited-2', title: '限数2' }),
          limitedMissingItem({
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            limitedPurchasedQuantity: 1,
          }),
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
      />,
    );

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('allows moving to the next space when all missing limited quantities in the group are deferred from item cards', async () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          limitedMissingItem({ id: 'limited-1', title: '限数1' }),
          limitedMissingItem({ id: 'limited-2', title: '限数2' }),
          limitedMissingItem({
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            limitedPurchasedQuantity: 1,
          }),
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
      />,
    );

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    clickLimitedDeferForTitle('限数2');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).toHaveBeenCalledWith('A-01');
  });

  it('keeps undefined price highlighted while allowing next-space transition when price check is disabled', () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          {
            ...baseItem,
            id: 'undefined-price',
            title: '価格未定',
            price: null,
            purchaseStatus: 'Purchased',
          },
          {
            ...baseItem,
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            purchaseStatus: 'Purchased',
          },
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
        disablePriceUndefinedCheck
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).toHaveBeenCalledWith('A-01');
    expect(screen.queryByText('価格未定のアイテムがあります。価格を入力してください。')).not.toBeInTheDocument();

    const card = screen.getByLabelText('Select item Circle - 価格未定').closest('[data-item-id]');
    if (!card) throw new Error('undefined price card not found');
    expect(within(card as HTMLElement).getByDisplayValue('価格未定')).toHaveClass(
      'ring-red-500',
      'animate-pulse',
    );
  });

  it('does not share deferred limited quantities across priority groups in the same space', async () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          limitedMissingItem({ id: 'normal', title: '通常グループ', priorityLevel: 'none' }),
          limitedMissingItem({ id: 'priority', title: '優先グループ', priorityLevel: 'priority' }),
          limitedMissingItem({
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            limitedPurchasedQuantity: 1,
          }),
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
      />,
    );

    clickLimitedDeferForTitle('通常グループ');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'スペースを閉じて次のスペースを展開' })[0]);

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('allows moving to the next space after all bulk limited inputs are deferred', async () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          { ...baseItem, id: 'target-1', title: '対象1', quantity: 2 },
          { ...baseItem, id: 'target-2', title: '対象2', quantity: 2 },
          limitedMissingItem({
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            limitedPurchasedQuantity: 1,
          }),
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '全限数' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'この商品を後で入力' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この商品を後で入力' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).toHaveBeenCalledWith('A-01');
  });

  it('still blocks on undefined price when missing limited quantities are deferred', async () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          limitedMissingItem({ id: 'limited-1', title: '限数1', price: null }),
          limitedMissingItem({
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            limitedPurchasedQuantity: 1,
          }),
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
      />,
    );

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('価格未定のアイテムがあります。価格を入力してください。'),
    ).toBeInTheDocument();
  });

  it('allows postpone and late filters only when every missing limited quantity in the final group is deferred', async () => {
    const onActivatePostponeFilter = vi.fn();
    const onActivateLateFilter = vi.fn();
    const { rerender } = render(
      <StateFulShoppingListHarness
        key="late"
        initialItems={[
          limitedMissingItem({ id: 'limited-1', title: '限数1' }),
          limitedMissingItem({ id: 'limited-2', title: '限数2' }),
        ]}
        onCollapseAndOpenNext={vi.fn()}
        showPostponeFilterButton
        onActivatePostponeFilter={onActivatePostponeFilter}
      />,
    );

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '後回しでフィルタ' }));
    expect(onActivatePostponeFilter).not.toHaveBeenCalled();

    clickLimitedDeferForTitle('限数2');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '後回しでフィルタ' }));
    expect(onActivatePostponeFilter).toHaveBeenCalledTimes(1);

    rerender(
      <StateFulShoppingListHarness
        initialItems={[
          limitedMissingItem({ id: 'late-1', title: '遅参1' }),
          limitedMissingItem({ id: 'late-2', title: '遅参2' }),
        ]}
        onCollapseAndOpenNext={vi.fn()}
        showLateFilterButton
        onActivateLateFilter={onActivateLateFilter}
      />,
    );
    clickLimitedDeferForTitle('遅参1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '遅参でフィルタ' }));
    expect(onActivateLateFilter).not.toHaveBeenCalled();

    clickLimitedDeferForTitle('遅参2');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '遅参でフィルタ' }));
    expect(onActivateLateFilter).toHaveBeenCalledTimes(1);
  });

  it('cleans deferred limited quantities after parent props make the item no longer missing', async () => {
    const onCollapseAndOpenNext = vi.fn();
    const CleanupHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1' }),
        limitedMissingItem({
          id: 'next-space',
          title: '次スペース',
          block: 'A',
          number: '02',
          limitedPurchasedQuantity: 1,
        }),
      ]);

      return (
        <>
          <button
            type="button"
            onClick={() =>
              setItems((current) =>
                current.map((item) =>
                  item.id === 'limited-1' ? { ...item, limitedPurchasedQuantity: 1 } : item,
                ),
              )
            }
          >
            入力済みにする
          </button>
          <button
            type="button"
            onClick={() =>
              setItems((current) =>
                current.map((item) => {
                  if (item.id !== 'limited-1') return item;
                  const updated = { ...item };
                  delete updated.limitedPurchasedQuantity;
                  return updated;
                }),
              )
            }
          >
            未入力に戻す
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode="execute"
            columnType="execute"
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups
            onBulkStatusChange={vi.fn()}
            onCollapseAndOpenNext={onCollapseAndOpenNext}
          />
        </>
      );
    };

    render(<CleanupHarness />);

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '入力済みにする' }));
    await waitFor(() => {
      const card = screen.getByText('限数1').closest('[data-item-id]');
      expect(within(card as HTMLElement).getByRole('button', { name: '1/2' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '未入力に戻す' }));
    await waitFor(() => {
      const card = screen.getByText('限数1').closest('[data-item-id]');
      expect(within(card as HTMLElement).getByRole('button', { name: '-/2' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('does not use defer selected outside execute column space groups to unblock execute transitions', async () => {
    const onCollapseAndOpenNext = vi.fn();
    const ModeSwitchHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1' }),
        limitedMissingItem({
          id: 'next-space',
          title: '次スペース',
          block: 'A',
          number: '02',
          limitedPurchasedQuantity: 1,
        }),
      ]);
      const [mode, setMode] = useState<'edit' | 'execute'>('edit');

      return (
        <>
          <button type="button" onClick={() => setMode('execute')}>
            実行モードへ
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode={mode}
            columnType="execute"
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups
            onBulkStatusChange={vi.fn()}
            onCollapseAndOpenNext={onCollapseAndOpenNext}
          />
        </>
      );
    };

    render(<ModeSwitchHarness />);

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '実行モードへ' }));
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('blocks with both price and limited messages when price is missing and only some limited quantities are deferred', async () => {
    const onCollapseAndOpenNext = vi.fn();
    render(
      <StateFulShoppingListHarness
        initialItems={[
          limitedMissingItem({ id: 'limited-1', title: '限数1' }),
          limitedMissingItem({ id: 'limited-2', title: '限数2' }),
          {
            ...baseItem,
            id: 'price-missing',
            title: '価格未定',
            purchaseStatus: 'Purchased',
            price: null,
            quantity: 2,
          },
          limitedMissingItem({
            id: 'next-space',
            title: '次スペース',
            block: 'A',
            number: '02',
            limitedPurchasedQuantity: 1,
          }),
        ]}
        onCollapseAndOpenNext={onCollapseAndOpenNext}
      />,
    );

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('価格と限数の実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('cleans deferred limited quantities after item card update fills and later removes actual quantity', async () => {
    const onCollapseAndOpenNext = vi.fn();
    const CleanupHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1' }),
        limitedMissingItem({
          id: 'next-space',
          title: '次スペース',
          block: 'A',
          number: '02',
          limitedPurchasedQuantity: 1,
        }),
      ]);

      return (
        <>
          <button
            type="button"
            onClick={() =>
              setItems((current) =>
                current.map((item) => {
                  if (item.id !== 'limited-1') return item;
                  const updated = { ...item };
                  delete updated.limitedPurchasedQuantity;
                  return updated;
                }),
              )
            }
          >
            未入力に戻す
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode="execute"
            columnType="execute"
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups
            onBulkStatusChange={vi.fn()}
            onCollapseAndOpenNext={onCollapseAndOpenNext}
          />
        </>
      );
    };

    render(<CleanupHarness />);

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const card = screen.getByText('限数1').closest('[data-item-id]');
    if (!card) throw new Error('card not found: 限数1');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '-/2' }));
    fireEvent.change(screen.getByLabelText('実購入数'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(within(card as HTMLElement).getByRole('button', { name: '1/2' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '未入力に戻す' }));
    await waitFor(() => {
      expect(within(card as HTMLElement).getByRole('button', { name: '-/2' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('cleans deferred limited quantities after all-already-limited bulk reset and later missing state returns', async () => {
    const onActivatePostponeFilter = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const BulkResetHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1' }),
        limitedMissingItem({ id: 'limited-2', title: '限数2' }),
      ]);

      return (
        <>
          <button
            type="button"
            onClick={() =>
              setItems((current) =>
                current.map((item) =>
                  item.id === 'limited-1' || item.id === 'limited-2'
                    ? { ...item, purchaseStatus: 'LimitedPurchase' as const }
                    : item,
                ),
              )
            }
          >
            全限数に戻す
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode="execute"
            columnType="execute"
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups
            onBulkStatusChange={vi.fn()}
            showPostponeFilterButton
            onActivatePostponeFilter={onActivatePostponeFilter}
          />
        </>
      );
    };

    try {
      render(<BulkResetHarness />);

      clickLimitedDeferForTitle('限数1');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      clickLimitedDeferForTitle('限数2');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      fireEvent.click(screen.getAllByRole('button', { name: '全限数' })[0]);
      await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: '全限数に戻す' }));
      await waitFor(() => {
        const card = screen.getByText('限数1').closest('[data-item-id]');
        expect(within(card as HTMLElement).getByRole('button', { name: '-/2' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: '後回しでフィルタ' }));

      expect(onActivatePostponeFilter).not.toHaveBeenCalled();
      expect(
        await screen.findByText('限数未入力があります。実購入数を入力してください'),
      ).toBeInTheDocument();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('does not use defer selected in candidate column space groups to unblock execute transitions', async () => {
    const onCollapseAndOpenNext = vi.fn();
    const ColumnSwitchHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1' }),
        limitedMissingItem({
          id: 'next-space',
          title: '次スペース',
          block: 'A',
          number: '02',
          limitedPurchasedQuantity: 1,
        }),
      ]);
      const [column, setColumn] = useState<'execute' | 'candidate'>('candidate');

      return (
        <>
          <button type="button" onClick={() => setColumn('execute')}>
            実行列へ
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode="execute"
            columnType={column}
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups
            onBulkStatusChange={vi.fn()}
            onCollapseAndOpenNext={onCollapseAndOpenNext}
          />
        </>
      );
    };

    render(<ColumnSwitchHarness />);

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '実行列へ' }));
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });

  it('keeps deferred limited quantities across showSpaceGroups and viewMode toggles', async () => {
    const onCollapseAndOpenNext = vi.fn();
    const DisplaySwitchHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1' }),
        limitedMissingItem({
          id: 'next-space',
          title: '次スペース',
          block: 'A',
          number: '02',
          limitedPurchasedQuantity: 1,
        }),
      ]);
      const [showGroups, setShowGroups] = useState(true);
      const [mode, setMode] = useState<'edit' | 'execute'>('execute');

      return (
        <>
          <button type="button" onClick={() => setShowGroups((current) => !current)}>
            スペース表示切替
          </button>
          <button
            type="button"
            onClick={() => setMode((current) => (current === 'execute' ? 'edit' : 'execute'))}
          >
            モード切替
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode={mode}
            columnType="execute"
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups={showGroups}
            onBulkStatusChange={vi.fn()}
            onCollapseAndOpenNext={onCollapseAndOpenNext}
          />
        </>
      );
    };

    render(<DisplaySwitchHarness />);

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'スペース表示切替' }));
    fireEvent.click(screen.getByRole('button', { name: 'スペース表示切替' }));
    fireEvent.click(screen.getByRole('button', { name: 'モード切替' }));
    fireEvent.click(screen.getByRole('button', { name: 'モード切替' }));
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).toHaveBeenCalledWith('A-01');
  });

  it('cleans deferred limited quantities when columnType changes the group key', async () => {
    const onCollapseAndOpenNext = vi.fn();
    const ColumnCleanupHarness = () => {
      const [items, setItems] = useState([
        limitedMissingItem({ id: 'limited-1', title: '限数1', priorityLevel: 'priority' }),
        limitedMissingItem({
          id: 'next-space',
          title: '次スペース',
          block: 'A',
          number: '02',
          priorityLevel: 'priority',
          limitedPurchasedQuantity: 1,
        }),
      ]);
      const [column, setColumn] = useState<'execute' | 'candidate'>('execute');

      return (
        <>
          <button type="button" onClick={() => setColumn('candidate')}>
            候補列へ
          </button>
          <button type="button" onClick={() => setColumn('execute')}>
            実行列へ
          </button>
          <ShoppingList
            items={items}
            onUpdateItem={(updatedItem) =>
              setItems((current) =>
                current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
              )
            }
            onMoveItem={vi.fn()}
            onEditRequest={vi.fn()}
            onDeleteRequest={vi.fn()}
            selectedItemIds={new Set()}
            onSelectItem={vi.fn()}
            layoutMode="pc"
            viewMode="execute"
            columnType={column}
            skipLimitedPurchaseForSingleQuantity
            showSpaceGroups
            onBulkStatusChange={vi.fn()}
            onCollapseAndOpenNext={onCollapseAndOpenNext}
          />
        </>
      );
    };

    render(<ColumnCleanupHarness />);

    clickLimitedDeferForTitle('限数1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '候補列へ' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '実行列へ' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '実行列へ' }));
    fireEvent.click(screen.getByRole('button', { name: 'スペースを閉じて次のスペースを展開' }));

    expect(onCollapseAndOpenNext).not.toHaveBeenCalled();
    expect(
      await screen.findByText('限数未入力があります。実購入数を入力してください'),
    ).toBeInTheDocument();
  });
});
