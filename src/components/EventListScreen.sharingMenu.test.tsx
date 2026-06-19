/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import EventListScreen from './EventListScreen';

const baseProps = {
  eventNames: ['テストイベント'],
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onExport: vi.fn(),
};

describe('EventListScreen sharing menu', () => {
  it('shows create and join actions for events without a sharing session', async () => {
    const user = userEvent.setup();
    const onCreateSharingRoom = vi.fn();
    const onJoinSharingRoom = vi.fn();

    render(
      <EventListScreen
        {...baseProps}
        onCreateSharingRoom={onCreateSharingRoom}
        onJoinSharingRoom={onJoinSharingRoom}
        isSharingActiveForEvent={() => false}
      />,
    );

    await user.click(screen.getByLabelText('メニュー'));
    await user.click(screen.getByRole('button', { name: /共有を開始/ }));
    expect(onCreateSharingRoom).toHaveBeenCalledWith('テストイベント');

    await user.click(screen.getByLabelText('メニュー'));
    await user.click(screen.getByRole('button', { name: /共有URL\/コードで参加/ }));
    expect(onJoinSharingRoom).toHaveBeenCalledTimes(1);
  });

  it('shows invite and status actions for events with a sharing session', async () => {
    const user = userEvent.setup();
    const onShowSharingInvite = vi.fn();
    const onShowSharingStatus = vi.fn();

    render(
      <EventListScreen
        {...baseProps}
        onCreateSharingRoom={vi.fn()}
        onShowSharingInvite={onShowSharingInvite}
        onShowSharingStatus={onShowSharingStatus}
        isSharingActiveForEvent={() => true}
      />,
    );

    await user.click(screen.getByLabelText('メニュー'));
    expect(screen.queryByRole('button', { name: /共有を開始/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /参加URL\/QRを表示/ }));
    expect(onShowSharingInvite).toHaveBeenCalledWith('テストイベント');

    await user.click(screen.getByLabelText('メニュー'));
    await user.click(screen.getByRole('button', { name: /共有状態/ }));
    expect(onShowSharingStatus).toHaveBeenCalledWith('テストイベント');
  });
});
