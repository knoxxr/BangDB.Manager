// Smoke test (Playwright, phone viewport). Run first:
//   node scripts/mock-bangdb.mjs
//   BANGDB_URL=http://127.0.0.1:18080 npm run proxy
// then: node e2e/smoke.mjs ./shots   (requires `npm i -D playwright` and a chromium install)
import { chromium, devices } from 'playwright';
const shots = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const url = 'http://127.0.0.1:8080/#/connections';
await page.goto(url);
await page.getByRole('button', { name: 'Add', exact: true }).click();
await page.locator('.modal select').first().selectOption('rest'); // BangDB 2.0 REST (the mock server)
await page.getByPlaceholder('e.g. Office BangDB').fill('Test server');
await page.getByPlaceholder('http://192.168.0.10:18080').fill('http://127.0.0.1:18080');
await page.locator('label.check').filter({ hasText: 'Via proxy' }).click();
await page.getByRole('button', { name: 'Test connection' }).click();
await page.getByText(/Connected:/).waitFor({ timeout: 5000 });
console.log('test:', await page.getByText(/Connected:/).textContent());
await page.screenshot({ path: `${shots}/01-connection.png` });
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.locator('.conn .name', { hasText: 'Test server' }).click();
await page.getByRole('button', { name: 'Refresh' }).click();
await page.getByText(/2 table\(s\)/).waitFor();
await page.screenshot({ path: `${shots}/02-databases.png` });
await page.getByRole('button', { name: 'Server stats' }).click();
await page.getByText(/uptime_sec/).waitFor();
await page.keyboard.press('Escape');
await page.locator('.item .title', { hasText: 'mydb' }).click();
await page.getByText('orders').waitFor();
await page.getByRole('button', { name: '+ Table' }).click();
await page.locator('.modal input.mono').first().fill('users');
await page.locator('.modal').getByRole('button', { name: 'Create', exact: true }).click();
await page.locator('.item .title', { hasText: 'users' }).waitFor();
await page.screenshot({ path: `${shots}/03-tables.png` });
await page.locator('.item .title', { hasText: 'users' }).click();
await page.getByRole('button', { name: 'Insert document' }).click();
await page.locator('textarea').fill('{"_pk":"u1","name":"김철수","age":31}');
await page.getByRole('button', { name: /Save \(POST doc\)/ }).click();
await page.locator('.toast', { hasText: 'Saved' }).first().waitFor();
await page.locator('.tabs').getByRole('button', { name: 'Browse', exact: true }).click();
await page.getByRole('cell', { name: '김철수' }).waitFor();
await page.screenshot({ path: `${shots}/04-table-browse.png` });
// edit a row in place
await page.getByRole('cell', { name: '김철수' }).click();
await page.locator('.modal textarea').fill('{"_pk":"u1","name":"김철수","age":32}');
await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
await page.getByRole('cell', { name: '32' }).waitFor();
await page.screenshot({ path: `${shots}/04b-row-edited.png` });
// bulk import (JSON lines)
await page.getByRole('button', { name: 'Import', exact: true }).first().click();
await page.locator('textarea').fill('{"_pk":"u2","name":"이영희","age":28}\n{"_pk":"u3","name":"박민수","age":45}');
await page.locator('button.btn.primary', { hasText: 'Import' }).click();
await page.locator('.toast', { hasText: '2 imported' }).first().waitFor();
await page.locator('.topbar .badge', { hasText: '3 rows' }).waitFor();
await page.screenshot({ path: `${shots}/04c-import.png` });
// export CSV
await page.locator('.tabs').getByRole('button', { name: 'Browse', exact: true }).click();
await page.getByRole('cell', { name: '이영희' }).waitFor();
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save CSV' }).click()]);
console.log('download:', dl.suggestedFilename());
await page.getByRole('button', { name: 'Lookup / delete by key' }).click();
await page.locator('input.mono').first().fill('u1');
await page.getByRole('button', { name: 'Lookup (GET)' }).click();
await page.getByText(/HTTP 200/).first().waitFor();
await page.locator('.tabbar').getByText('SQL').click();
await page.locator('textarea').fill('select * from orders limit 5');
await page.getByRole('button', { name: /^Run/ }).click();
await page.getByRole('cell', { name: '10' }).waitFor();
await page.screenshot({ path: `${shots}/05-sql.png` });
await page.locator('.tabbar').getByText('REST').click();
await page.getByRole('button', { name: 'Send' }).click();
await page.getByText(/num_tables/).first().waitFor();
await page.screenshot({ path: `${shots}/06-console.png` });
// desktop layout check
const d = await browser.newPage({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState() });
await d.goto('http://127.0.0.1:8080/#/connections');
await d.locator('.conn .name', { hasText: 'Test server' }).click();
await d.locator('.item .title', { hasText: 'mydb' }).click();
await d.locator('.item .title', { hasText: 'users' }).waitFor();
await d.screenshot({ path: `${shots}/07-desktop.png` });
// manifest + service worker
const m = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
console.log('manifest:', m.name, m.display, 'sw:', await page.evaluate(() => navigator.serviceWorker?.getRegistrations().then((r) => r.length)));
console.log('page errors:', errors);
await browser.close();
