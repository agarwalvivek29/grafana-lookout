import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

test('setup page shows the model, data source and preview sections', async ({ appConfigPage, page }) => {
  await expect(page.getByTestId(testIds.appConfig.container)).toBeVisible();
  await expect(page.getByText('1. AI model')).toBeVisible();
  await expect(page.getByText('2. Data sources')).toBeVisible();
  await expect(page.getByText('3. Panel previews (optional)')).toBeVisible();
});
