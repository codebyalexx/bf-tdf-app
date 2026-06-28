import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL =
  'https://basicfit-club.lwprod.nl/overview?campaignId=201662&market=FR&language=FR';
const SITE_ORIGIN = 'https://basicfit-club.lwprod.nl';

function isSiteRoute(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === SITE_ORIGIN &&
      (['/tutorial', '/overview'].includes(parsed.pathname) ||
        parsed.pathname.startsWith('/details/'))
    );
  } catch {
    return false;
  }
}

async function preparePage(page, viewport) {
  await page.evaluateOnNewDocument(() => {
    // The site's View Transition can detach Puppeteer's CDP frame.
    delete Document.prototype.startViewTransition;
  });
  await page.setViewport(viewport);
}

async function isPageUsable(page) {
  try {
    await page.evaluate(() => document.readyState);
    return true;
  } catch {
    return false;
  }
}

async function openStableRoute(browser, sourcePage, viewport) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === 'page' && isSiteRoute(candidate.url()),
    { timeout: 90_000 },
  );
  let page = await target.page();

  if (page && (await isPageUsable(page))) {
    return page;
  }

  page = await browser.newPage();
  await preparePage(page, viewport);
  await page.goto(target.url(), {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  if (sourcePage && sourcePage !== page && !sourcePage.isClosed()) {
    await sourcePage.close().catch(() => {});
  }

  return page;
}

async function waitForApplication(page) {
  await page.waitForFunction(
    () =>
      document.body?.innerText &&
      document.body.innerText.trim() !== 'Chargement..',
    { timeout: 90_000 },
  );
}

async function clickButtonByText(page, expectedText) {
  const clicked = await page.evaluate((text) => {
    const normalize = (value) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    const expected = normalize(text);
    const button = [...document.querySelectorAll('button')].find(
      (candidate) =>
        normalize(candidate.textContent) === expected && !candidate.disabled,
    );
    button?.click();
    return Boolean(button);
  }, expectedText);

  if (!clicked) {
    throw new Error(`Bouton introuvable : "${expectedText}".`);
  }
}

async function selectClub(page, query) {
  await clickButtonByText(page, 'TROUVE TON CLUB');
  await page.waitForFunction(
    () => document.querySelector('input[placeholder="Enter your club name"]'),
    { timeout: 30_000 },
  );

  await page.evaluate((value) => {
    const input = document.querySelector(
      'input[placeholder="Enter your club name"]',
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, query);

  const selectedName = await page.waitForFunction(
    (value) => {
      const normalize = (text) =>
        text
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim()
          .toLowerCase();
      const expected = normalize(value);
      const result = [...document.querySelectorAll('span')].find((element) => {
        const text = normalize(element.textContent || '');
        return text.includes(expected) && element.offsetParent !== null;
      });
      return result?.textContent?.trim() || false;
    },
    { timeout: 30_000 },
    query,
  );

  const clubName = await selectedName.jsonValue();
  await page.evaluate((name) => {
    const result = [...document.querySelectorAll('span')].find(
      (element) =>
        element.textContent?.trim() === name && element.offsetParent !== null,
    );
    result?.click();
  }, clubName);

  const confirmed = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter(
      (button) => !button.disabled && button.offsetParent !== null,
    );
    const confirmButton = buttons.at(-1);
    confirmButton?.click();
    return Boolean(confirmButton);
  });

  if (!confirmed) {
    throw new Error("Le bouton de confirmation du club n'est pas disponible.");
  }

  return clubName;
}

async function readSelection(selectionFile) {
  try {
    return JSON.parse(await fs.readFile(selectionFile, 'utf8'));
  } catch {
    return null;
  }
}

async function writeSelection(selectionFile, clubName, browser) {
  const cookies = await browser.defaultBrowserContext().cookies();
  await fs.mkdir(path.dirname(selectionFile), { recursive: true });
  await fs.writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        clubName,
        selectedAt: new Date().toISOString(),
        cookieCount: cookies.length,
      },
      null,
      2,
    )}\n`,
  );
}

export async function createBasicFitSession({
  clubQuery = 'Lamballe-Armor',
  profileDirectory = path.resolve('.browser-profile'),
  headless = true,
  viewport = { width: 430, height: 900, deviceScaleFactor: 1 },
} = {}) {
  const resolvedProfile = path.resolve(profileDirectory);
  const selectionFile = path.join(resolvedProfile, 'selection.json');
  const browser = await puppeteer.launch({
    headless: headless ? 'shell' : false,
    userDataDir: resolvedProfile,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=CSSViewTransitions,ViewTransitionOnNavigation,ViewTransitionOnNavigationForSameOrigin',
    ],
  });

  try {
    let page = await browser.newPage();
    await preparePage(page, viewport);

    try {
      await page.goto(BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
    } catch (error) {
      if (!/detached|target closed/i.test(error.message)) {
        throw error;
      }
    }

    page = await openStableRoute(browser, page, viewport);
    await waitForApplication(page);

    const currentPath = new URL(page.url()).pathname;
    let selectedClub;

    if (currentPath === '/tutorial') {
      selectedClub = await selectClub(page, clubQuery);
      page = await openStableRoute(browser, page, viewport);
      await page.waitForFunction(() => location.pathname === '/overview', {
        timeout: 90_000,
      });
      await waitForApplication(page);
      await writeSelection(selectionFile, selectedClub, browser);
    } else {
      const previousSelection = await readSelection(selectionFile);
      selectedClub = previousSelection?.clubName || 'club du profil existant';
    }

    let operationQueue = Promise.resolve();
    const session = {
      browser,
      page,
      profileDirectory: resolvedProfile,
      selectedClub,
      runExclusive(task) {
        const operation = operationQueue.then(() => task(session));
        operationQueue = operation.catch(() => {});
        return operation;
      },
      async close() {
        await browser.close().catch(() => {});
      },
    };
    return session;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}
