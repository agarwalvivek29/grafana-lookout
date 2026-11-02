import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

test.describe('navigating app', () => {
  test('chat page should render', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Chat}`);
    await expect(page.getByTestId(testIds.chatPage.container)).toBeVisible();
    await expect(page.getByText('Ask about your data')).toBeVisible();
  });
});
