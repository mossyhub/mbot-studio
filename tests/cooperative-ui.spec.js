import {test,expect} from '@playwright/test';
test('cooperative application shows motion-disabled state instead of implying drive readiness',async({page})=>{
 await page.route('**/api/robot/status',r=>r.fulfill({json:{mqttConnected:true,robotOnline:true,robotState:'ready',application:'cooperative-v1',motion_enabled:false,armed:false,build:'robot-cooperative-v1',capabilities:['wait','stop']}}));
 await page.goto('/');await expect(page.locator('.status-bar')).toContainText('Motion disabled');await expect(page.locator('.status-bar')).toContainText('robot-cooperative-v1');
});
