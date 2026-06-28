const SITE_ORIGIN = 'https://basicfit-club.lwprod.nl';
const OVERVIEW_URL =
  `${SITE_ORIGIN}/overview?campaignId=201662&market=FR&language=FR`;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseSeconds(text = '') {
  const hours = Number(text.match(/(\d+)\s*h/i)?.[1] || 0);
  const minutes = Number(text.match(/(\d+)\s*m/i)?.[1] || 0);
  const seconds = Number(text.match(/(\d+)\s*s/i)?.[1] || 0);
  if (hours || minutes || seconds) return hours * 3600 + minutes * 60 + seconds;

  const clock = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (!clock) return 0;
  return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
}

function normalizeUrl(url) {
  const parsed = new URL(url, SITE_ORIGIN);
  if (parsed.origin !== SITE_ORIGIN) {
    throw new Error(`Navigation externe refusée : ${parsed.origin}`);
  }
  if (!parsed.search) {
    parsed.search = 'campaignId=201662&market=FR&language=FR';
  }
  return parsed.href;
}

async function prepareReplacementPage(page) {
  await page.evaluateOnNewDocument(() => {
    delete Document.prototype.startViewTransition;
  });
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
}

async function pageIsUsable(page) {
  try {
    await page.evaluate(() => document.readyState);
    return true;
  } catch {
    return false;
  }
}

async function replacePage(session, url) {
  const previousPage = session.page;
  const page = await session.browser.newPage();
  await prepareReplacementPage(page);
  await page.goto(normalizeUrl(url), {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  session.page = page;
  if (previousPage !== page && !previousPage.isClosed()) {
    await previousPage.close().catch(() => {});
  }
  return page;
}

async function navigate(session, url) {
  return session.runExclusive(async () => {
    const destination = normalizeUrl(url);
    if (!(await pageIsUsable(session.page))) {
      return replacePage(session, destination);
    }

    try {
      await session.page.goto(destination, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
      return session.page;
    } catch (error) {
      if (!/detached|target closed|session closed/i.test(error.message)) {
        throw error;
      }
      return replacePage(session, destination);
    }
  });
}

async function waitForPath(session, matcher, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await session.runExclusive(async () => {
      if (!(await pageIsUsable(session.page))) return null;
      const url = new URL(session.page.url());
      return matcher.test(url.pathname) ? url.pathname : false;
    });
    if (result) return result;
    await sleep(500);
  }
  let diagnostics = 'page indisponible';
  await session.runExclusive(async () => {
    if (await pageIsUsable(session.page)) {
      const body = await session.page.evaluate(() => document.body.innerText.slice(0, 180));
      diagnostics = `${session.page.url()} | ${body.replace(/\s+/g, ' ')}`;
    }
  });
  throw new Error(`Navigation attendue non atteinte : ${matcher} | ${diagnostics}`);
}

async function clickExerciseLink(session, href) {
  const clicked = await session.runExclusive(async () => {
    return session.page.evaluate((expectedHref) => {
      const link = [...document.querySelectorAll('a[href*="/details/"]')].find(
        (candidate) => candidate.href === expectedHref,
      );
      link?.click();
      return Boolean(link);
    }, href);
  });
  if (!clicked) throw new Error(`Carte exercice introuvable : ${href}`);
}

async function inspectOverview(session) {
  return session.runExclusive(async () => {
    return session.page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/details/"]')];
      return links.map((link) => {
        const text = link.innerText.trim();
        const pointMatch = text.match(/(\d+)\s*p\b/i);
        const hasCardVisual = [...link.querySelectorAll('[style]')].some(
          (element) => element.style.backgroundImage,
        );
        const spans = [...link.querySelectorAll('span')]
          .map((element) => element.textContent.trim())
          .filter(Boolean);
        const title = spans.find(
          (value) =>
            !/^\d+\s*p$/i.test(value) &&
            !/minutes?|bloqu|\d+\s*[hms]/i.test(value),
        );
        const surroundingText = link.parentElement?.parentElement?.innerText || text;
        const surroundingPoints = surroundingText.match(/(\d+)\s*p\b/i);
        const surroundingTitle = surroundingText
          .split('\n')
          .map((value) => value.trim())
          .find(
            (value) =>
              value.length > 3 &&
              value === value.toUpperCase() &&
              !/ENTRA[IÎ]NEMENT|SESSION|POINTS?|\d+\s*[hms]/i.test(value),
          );
        return {
          href: link.href,
          title:
            (hasCardVisual ? title : surroundingTitle) ||
            title ||
            text.split('\n').find(Boolean) ||
            'Activité',
          points: Number(pointMatch?.[1] || surroundingPoints?.[1] || 0),
          durationSeconds: parseDuration(text),
          cooldownSeconds: hasCardVisual && !pointMatch ? parseDuration(text) : 0,
          isCard: hasCardVisual,
        };
      });

      function parseDuration(value) {
        const hours = Number(value.match(/(\d+)\s*h/i)?.[1] || 0);
        const minutes = Number(value.match(/(\d+)\s*m(?:inutes?)?/i)?.[1] || 0);
        const seconds = Number(value.match(/(\d+)\s*s/i)?.[1] || 0);
        return hours * 3600 + minutes * 60 + seconds;
      }
    });
  });
}

