import fs from 'node:fs/promises';
import path from 'node:path';
import { ActivityWorker } from './activity-worker.js';
import { createBasicFitSession } from './basicfit.js';

export const MAX_SESSIONS = Math.min(
  25,
  Math.max(1, Math.trunc(Number(process.env.MAX_SESSIONS) || 3)),
);
const OVERVIEW_URL =
  'https://basicfit-club.lwprod.nl/overview?campaignId=201662&market=FR&language=FR';
const CONFIG_DEFAULTS = {
  sessionCount: Math.min(
    MAX_SESSIONS,
    Math.max(1, Math.trunc(Number(process.env.DEFAULT_SESSION_COUNT) || 1)),
  ),
  cooldownSeconds: Math.min(
    86_400,
    Math.max(0, Math.trunc(Number(process.env.DEFAULT_COOLDOWN_SECONDS) || 0)),
  ),
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validateConfig(input) {
  const sessionCount = Math.min(
    MAX_SESSIONS,
    Math.max(1, Math.trunc(Number(input.sessionCount) || 1)),
  );
  const cooldownSeconds = Math.min(
    86_400,
    Math.max(0, Math.trunc(Number(input.cooldownSeconds) || 0)),
  );
  return { sessionCount, cooldownSeconds };
}

export class SessionManager {
  constructor({ rootDirectory, clubQuery = 'Lamballe-Armor' }) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.clubQuery = clubQuery;
    this.configFile = path.join(this.rootDirectory, 'config.json');
    this.sessions = new Map();
    this.config = CONFIG_DEFAULTS;
    this.ranking = {
      rank: null,
      score: null,
      clubName: null,
      updatedAt: null,
      error: null,
    };
    this.rankingTimer = null;
    this.configQueue = Promise.resolve();
  }

  async initialize() {
    this.config = validateConfig(
      await readJson(this.configFile, CONFIG_DEFAULTS),
    );
    await this.applySessionCount(this.config.sessionCount);
    this.refreshRanking().catch(() => {});
    this.rankingTimer = setInterval(
      () => this.refreshRanking().catch(() => {}),
      120_000,
    );
    return this.snapshot();
  }

  profileDirectory(id) {
    return id === 1
      ? path.resolve('.browser-profile')
      : path.join(this.rootDirectory, `session-${id}`);
  }

  async startSession(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);

    const profileDirectory = this.profileDirectory(id);
    const stateFile = path.join(profileDirectory, 'worker-state.json');
    const entry = {
      id,
      state: 'initializing',
      error: null,
      session: null,
      worker: null,
      stateFile,
      persistQueue: Promise.resolve(),
      persistedMetrics: null,
    };
    this.sessions.set(id, entry);

    try {
      const initialMetrics = await readJson(stateFile, {});
      entry.persistedMetrics = {
        cycles: Number(initialMetrics.cycles || 0),
        totalPoints: Number(initialMetrics.totalPoints || 0),
      };
      entry.session = await createBasicFitSession({
        clubQuery: this.clubQuery,
        profileDirectory,
        headless: true,
      });
      entry.worker = new ActivityWorker(entry.session, {
        cooldownSeconds: this.config.cooldownSeconds,
        initialMetrics,
        onUpdate: (status) => {
          if (
            entry.persistedMetrics.cycles === status.cycles &&
            entry.persistedMetrics.totalPoints === status.totalPoints
          ) {
            return;
          }
          entry.persistedMetrics = {
            cycles: status.cycles,
            totalPoints: status.totalPoints,
          };
          entry.persistQueue = entry.persistQueue
            .then(() =>
              writeJson(stateFile, {
                cycles: status.cycles,
                totalPoints: status.totalPoints,
                updatedAt: status.lastActionAt,
              }),
            )
            .catch((error) => {
              console.error(`Persistance session ${id} : ${error.message}`);
            });
        },
      });
      entry.state = 'running';
      entry.worker.start().catch((error) => {
        entry.state = 'error';
        entry.error = error.message;
      });
    } catch (error) {
      entry.state = 'error';
      entry.error = error.message;
      console.error(`Session ${id} : ${error.stack || error.message}`);
    }

    return entry;
  }

  async stopSession(id) {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    entry.state = 'stopping';
    const stopWorker = entry.worker?.stop().catch(() => {});
    await entry.session?.close();
    await Promise.race([stopWorker, new Promise((resolve) => setTimeout(resolve, 1000))]);
    await entry.persistQueue;
  }

  async applySessionCount(count) {
    for (let id = 1; id <= count; id += 1) {
      await this.startSession(id);
      if (id < count) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const toStop = [...this.sessions.keys()]
      .filter((id) => id > count)
      .sort((left, right) => right - left);
    for (const id of toStop) await this.stopSession(id);
  }

  configure(input) {
    const task = this.configQueue.then(async () => {
      this.config = validateConfig(input);
      await writeJson(this.configFile, this.config);
      for (const entry of this.sessions.values()) {
        entry.worker?.setCooldown(this.config.cooldownSeconds);
      }
      await this.applySessionCount(this.config.sessionCount);
      return this.snapshot();
    });
    this.configQueue = task.catch(() => {});
    return task;
  }

  getEntry(id) {
    return this.sessions.get(Number(id));
  }

  sessionSnapshot(entry) {
    const worker = entry.worker?.snapshot() || null;
    return {
      id: entry.id,
      state: entry.state,
      error: entry.error,
      clubName: entry.session?.selectedClub || null,
      profileDirectory: entry.session?.profileDirectory || null,
      worker,
    };
  }

  snapshot() {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => left.id - right.id)
      .map((entry) => this.sessionSnapshot(entry));
    return {
      config: this.config,
      limits: { maxSessions: MAX_SESSIONS },
      aggregate: {
        activeSessions: sessions.filter((item) => item.state === 'running').length,
        cycles: sessions.reduce((total, item) => total + (item.worker?.cycles || 0), 0),
        totalPoints: sessions.reduce(
          (total, item) => total + (item.worker?.totalPoints || 0),
          0,
        ),
      },
      ranking: this.ranking,
      sessions,
    };
  }

  async screenshot(id) {
    const entry = this.getEntry(id);
    if (!entry?.session || entry.state !== 'running') {
      throw new Error(`Session ${id} indisponible`);
    }
    return entry.session.runExclusive(async (session) => {
      await session.page.bringToFront();
      return session.page.screenshot({
        type: 'png',
        fullPage: true,
        captureBeyondViewport: true,
      });
    });
  }

  async refreshRanking() {
    const entry = this.getEntry(1);
    if (!entry?.session) return this.ranking;
    let page;
    try {
      page = await entry.session.browser.newPage();
      await page.evaluateOnNewDocument(() => {
        delete Document.prototype.startViewTransition;
      });
      await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
      await page.goto(OVERVIEW_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForFunction(
        () => document.querySelector('a[href*="/leaderboard"]'),
        { timeout: 30_000 },
      );
      await page.evaluate(() => {
        document.querySelector('a[href*="/leaderboard"]')?.click();
      });
      await page.waitForFunction(() => location.pathname.startsWith('/leaderboard'), {
        timeout: 30_000,
      });
      await page.waitForFunction(
        (clubName) => document.body.innerText.includes(clubName),
        { timeout: 30_000 },
        entry.session.selectedClub,
      );
      const ranking = await page.evaluate((clubName) => {
        const name = [...document.querySelectorAll('span')].find(
          (element) => element.textContent.trim() === clubName,
        );
        if (!name) return null;
        let row = name.parentElement;
        while (row && row.innerText.split('\n').filter(Boolean).length < 3) {
          row = row.parentElement;
        }
        const lines = row?.innerText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (!lines) return null;
        const rank = Number(lines[0]?.replace(/\D/g, '') || 0);
        const score = Number(
          [...lines]
            .reverse()
            .find((line) => /^[\d\s,.]+$/.test(line))
            ?.replace(/\D/g, '') || 0,
        );
        return { rank, score };
      }, entry.session.selectedClub);
      if (!ranking) throw new Error('Club absent du classement');
      this.ranking = {
        ...ranking,
        clubName: entry.session.selectedClub,
        updatedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      this.ranking = { ...this.ranking, error: error.message };
      console.error(`Classement : ${error.message}`);
    } finally {
      await page?.close().catch(() => {});
    }
    return this.ranking;
  }

  async close() {
    if (this.rankingTimer) clearInterval(this.rankingTimer);
    await Promise.all([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }
}
