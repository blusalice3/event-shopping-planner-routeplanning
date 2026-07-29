import React, { useEffect, useMemo, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExecutionNavigatorEntries } from './domain/buildNavigatorEntries';
import {
  SpaceNavigatorProvider,
  useSpaceNavigator,
  type SpaceNavigatorActionRequest,
  type SpaceNavigatorRegistration,
} from './SpaceNavigatorContext';
import { SpaceNavigatorFooterButton } from './components/SpaceNavigatorFooterButton';
import { TemporaryNavigationBanner } from './components/TemporaryNavigationBanner';
import { useSpaceNavigatorSettings } from './hooks/useSpaceNavigatorSettings';
import type { NavigatorItem } from './types';

const makeItem = (id: string, block: string, number: string): NavigatorItem => ({
  id,
  circle: `サークル${id}`,
  block,
  number,
  purchaseStatus: 'Purchased',
  price: 500,
  quantity: 1,
});

const entries = buildExecutionNavigatorEntries([
  makeItem('1', 'A', '01a'),
  makeItem('2', 'B', '02a'),
  makeItem('3', 'C', '03a'),
]);

function RegistrationHarness({
  action,
  layoutMode = 'smartphone',
}: {
  action?: (request: SpaceNavigatorActionRequest) => ReturnType<SpaceNavigatorRegistration['onNavigate']>;
  layoutMode?: 'pc' | 'smartphone';
}) {
  const navigator = useSpaceNavigator();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [formalIndex, setFormalIndex] = useState(0);

  const registration = useMemo<SpaceNavigatorRegistration>(
    () => ({
      id: 'context-test',
      mode: 'execute',
      entries,
      currentIndex,
      formalIndex,
      layoutMode,
      onNavigate: async (request) => {
        const result = action ? await action(request) : { ok: true };
        if (result.ok) {
          setCurrentIndex(request.index);
          if (request.intent === 'set-current') setFormalIndex(request.index);
        }
        return result;
      },
      onRestore: async (point) => {
        setCurrentIndex(point.navigatorIndex);
      },
      onPromote: async (_entry, index) => {
        setFormalIndex(index);
        return { ok: true };
      },
    }),
    [action, currentIndex, formalIndex, layoutMode],
  );

  useEffect(() => navigator.register(registration), [navigator.register]);
  useEffect(() => navigator.updateRegistration(registration), [navigator, registration]);
  return null;
}

function ContextProbe() {
  const navigator = useSpaceNavigator();
  return (
    <div>
      <output data-testid="current-index">{navigator.registration?.currentIndex ?? -1}</output>
      <output data-testid="formal-index">{navigator.registration?.formalIndex ?? -1}</output>
      <output data-testid="temporary-mode">{navigator.temporaryMode ?? 'none'}</output>
      <output data-testid="history-depth">{navigator.history.length}</output>
      <button type="button" onClick={() => void navigator.navigate(1, 'temporary')}>
        一時B
      </button>
      <button type="button" onClick={() => void navigator.navigate(2, 'temporary')}>
        一時C
      </button>
      <button type="button" onClick={() => void navigator.navigate(2, 'inspect')}>
        確認C
      </button>
      <button type="button" onClick={() => void navigator.returnToPrevious()}>
        戻る
      </button>
      <button type="button" onClick={() => void navigator.promoteTemporary()}>
        現在地
      </button>
      <SpaceNavigatorFooterButton />
    </div>
  );
}