async function inspectDetails(session) {
  return session.runExclusive(async () => {
    return session.page.evaluate(() => {
      const text = document.body.innerText;
      const button = [...document.querySelectorAll('button')]
        .filter((candidate) => candidate.offsetParent !== null)
        .at(-1);
      const points = Number(text.match(/(\d+)\s*(?:POINTS|p)\b/i)?.[1] || 0);
      const titleCandidates = [
        ...[...document.querySelectorAll('span')].map((element) =>
          element.textContent.trim(),
        ),
        ...text.split('\n').map((value) => value.trim()),
      ].filter(Boolean);
      const title = titleCandidates.find(
        (value) =>
          value.length > 2 &&
          value === value.toUpperCase() &&
          !/\d+\s*(?:POINTS|p|minutes?|[hms])\b/i.test(value) &&
          !/démarrer|restant|récup|session|entraînement|séance/i.test(value),
      );
      return {
        buttonText: button?.innerText?.trim() || '',
        hasEnabledButton: Boolean(button && !button.disabled),
        points,
        text,
        title: title || 'Activité',
      };
    });
  });
}

async function waitForVisibleButton(session, { enabled, timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const button = await session.runExclusive(async () => {
      return session.page.evaluate((mustBeEnabled) => {
        const candidates = [...document.querySelectorAll('button')].filter(
          (candidate) =>
            candidate.offsetParent !== null &&
            (mustBeEnabled === undefined || !candidate.disabled === mustBeEnabled),
        );
        const candidate = candidates.at(-1);
        return candidate
          ? { disabled: candidate.disabled, text: candidate.innerText.trim() }
          : null;
      }, enabled);
    });
    if (button) return button;
    await sleep(250);
  }
  throw new Error('Bouton exercice non monté après 30 s');
}

async function clickVisibleButton(session) {
  await waitForVisibleButton(session, { enabled: true });
  const clicked = await session.runExclusive(async () => {
    return session.page.evaluate(() => {
      const button = [...document.querySelectorAll('button')]
        .filter(
          (candidate) => candidate.offsetParent !== null && !candidate.disabled,
        )
        .at(-1);
      button?.click();
      return Boolean(button);
    });
  });
  if (!clicked) throw new Error('Aucun bouton actif trouvé sur la page exercice');
}

export class ActivityWorker {
  constructor(
    session,
    {
      cooldownSeconds = 0,
      initialMetrics = {},
      onUpdate = () => {},
    } = {},
  ) {
    this.session = session;
    this.cooldownSeconds = cooldownSeconds;
    this.onUpdate = onUpdate;
    this.running = false;
    this.loopPromise = null;
    this.lastExerciseUrl = null;
    this.status = {
      state: 'idle',
      phase: 'idle',
      message: 'En attente',
      activity: null,
      points: 0,
      remainingSeconds: 0,
      cycles: Number(initialMetrics.cycles || 0),
      totalPoints: Number(initialMetrics.totalPoints || 0),
      lastActionAt: null,
      error: null,
    };
  }

  snapshot() {
    return {
      ...this.status,
      running: this.running,
      cooldownSeconds: this.cooldownSeconds,
    };
  }

  setCooldown(seconds) {
    this.cooldownSeconds = Math.max(0, Number(seconds) || 0);
    this.onUpdate(this.snapshot());
  }

  update(values) {
    const previousPhase = this.status.phase;
    this.status = {
      ...this.status,
      ...values,
      lastActionAt: new Date().toISOString(),
    };
    if (values.phase && values.phase !== previousPhase) {
      console.log(
        `[worker] ${values.phase} | ${values.message || this.status.message}`,
      );
    }
    this.onUpdate(this.snapshot());
  }

  start() {
    if (this.running) return this.loopPromise;
    this.running = true;
    this.update({ state: 'running', phase: 'starting', message: 'Démarrage du cycle' });
    this.loopPromise = this.run();
    return this.loopPromise;
  }

  async stop() {
    this.running = false;
    await Promise.race([
      this.loopPromise?.catch(() => {}),
      sleep(2000),
    ]);
    this.update({ state: 'stopped', phase: 'stopped', message: 'Automatisation arrêtée' });
  }

