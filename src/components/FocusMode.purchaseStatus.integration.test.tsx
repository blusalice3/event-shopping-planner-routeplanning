import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FocusMode from './FocusMode';
import {
  minimalProps,
  singleVisitNoneItemFixture,
  StatefulFocusModeHarness,
} from './FocusMode.fixtures';

describe('FocusMode purchase status control mode', () => {
  it('passes radial purchase status control mode to focus item cards', async () => {
    render(
      <FocusMode
        {...minimalProps({ ...singleVisitNoneItemFixture })}
        purchaseStatusControlMode="radial"
      />,
    );

    expect(await screen.findByRole('button', { name: /Current status/i })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });

  it('records post-event distribution check answer when a focus item becomes sold out', async () => {
    render(
      <StatefulFocusModeHarness
        initialItems={[singleVisitNoneItemFixture.items[0]]}
        executeModeItemIds={singleVisitNoneItemFixture.executeModeItemIds}
        resumeState={null}
      />,
    );

    const statusButton = await screen.findByRole('button', { name: /Current status/i });
    fireEvent.click(statusButton);
    fireEvent.click(await screen.findByRole('button', { name: /Current status/i }));

    expect(
      await screen.findByRole('dialog', { name: '事後通販･頒布可否確認' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '記録' }));

    expect(screen.getByDisplayValue('通販･頒布確認: 未確認')).toBeInTheDocument();
  });
});
