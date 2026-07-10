import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FocusMode from './FocusMode';
import { minimalProps, singleVisitNoneItemFixture } from './FocusMode.fixtures';

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
});