  async waitWithCountdown(seconds, phase, message) {
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    while (this.running) {
      const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      this.update({ phase, message, remainingSeconds });
      if (remainingSeconds === 0) return;
      await sleep(Math.min(5000, remainingSeconds * 1000));
    }
  }

  async run() {
    while (this.running) {
      try {
        await this.runCycle();
      } catch (error) {
        console.error(`Worker activité : ${error.stack || error.message}`);
        this.update({
          state: 'error',
          phase: 'retry',
          message: `Nouvelle tentative dans 30 s : ${error.message}`,
          error: error.message,
          remainingSeconds: 30,
        });
        await this.waitWithCountdown(30, 'retry', 'Nouvelle tentative après erreur');
        this.update({ state: 'running', error: null });
      }
    }
  }

  async runCycle() {
    this.update({ phase: 'overview', message: 'Analyse des activités disponibles' });
    await navigate(this.session, OVERVIEW_URL);
    await waitForPath(this.session, /^\/overview$/);
    const exercises = await inspectOverview(this.session);
    const activeExercise = exercises.find((exercise) => !exercise.isCard);

    if (activeExercise) {
      this.update({
        activity: activeExercise.title,
        points: activeExercise.points,
        phase: 'resuming',
        message: 'Reprise de l’activité en cours',
      });
      await this.processExercise(activeExercise);
      return;
    }

    const available = exercises
      .filter((exercise) => exercise.isCard && exercise.points > 0)
      .sort((left, right) => {
        if (right.points !== left.points) return right.points - left.points;
        if (left.href === this.lastExerciseUrl) return 1;
        if (right.href === this.lastExerciseUrl) return -1;
        return left.title.localeCompare(right.title);
      });

    if (!available.length) {
      const cooldowns = exercises
        .map((exercise) => exercise.cooldownSeconds)
        .filter((seconds) => seconds > 0);
      const waitSeconds = cooldowns.length ? Math.min(...cooldowns) + 2 : 30;
      await this.waitWithCountdown(
        Math.min(waitSeconds, 60),
        'cooldown',
        'Toutes les activités sont en cooldown',
      );
      return;
    }

    await this.processExercise(available[0]);
  }

  async processExercise(exercise) {
    this.update({
      activity: exercise.title,
      points: exercise.points,
      phase: 'opening',
      message: `Ouverture de ${exercise.title}`,
      remainingSeconds: 0,
    });
    await clickExerciseLink(this.session, exercise.href);
    const route = await waitForPath(
      this.session,
      /^\/details\/[^/]+\/(ready|active|claim|locked)$/,
    );

    if (route.endsWith('/locked')) {
      this.update({ phase: 'cooldown', message: 'Activité verrouillée, retour à la liste' });
      await sleep(2000);
      return;
    }

    let details = await inspectDetails(this.session);
    const activity =
      exercise.title === 'Activité' || parseSeconds(exercise.title) > 0
        ? details.title
        : exercise.title;
    const points = exercise.points || details.points;
    this.update({ activity, points });

    if (route.endsWith('/ready')) {
      this.update({ phase: 'starting', message: `Démarrage de ${activity}` });
      await clickVisibleButton(this.session);
      await waitForPath(this.session, /^\/details\/[^/]+\/active$/);
      await waitForVisibleButton(this.session, { enabled: false });
      details = await inspectDetails(this.session);
    }

    const currentPath = new URL(this.session.page.url()).pathname;
    if (currentPath.endsWith('/active')) {
      const remaining =
        parseSeconds(details.buttonText) || exercise.durationSeconds || 60;
      await this.waitWithCountdown(
        remaining + 2,
        'active',
        `${activity} en cours`,
      );
      await waitForPath(this.session, /^\/details\/[^/]+\/claim$/, 30_000);
    }

    if (new URL(this.session.page.url()).pathname.endsWith('/active')) {
      await this.waitWithCountdown(5, 'active', `${activity} se termine`);
      return;
    }

    this.update({ phase: 'claiming', message: `Récupération de ${points} points` });
    await sleep(2500);
    await clickVisibleButton(this.session);
    await waitForPath(this.session, /^\/overview$/, 30_000);

    this.lastExerciseUrl = exercise.href;
    this.update({
      phase: 'completed',
      message: `${activity} terminé, ${points} points récupérés`,
      cycles: this.status.cycles + 1,
      totalPoints: this.status.totalPoints + points,
      remainingSeconds: 0,
    });
    await sleep(1500);
    if (this.cooldownSeconds > 0) {
      await this.waitWithCountdown(
        this.cooldownSeconds,
        'global-cooldown',
        `Cooldown global de ${this.cooldownSeconds} s`,
      );
    }
  }
}