describe('SpaceNavigatorContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a session-only LIFO history for nested temporary navigation', async () => {
    render(
      <SpaceNavigatorProvider>
        <RegistrationHarness />
        <ContextProbe />
      </SpaceNavigatorProvider>,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '一時B' })));
    await waitFor(() => expect(screen.getByTestId('current-index')).toHaveTextContent('1'));
    expect(screen.getByTestId('history-depth')).toHaveTextContent('1');
    expect(screen.getByTestId('temporary-mode')).toHaveTextContent('temporary');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '一時C' })));
    await waitFor(() => expect(screen.getByTestId('current-index')).toHaveTextContent('2'));
    expect(screen.getByTestId('history-depth')).toHaveTextContent('2');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '戻る' })));
    await waitFor(() => expect(screen.getByTestId('current-index')).toHaveTextContent('1'));
    expect(screen.getByTestId('history-depth')).toHaveTextContent('1');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '戻る' })));
    await waitFor(() => expect(screen.getByTestId('current-index')).toHaveTextContent('0'));
    expect(screen.getByTestId('history-depth')).toHaveTextContent('0');
    expect(screen.getByTestId('temporary-mode')).toHaveTextContent('none');
  });

  it('promotes an inspect target and clears the return history', async () => {
    render(
      <SpaceNavigatorProvider>
        <RegistrationHarness />
        <ContextProbe />
      </SpaceNavigatorProvider>,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '確認C' })));
    await waitFor(() => expect(screen.getByTestId('current-index')).toHaveTextContent('2'));
    expect(screen.getByTestId('temporary-mode')).toHaveTextContent('inspect');
    expect(screen.getByTestId('history-depth')).toHaveTextContent('1');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '現在地' })));
    await waitFor(() => expect(screen.getByTestId('temporary-mode')).toHaveTextContent('none'));
    expect(screen.getByTestId('history-depth')).toHaveTextContent('0');
  });

  it('switches an inspect target to temporary mode without navigating again or changing position', async () => {
    const action = vi.fn(async () => ({ ok: true }));

    render(
      <SpaceNavigatorProvider>
        <RegistrationHarness action={action} />
        <ContextProbe />
        <TemporaryNavigationBanner />
      </SpaceNavigatorProvider>,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '確認C' })));
    await waitFor(() => expect(screen.getByTestId('temporary-mode')).toHaveTextContent('inspect'));
    expect(screen.getByRole('button', { name: '一時移動する' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '一時移動する' }));

    await waitFor(() => expect(screen.getByTestId('temporary-mode')).toHaveTextContent('temporary'));
    expect(screen.getByTestId('current-index')).toHaveTextContent('2');
    expect(screen.getByTestId('formal-index')).toHaveTextContent('0');
    expect(screen.getByTestId('history-depth')).toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: '一時移動する' })).not.toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ index: 2, intent: 'inspect' }));
  });

  it('does not create history until a warning has been confirmed', async () => {
    const action = vi.fn(async (request: SpaceNavigatorActionRequest) =>
      request.confirmed
        ? { ok: true }
        : { ok: false, requiresConfirmation: true, message: '未購入があります' },
    );

    function ConfirmationProbe() {
      const navigator = useSpaceNavigator();
      const [message, setMessage] = useState('');
      return (
        <>
          <output data-testid="confirmation-history">{navigator.history.length}</output>
          <output data-testid="confirmation-message">{message}</output>
          <button
            type="button"
            onClick={async () => {
              const result = await navigator.navigate(1, 'temporary');
              setMessage(result.message ?? '');
            }}
          >
            未確認移動
          </button>
          <button type="button" onClick={() => void navigator.navigate(1, 'temporary', true)}>
            確認済み移動
          </button>
        </>
      );
    }

    render(
      <SpaceNavigatorProvider>
        <RegistrationHarness action={action} />
        <ConfirmationProbe />
      </SpaceNavigatorProvider>,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '未確認移動' })));
    expect(screen.getByTestId('confirmation-history')).toHaveTextContent('0');
    expect(screen.getByTestId('confirmation-message')).toHaveTextContent('未購入があります');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '確認済み移動' })));
    await waitFor(() => expect(screen.getByTestId('confirmation-history')).toHaveTextContent('1'));
  });

  it('uses the compact smartphone footer label', () => {
    render(
      <SpaceNavigatorProvider>
        <RegistrationHarness layoutMode="smartphone" />
        <ContextProbe />
      </SpaceNavigatorProvider>,
    );
    expect(screen.getByRole('button', { name: 'スペース一覧を開く' })).toHaveTextContent('ナビ');
  });
});

describe('useSpaceNavigatorSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('merges saved partial values with defaults and persists updates', async () => {
    localStorage.setItem('spaceNavigatorSettings', JSON.stringify({ railVisible: false }));

    function SettingsProbe() {
      const { settings, updateSettings } = useSpaceNavigatorSettings();
      return (
        <>
          <output data-testid="settings">
            {String(settings.railVisible)}:{String(settings.footerButtonVisible)}:{settings.side}
          </output>
          <button type="button" onClick={() => updateSettings({ side: 'right' })}>
            右へ
          </button>
        </>
      );
    }

    render(<SettingsProbe />);
    expect(screen.getByTestId('settings')).toHaveTextContent('false:true:left');

    fireEvent.click(screen.getByRole('button', { name: '右へ' }));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('spaceNavigatorSettings') ?? '{}')).toMatchObject({
        railVisible: false,
        footerButtonVisible: true,
        side: 'right',
      });
    });
  });
});

