import {test,expect} from '@playwright/test';
test('USB recovery builds explicit loader and requires secured consent',async({page})=>{
 await page.route('**/recovery-mlink.js',r=>r.fulfill({contentType:'text/javascript',body:`export async function listSerialPorts(){return {ok:true,ports:[{id:7,info:{comName:'COM7'}}]}};export async function uploadViaMlink(options){window.testUpload=options;return {ok:true}};`}));
 await page.goto('/usb-recovery.html');await expect(page.getByRole('heading',{name:'Install corrected OTA loader'})).toBeVisible();
 await page.getByLabel('WiFi name').fill('test-network');await page.getByLabel('WiFi password').fill('test$&pass');
 await page.getByRole('button',{name:'Find USB ports'}).click();await page.getByLabel('USB port').selectOption('COM7');
 const button=page.getByRole('button',{name:'Install corrected loader via USB',exact:true});await expect(button).toBeDisabled();
 await page.getByLabel('Robot is secured; replace its startup program').check();page.once('dialog',d=>d.accept());await button.click();
 await expect(page.locator('#status')).toContainText('Transfer acknowledged');
 const o=await page.evaluate(()=>window.testUpload);expect(o.serialPort).toBe('COM7');expect(o.slot).toBe(1);expect(o.files[0].name).toBe('main.py');expect(o.files[0].content).toContain('WIFI_PASSWORD = "test$&pass"');expect(o.files[0].content.trim().endsWith('main()')).toBe(true);expect(o.files[0].content).not.toContain('if __name__ ==');
});
