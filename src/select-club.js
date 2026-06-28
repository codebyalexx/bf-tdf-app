import path from 'node:path';
import process from 'node:process';
import { createBasicFitSession } from './basicfit.js';

const clubQuery = process.env.CLUB_NAME?.trim() || 'Lamballe-Armor';
const profileDirectory = path.resolve(
  process.env.BROWSER_PROFILE || '.browser-profile',
);
const headless = ['1', 'true', 'yes'].includes(
  process.env.HEADLESS?.toLowerCase(),
);
const keepOpen =
  process.env.KEEP_OPEN !== '0' && process.env.KEEP_OPEN !== 'false';

const session = await createBasicFitSession({
  clubQuery,
  profileDirectory,
  headless,
});

let closing = false;
async function closeSession() {
  if (closing) return;
  closing = true;
  await session.close();
}

process.once('SIGINT', closeSession);
process.once('SIGTERM', closeSession);

try {
  console.log(`Page principale ouverte avec : ${session.selectedClub}`);
  console.log(`Profil persistant : ${session.profileDirectory}`);
  console.log(`URL finale : ${session.page.url()}`);

  if (!headless && keepOpen) {
    console.log('Le navigateur reste ouvert. Ctrl+C pour terminer.');
    while (!closing && session.browser.connected) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
} finally {
  await closeSession();
}
