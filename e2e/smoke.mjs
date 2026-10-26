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
await page.getByRole('button', { name: '+ 추가' }).click();
await page.getByPlaceholder('예: 사내 BangDB').fill('테스트 서버');
await page.getByPlaceholder('http://192.168.0.10:18080').fill('http://127.0.0.1:18080');
await page.locator('label.check').filter({ hasText: '프록시 경유' }).click();
await page.getByRole('button', { name: '연결 테스트' }).click();
await page.getByText(/연결 성공/).waitFor({ timeout: 5000 });
console.log('test:', await page.getByText(/연결 성공/).textContent());
await page.screenshot({ path: `${shots}/01-connection.png` });
await page.getByRole('button', { name: '저장' }).click();
await page.locator('.item .title', { hasText: '테스트 서버' }).click();
await page.getByRole('button', { name: '새로고침' }).click();
await page.getByText(/테이블 2개/).waitFor();
await page.screenshot({ path: `${shots}/02-databases.png` });
await page.locator('.item .title', { hasText: 'mydb' }).click();
await page.getByText('orders').waitFor();
await page.getByRole('button', { name: '+ 테이블' }).click();
await page.locator('.modal input.mono').first().fill('users');
await page.locator('.modal').getByRole('button', { name: '생성', exact: true }).click();
await page.locator('.item .title', { hasText: 'users' }).waitFor();
await page.screenshot({ path: `${shots}/03-tables.png` });
await page.locator('.item .title', { hasText: 'users' }).click();
await page.getByRole('button', { name: '문서 입력' }).click();
await page.locator('textarea').fill('{"_pk":"u1","name":"김철수","age":31}');
await page.getByRole('button', { name: /저장 \(POST doc\)/ }).click();
await page.getByText('저장됨').waitFor();
await page.locator('.tabs').getByRole('button', { name: '조회', exact: true }).click();
await page.getByRole('cell', { name: '김철수' }).waitFor();
await page.screenshot({ path: `${shots}/04-table-browse.png` });
await page.getByRole('button', { name: '키 조회/삭제' }).click();
await page.locator('input.mono').first().fill('u1');
await page.getByRole('button', { name: '조회 (GET)' }).click();
await page.getByText(/HTTP 200/).first().waitFor();
await page.locator('.tabbar').getByText('SQL').click();
await page.locator('textarea').fill('select * from orders limit 5');
await page.getByRole('button', { name: /실행/ }).click();
await page.getByRole('cell', { name: '10' }).waitFor();
await page.screenshot({ path: `${shots}/05-sql.png` });
await page.locator('.tabbar').getByText('REST').click();
await page.getByRole('button', { name: '전송' }).click();
await page.getByText(/num_tables/).first().waitFor();
await page.screenshot({ path: `${shots}/06-console.png` });
// desktop layout check
const d = await browser.newPage({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState() });
await d.goto('http://127.0.0.1:8080/#/connections');
await d.locator('.item .title', { hasText: '테스트 서버' }).click();
await d.locator('.item .title', { hasText: 'mydb' }).click();
await d.locator('.item .title', { hasText: 'users' }).waitFor();
await d.screenshot({ path: `${shots}/07-desktop.png` });
// manifest + service worker
const m = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
console.log('manifest:', m.name, m.display, 'sw:', await page.evaluate(() => navigator.serviceWorker?.getRegistrations().then((r) => r.length)));
console.log('page errors:', errors);
await browser.close();
