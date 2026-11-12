import { expect, test } from '@playwright/test';

test('MES back office creates a BOM and releases a work order with it', async ({ page }) => {
  await page.goto('/mes/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@suite.test');
  await page.getByLabel('Password', { exact: true }).fill('SuiteDemo!2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/mes\/back/);

  const bom = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Create BOM version', exact: true }),
  });
  const product = bom.getByLabel('Product', { exact: true });
  await expect(product.locator('option').nth(1)).toBeAttached();
  await product.selectOption({ index: 1 });
  const productId = await product.inputValue();
  await bom.getByLabel('Version', { exact: true }).fill('987654');
  await bom.getByLabel('Material SKU').fill('TEST-BROWSER-MATERIAL');
  await bom.getByLabel('Material name').fill('Browser test material');
  await bom.getByLabel('Quantity per unit').fill('1');
  await bom.getByRole('button', { name: 'Add material' }).click();
  await bom.getByRole('button', { name: 'Create BOM version' }).click();
  await expect(bom.getByRole('status')).toHaveText('BOM version created');

  const planning = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Create work order', exact: true }),
  });
  await planning.getByLabel('Product', { exact: true }).selectOption(productId);
  await planning.getByLabel('BOM version').selectOption({ label: 'v987654' });
  await planning.getByLabel('Work center').selectOption({ index: 1 });
  await planning.getByLabel('Work order number').fill('BROWSER-PLANNING-1');
  await planning.getByLabel('Operation name').fill('Browser acceptance operation');
  await planning.getByLabel('Target quantity').fill('3');
  await planning.getByLabel('Standard minutes per unit').fill('2');
  await planning.getByRole('button', { name: 'Create work order' }).click();
  await expect(planning.getByRole('status')).toHaveText(
    'Work order released; stage its materials before starting.',
  );
  await page.getByLabel('Search data').fill('BROWSER-PLANNING-1');
  const workOrders = page.locator('section.dataset').filter({
    has: page.getByRole('heading', { name: /^Work orders/ }),
  });
  await expect(workOrders.getByRole('cell', { name: 'BROWSER-PLANNING-1', exact: true })).toBeVisible();

  await bom.getByLabel('Source BOM version').selectOption({label: 'v987654'});
  await bom.getByRole('button', {name: 'Load materials'}).click();
  await bom.getByLabel('Quantity for TEST-BROWSER-MATERIAL').fill('2');
  await bom.getByRole('button', {name: 'Create BOM version'}).click();
  await expect(bom.getByRole('status')).toHaveText('BOM version created');

  await page.reload();
  const response = await page.request.get('/api/stations/mes/data?view=back');
  expect(response.ok()).toBeTruthy();
  const {data}: {data: {
    bomVersions: {id: string; productId: string; version: number}[];
    bomItems: {bomVersionId: string; quantityPerUnit: number}[];
    workOrders: {orderNo: string; bomVersionId: string}[];
  }} = await response.json();
  const original = data.bomVersions.find(row => row.productId === productId && row.version === 987654);
  const revision = data.bomVersions.find(row => row.productId === productId && row.version === 987655);
  expect(original).toBeTruthy();
  expect(revision).toBeTruthy();
  expect(data.bomItems.find(row => row.bomVersionId === original?.id)?.quantityPerUnit).toBe(1);
  expect(data.bomItems.find(row => row.bomVersionId === revision?.id)?.quantityPerUnit).toBe(2);
  expect(data.workOrders.find(row => row.orderNo === 'BROWSER-PLANNING-1')?.bomVersionId).toBe(original?.id);
});
