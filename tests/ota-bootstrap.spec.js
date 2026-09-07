import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
test('OTA bootstrap commissioning is explicit and rejects an invalid artifact without flashing',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:/Setup/}).click();await page.locator('summary').filter({hasText:'Upload Robot Software'}).click();
 await expect(page.getByText('OTA recovery loader — commissioning')).toBeVisible();
 const install=page.getByRole('button',{name:'Install OTA recovery loader via USB'});await expect(install).toBeDisabled();
 await page.getByLabel('Private OTA bootstrap file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"kind":"ordinary-program"}')});
 await expect(page.getByRole('alert').filter({hasText:/Invalid OTA/})).toBeVisible();await expect(install).toBeDisabled();
 const content='# harmless UI-only fixture\n';const good={kind:'mbot-ota-bootstrap-v1',device:'ui-fixture',sha256:createHash('sha256').update(content).digest('hex'),files:[{name:'main.py',content}]};
 await page.getByLabel('Private OTA bootstrap file').setInputFiles({name:'bootstrap.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(good))});
 await expect(page.getByText(/Device: ui-fixture/)).toBeVisible();await expect(install).toBeDisabled();
 await page.getByRole('checkbox',{name:/I have secured the robot/}).check();await expect(install).toBeEnabled();
 page.once('dialog',d=>d.dismiss());await install.click();await expect(install).toBeEnabled();
 await expect(page.getByText(/USB transfer acknowledged/)).toHaveCount(0);
});
