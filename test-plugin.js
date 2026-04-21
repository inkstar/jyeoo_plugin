const { chromium } = require('playwright');
const fs = require('fs');

const EXTENSION_PATH = '/Users/shenchaonan/Documents/jyeoo_plugin';
const USER_DATA_DIR = `/tmp/jyeoo-plugin-playwright-profile-${Date.now()}`;
const TARGET_URL = 'https://www.jyeoo.com/math2/ques/topicsearchques';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages'
    ],
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(20000);

    try {
      await page.goto(TARGET_URL, { waitUntil: 'commit', timeout: 20000 });
    } catch (error) {
      console.log(`goto_error=${error.name || 'Error'}`);
    }

    await page.waitForTimeout(15000);
    console.log(`current_url=${page.url()}`);
    console.log(`page_title=${await page.title().catch(() => '')}`);

    const button = page.locator('#jyeoo-select-all-button');
    const status = page.locator('#jyeoo-select-all-status');
    const count = await button.count();

    console.log(`button_count=${count}`);
    if (count > 0) {
      console.log(`button_text=${await button.first().innerText()}`);
      console.log(`status_text=${await status.first().innerText()}`);
    }

    const candidateSummary = await page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\s+/g, '').trim();
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const nodes = Array.from(document.querySelectorAll('button, a, span, div, li, i, input[type="checkbox"]'))
        .filter(isVisible)
        .map((node) => ({
          tag: node.tagName,
          text: normalize(node.textContent || node.getAttribute('title') || ''),
          onclick: normalize(node.getAttribute('onclick') || ''),
          cls: typeof node.className === 'string' ? node.className : '',
          id: node.id || ''
        }))
        .filter((item) => {
          const hay = `${item.text} ${item.onclick} ${item.cls} ${item.id}`;
          return /选题|试题篮|加入|paper|basket|add|select|choose/i.test(hay);
        })
        .slice(0, 80);

      return nodes;
    });

    console.log(`candidate_summary=${JSON.stringify(candidateSummary)}`);

    if (count > 0) {
      await button.first().click({ force: true });
      await page.waitForTimeout(2500);
      console.log(`status_after_click=${await status.first().innerText()}`);
    }

    try {
      const screenshotPath = `/tmp/jyeoo-plugin-test-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 8000 });
      console.log(`screenshot=${screenshotPath}`);
    } catch (error) {
      console.log(`screenshot_error=${error.name || 'Error'}`);
    }
  } finally {
    await context.close();
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
