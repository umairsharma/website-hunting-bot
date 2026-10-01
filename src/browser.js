// Headless Chromium used for Google Maps (layer 2) and web search (layer 3).

export async function launchBrowser() {
  const { chromium } = await import('playwright');
  const options = { headless: true, args: ['--disable-blink-features=AutomationControlled', '--lang=en-US'] };
  let browser;
  if (process.env.CHROMIUM_PATH) {
    browser = await chromium.launch({ ...options, executablePath: process.env.CHROMIUM_PATH });
  } else {
    try {
      // Full Chromium in "new headless" mode looks more like a real browser to Google.
      browser = await chromium.launch({ ...options, channel: 'chromium' });
    } catch {
      // Some machines can't run it; Playwright's lighter headless build still works.
      browser = await chromium.launch(options);
    }
  }
  const major = (browser.version().match(/^(\d+)/) || [])[1] || '140';
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    locale: 'en-US',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  // Skip images, video and fonts: pages load much faster and nothing we read depends on them.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    return type === 'image' || type === 'media' || type === 'font' ? route.abort() : route.continue();
  });
  return { browser, context };
}

/** Opens a URL and gets past Google's cookie-consent page if one appears. Returns the HTTP response. */
export async function gotoPage(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (/^https?:\/\/consent\./i.test(page.url())) {
    const button = page.getByRole('button', { name: /reject all|accept all|i agree/i }).first();
    await button.click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  return response;
}

const BLOCK_URL = /\/sorry\/|\/recaptcha\/|\/captcha|[?&]captcha/i;
const BLOCK_TEXT = /unusual traffic|not a robot|bots use duckduckgo|solve the challenge|verify you are (a )?human|automated queries/i;

/** True when the page is a CAPTCHA / "unusual traffic" wall instead of real content. */
export async function isBlocked(page) {
  if (BLOCK_URL.test(page.url())) return true;
  const found = await page
    .evaluate(() => {
      const wall = '#captcha-form, #recaptcha, .g-recaptcha, #b_captcha, #challenge-form, .anomaly-modal__modal';
      if (document.querySelector(wall)) return 'wall';
      return document.body ? document.body.innerText.slice(0, 2000) : '';
    })
    .catch(() => '');
  return found === 'wall' || BLOCK_TEXT.test(found);
}
