import { expect } from '@playwright/test';

// Real-App navigation only. Isolated BlocklyEditor fixtures retain guided=false.
export async function openLearning(page, section = 'Challenges') {
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Learn', exact: true }).click();
  await page.getByRole('navigation', { name: 'Learning content' }).getByRole('button', { name: new RegExp(`^${section}(?: |$)`) }).click();
}

export async function openSetup(page) {
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Robot', exact: true }).click();
  await page.getByRole('navigation', { name: 'Robot tools' }).getByRole('button', { name: 'Setup', exact: true }).click();
}

export async function closeHelper(page) {
  const helper = page.getByRole('complementary', { name: 'AI helper', exact: true });
  if (await helper.isVisible()) await helper.getByRole('button', { name: 'Close helper', exact: true }).click();
  await expect(helper).toBeHidden();
}

export async function openHelper(page) {
  const helper = page.getByRole('complementary', { name: 'AI helper', exact: true });
  if (!await helper.isVisible()) await page.getByRole('button', { name: 'AI helper', exact: true }).click();
  await expect(helper).toBeVisible();
}

export async function openBlocks(page) {
  const drawer = page.getByRole('region', { name: 'Add Blocks', exact: true });
  if (!await drawer.isVisible()) await page.getByRole('button', { name: 'Add Blocks', exact: true }).click();
  await expect(drawer).toBeVisible();
}
