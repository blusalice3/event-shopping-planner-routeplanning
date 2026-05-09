// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FocusMode from './FocusMode';
import { completedFixture, minimalProps, singleVisitNoneItemFixture } from './FocusMode.fixtures';

describe('FocusMode TICKET-05 resume completion semantics', () => {
  it('does not render the completion screen until the pointer resume choice is selected', async () => {
    render(
      <FocusMode
        {...minimalProps({ resumeState: completedFixture, ...singleVisitNoneItemFixture })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('蜈ｨ縺ｦ縺ｮ險ｪ蝠丞・繧堤｢ｺ隱阪＠縺ｾ縺励◆')).toBeNull();
    });
  });
});
