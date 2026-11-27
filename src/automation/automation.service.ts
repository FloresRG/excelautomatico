import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';

const StealthPlugin = stealth;
chromium.use(StealthPlugin());

@Injectable()
export class AutomationService {
  private downloadPath: string;
  private laravelApiUrl: string;

  // 👈 CAMBIO 1: Selector más flexible y robusto para encontrar el botón de Excel
  private readonly excelBtnSelector =
    'button.buttons-excel, a.buttons-excel, button:has-text("Excel"), a:has-text("Excel"), [title*="Excel"], [class*="buttons-excel"]';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn = false;
  private currentPageUrl = '';

  // Variables para la sesión alternativa
  private browserAlt: Browser | null = null;
  private pageAlt: Page | null = null;
  private isLoggedInAlt = false;
  private currentPageUrlAlt = '';

  // Variables para la sesión Cinebol
  private browserCinebol: Browser | null = null;
  private pageCinebol: Page | null = null;
  private isLoggedInCinebol = false;
  private currentPageUrlCinebol = '';

  // Control de concurrencia por cuenta para evitar colisiones entre llamadas simultáneas
  private locks: { [key: string]: Promise<any> } = {};

  constructor(@Optional() private readonly configService?: ConfigService) {
    const customDownloadPath = this.getEnv('DOWNLOAD_PATH');
    this.downloadPath = customDownloadPath
      ? path.resolve(process.cwd(), customDownloadPath)
      : path.join(process.cwd(), 'descargas');

    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
      console.log(`📁 [INIT] Directorio creado: ${this.downloadPath}`);
    }

    this.laravelApiUrl =
      this.getEnv('LARAVEL_API_URL') ||
      'https://importadoramiranda.com/api/movimientos/importar-desde-nestjs';
  }

  private getEnv(key: string): string | undefined {
    return this.configService?.get<string>(key) ?? process.env[key];
  }

  /* ─────────── UTILIDADES ─────────── */

  private async randomDelay(min: number, max: number) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  // Escritura humana optimizada (rápida pero disparando eventos de teclado reales)
  private async typeWithDelay(page: Page, selector: string, text: string) {
    await page.locator(selector).click();
    await this.randomDelay(80, 150);
    await page.keyboard.type(text, { delay: 20 });
  }

  private async simulateHumanBehavior(_page?: Page) {
    await this.randomDelay(100, 200);
  }

  /**
   * Guarda una captura de pantalla y el contenido HTML del momento para diagnóstico visual
   */
  async saveDebugSnapshot(page: Page, stepName: string): Promise<string> {
    try {
      const timestamp = Date.now();
      const screenshotPath = path.join(
        this.downloadPath,
        `debug_${stepName}_${timestamp}.png`,
      );
      const htmlPath = path.join(
        this.downloadPath,
        `debug_${stepName}_${timestamp}.html`,
      );

      await page.screenshot({ path: screenshotPath, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(htmlPath, html, 'utf-8');

      console.log(`📸 [DEBUG] Captura guardada: ${screenshotPath}`);
      console.log(`📄 [DEBUG] HTML guardado: ${htmlPath}`);
      return screenshotPath;
    } catch (e: any) {
      console.error(
        `⚠️ [DEBUG] No se pudo guardar captura de depuración:`,
        e.message,
      );
      return '';
    }
  }

  /* ─────────── CONCURRENCIA Y CICLO DE VIDA ─────────── */

  /**
   * Ejecuta una tarea bloqueando el acceso concurrente para la misma cuenta.
   * Si dos peticiones llegan al mismo tiempo para 'ALT', la segunda espera a que la primera termine.
   */
  private async runWithLock<T>(
    accountType: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    while (this.locks[accountType]) {
      console.log(
        `⏳ [${accountType}] Otra operación en curso. Esperando a que termine...`,
      );
      await this.locks[accountType];
    }

    let releaseLock: () => void = () => {};
    this.locks[accountType] = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });

    try {
      return await fn();
    } finally {
      delete this.locks[accountType];
      releaseLock!();
    }
  }

  /**
   * Determina si el navegador debe cerrarse tras cada ejecución.
   * Por defecto es TRUE para garantizar que cada ejecución comience 100% limpia sin errores de sesión bancaria caducada.
   */
  shouldCloseBrowserAfterRun(): boolean {
    const keepOpen = this.getEnv('KEEP_BROWSER_OPEN');
    if (keepOpen !== undefined) {
      const clean = keepOpen.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (clean === 'true' || clean === '1') {
        return false;
      }
    }
    const closeAfter = this.getEnv('CLOSE_BROWSER_AFTER_RUN');
    if (closeAfter !== undefined) {
      const clean = closeAfter.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (clean === 'false' || clean === '0') {
        return false;
      }
    }
    return true;
  }

  /* ─────────── CHECK LOGIN ─────────── */

  private async isAlreadyLoggedIn(page: Page): Promise<boolean> {
    try {
      if (!page || page.isClosed()) return false;
      const currentUrl = page.url().toLowerCase();

      // Si está en la pantalla de autenticación IAM o login, no está logueado
      if (
        currentUrl.includes('authiam') ||
        currentUrl.includes('/index') ||
        currentUrl.includes('/login')
      ) {
        return false;
      }

      // Si existen campos de login en el DOM, la sesión no está activa
      const hasLoginFields =
        (await page.$('#authname, #authpass, #authbtn').catch(() => null)) !==
        null;
      if (hasLoginFields) {
        return false;
      }

      // Detectar avisos o modales de sesión expirada
      const hasExpiredNotice =
        (await page
          .$(
            'text="sesión ha expirado", text="sesion ha expirado", text="sesión caducada", text="inactividad"',
          )
          .catch(() => null)) !== null;
      if (hasExpiredNotice) {
        return false;
      }

      // Para considerar la sesión activa, los controles reales del reporte deben existir
      const hasControls =
        (await page
          .$('#startDate1, #fondoreportes, button.buttons-excel, a.buttons-excel')
          .catch(() => null)) !== null;

      return hasControls;
    } catch {
      return false;
    }
  }

  /* ─────────── INIT BROWSER ─────────── */

  private async initializeBrowser(): Promise<{ browser: Browser; page: Page }> {
    const rawHeadless = this.getEnv('HEADLESS');
    const headlessClean =
      rawHeadless !== undefined
        ? rawHeadless
            .trim()
            .replace(/^['"]|['"]$/g, '')
            .toLowerCase()
        : undefined;

    let isHeadless =
      headlessClean !== undefined
        ? headlessClean === 'true' || headlessClean === '1'
        : true;

    // En Linux (servidor VPS de producción), forzar SIEMPRE headless para evitar que Chromium intente abrir interfaz gráfica y crashee con "Missing X server"
    if (process.platform === 'linux') {
      if (!isHeadless) {
        console.warn(
          '⚠️ [BROWSER] Entorno Linux detectado: Forzando modo HEADLESS (en servidor no hay pantalla gráfica).',
        );
      }
      isHeadless = true;
    }

    const slowMoEnv = this.getEnv('SLOW_MO');
    const slowMo = slowMoEnv !== undefined ? parseInt(slowMoEnv, 10) : 0;

    console.log(
      `🚀 [BROWSER] Iniciando Chromium en modo: ${
        isHeadless
          ? 'HEADLESS (segundo plano)'
          : `VISIBLE (en pantalla con slowMo ${slowMo}ms)`
      }`,
    );

    const browser = await chromium.launch({
      headless: isHeadless,
      slowMo: slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-background-networking',
        '--window-size=1920,1080',
      ],
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'es-BO',
      timezoneId: 'America/La_Paz',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    if (!isHeadless) {
      await page.bringToFront().catch(() => {});
    }

    // Ofuscación avanzada anti-detección
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['es-BO', 'es', 'en-US', 'en'],
      });

      const originalGetParameter = (WebGLRenderingContext.prototype as any)
        .getParameter;
      (WebGLRenderingContext.prototype as any).getParameter = function (
        parameter: number,
      ) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return originalGetParameter.call(this, parameter);
      };
    });

    return { browser, page };
  }

  /* ─────────── LOGIN PRINCIPAL ─────────── */

  private async performLogin(page: Page): Promise<boolean> {
    const user = this.getEnv('BCP_USER_MAIN') || 'CajaUno11929';
    const pass = this.getEnv('BCP_PASS_MAIN') || '6ipzQ-5kOQ';
    const loginUrl = 'https://apppro.bcp.com.bo/Multiplica/AuthIAM/Index';

    try {
      console.log(`🌐 [LOGIN-MAIN] Navegando a ${loginUrl}...`);
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      console.log(`📍 [LOGIN-MAIN] URL actual: ${page.url()}`);
      console.log(`📄 [LOGIN-MAIN] Título de página: "${await page.title()}"`);

      await this.simulateHumanBehavior(page);

      console.log('🔍 [LOGIN-MAIN] Buscando campo de usuario (#authname)...');
      const userField = await page
        .waitForSelector('#authname', { timeout: 15000 })
        .catch(() => null);

      if (!userField) {
        console.error('❌ [LOGIN-MAIN] No se encontró el selector "#authname"');
        await this.saveDebugSnapshot(page, 'login_main_sin_authname');
        return false;
      }

      console.log(`✍️ [LOGIN-MAIN] Escribiendo usuario: ${user}`);
      await this.typeWithDelay(page, '#authname', user);

      console.log(
        '🔍 [LOGIN-MAIN] Buscando campo de contraseña (#authpass)...',
      );
      const passField = await page
        .waitForSelector('#authpass', { timeout: 8000 })
        .catch(() => null);

      if (!passField) {
        console.error('❌ [LOGIN-MAIN] No se encontró el selector "#authpass"');
        await this.saveDebugSnapshot(page, 'login_main_sin_authpass');
        return false;
      }

      console.log('✍️ [LOGIN-MAIN] Escribiendo contraseña...');
      await this.typeWithDelay(page, '#authpass', pass);

      console.log('🖱️ [LOGIN-MAIN] Buscando botón ingresar (#authbtn)...');
      const btnField = await page
        .waitForSelector('#authbtn', { timeout: 8000 })
        .catch(() => null);

      if (!btnField) {
        console.error('❌ [LOGIN-MAIN] No se encontró el botón "#authbtn"');
        await this.saveDebugSnapshot(page, 'login_main_sin_authbtn');
        return false;
      }

      // Pausa mínima para asentar eventos de entrada
      await this.randomDelay(200, 400);

      console.log('🔘 [LOGIN-MAIN] Presionando botón de ingreso (#authbtn)...');
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 })
          .catch((err) => {
            console.log(
              '⚠️ [LOGIN-MAIN] Navegación tardó o finalizó:',
              err.message,
            );
          }),
        page.click('#authbtn'),
      ]);

      // Si ya navegó al dashboard o ya tiene el botón de Excel, éxito inmediato
      if (await this.isAlreadyLoggedIn(page)) {
        console.log(`📍 [LOGIN-MAIN] URL tras autenticación: ${page.url()}`);
        this.isLoggedIn = true;
        this.currentPageUrl = page.url();
        return true;
      }

      const loginSuccess = await this.handleLoginError(page, pass);
      if (!loginSuccess) {
        console.error(
          '❌ [LOGIN-MAIN] No se pudo completar el login después de reintentar',
        );
        return false;
      }

      console.log(`📍 [LOGIN-MAIN] URL tras autenticación: ${page.url()}`);

      this.isLoggedIn = true;
      this.currentPageUrl = page.url();

      return true;
    } catch (error: any) {
      console.error(
        '❌ [LOGIN-MAIN] Error durante el proceso de login:',
        error.message,
      );
      await this.saveDebugSnapshot(page, 'login_main_error');
      return false;
    }
  }

  /**
   * Maneja el mensaje de error "Ingrese sus datos" reintentando con solo contraseña
   */
  private async handleLoginError(
    page: Page,
    password: string,
  ): Promise<boolean> {
    const errorSelectors = [
      'text=Ingrese sus datos',
      '[class*="alert"][class*="error"]',
      '.alert-danger',
      '.error-message',
      'div[class*="error"]',
    ];

    let hasError = false;
    for (const selector of errorSelectors) {
      const errorElement = await page.$(selector).catch(() => null);
      if (errorElement) {
        hasError = true;
        console.log(
          '⚠️ [LOGIN] Detectado mensaje de error "Ingrese sus datos". Reintentando...',
        );
        break;
      }
    }

    if (hasError) {
      const closeBtn = await page
        .$('button[class*="close"], .alert button, [aria-label="Close"]')
        .catch(() => null);
      if (closeBtn) {
        await closeBtn.click();
        await this.randomDelay(150, 300);
      }

      console.log('✍️ [LOGIN-RETRY] Reingresando contraseña...');
      await this.typeWithDelay(page, '#authpass', password);
      await this.randomDelay(200, 400);

      console.log('🔘 [LOGIN-RETRY] Click en botón Iniciar Sesión...');
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 })
          .catch((err) => {
            console.log(
              '⚠️ [LOGIN-RETRY] Navegación tardó o finalizó:',
              err.message,
            );
          }),
        page.click('#authbtn'),
      ]);

      await this.randomDelay(500, 1000);

      const stillHasError = await page
        .$('text=Ingrese sus datos')
        .catch(() => null);
      if (stillHasError) {
        console.error(
          '❌ [LOGIN-RETRY] El error persiste después del reintento',
        );
        await this.saveDebugSnapshot(page, 'login_retry_failed');
        return false;
      }

      console.log(
        '✅ [LOGIN-RETRY] Login completado exitosamente después del reintento',
      );
    }

    return true;
  }

  /* ─────────── LOGIN ALTERNATIVO ─────────── */

  private async performLoginAlt(page: Page): Promise<boolean> {
    const user = this.getEnv('BCP_USER_ALT') || 'CajaLive114559';
    const pass = this.getEnv('BCP_PASS_ALT') || 'hXDfP-cj2w';
    const loginUrl = 'https://apppro.bcp.com.bo/Multiplica/AuthIAM/Index';

    try {
      console.log(`🌐 [LOGIN-ALT] Navegando a ${loginUrl}...`);
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      console.log(`📍 [LOGIN-ALT] URL actual: ${page.url()}`);
      console.log(`📄 [LOGIN-ALT] Título de página: "${await page.title()}"`);

      await this.simulateHumanBehavior(page);

      console.log('🔍 [LOGIN-ALT] Buscando campo de usuario (#authname)...');
      const userField = await page
        .waitForSelector('#authname', { timeout: 15000 })
        .catch(() => null);

      if (!userField) {
        console.error('❌ [LOGIN-ALT] No se encontró el selector "#authname"');
        await this.saveDebugSnapshot(page, 'login_alt_sin_authname');
        return false;
      }

      console.log(`✍️ [LOGIN-ALT] Escribiendo usuario: ${user}`);
      await this.typeWithDelay(page, '#authname', user);

      console.log('🔍 [LOGIN-ALT] Buscando campo de contraseña (#authpass)...');
      const passField = await page
        .waitForSelector('#authpass', { timeout: 8000 })
        .catch(() => null);

      if (!passField) {
        console.error('❌ [LOGIN-ALT] No se encontró el selector "#authpass"');
        await this.saveDebugSnapshot(page, 'login_alt_sin_authpass');
        return false;
      }

      console.log('✍️ [LOGIN-ALT] Escribiendo contraseña...');
      await this.typeWithDelay(page, '#authpass', pass);

      // Pausa mínima para asentar eventos de entrada
      await this.randomDelay(200, 400);

      console.log('🔘 [LOGIN-ALT] Presionando botón ingresar (#authbtn)...');
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 })
          .catch((err) => {
            console.log(
              '⚠️ [LOGIN-ALT] Navegación tardó o finalizó:',
              err.message,
            );
          }),
        page.click('#authbtn'),
      ]);

      // Si ya navegó al dashboard o ya tiene el botón de Excel, éxito inmediato
      if (await this.isAlreadyLoggedIn(page)) {
        console.log(`📍 [LOGIN-ALT] URL tras autenticación: ${page.url()}`);
        this.isLoggedInAlt = true;
        this.currentPageUrlAlt = page.url();
        return true;
      }

      const loginSuccess = await this.handleLoginError(page, pass);
      if (!loginSuccess) {
        console.error(
          '❌ [LOGIN-ALT] No se pudo completar el login después de reintentar',
        );
        return false;
      }

      console.log(`📍 [LOGIN-ALT] URL tras autenticación: ${page.url()}`);

      this.isLoggedInAlt = true;
      this.currentPageUrlAlt = page.url();

      return true;
    } catch (error: any) {
      console.error(
        '❌ [LOGIN-ALT] Error durante el proceso de login:',
        error.message,
      );
      await this.saveDebugSnapshot(page, 'login_alt_error');
      return false;
    }
  }

  /* ─────────── LOGIN CINEBOL ─────────── */

  private async performLoginCinebol(page: Page): Promise<boolean> {
    const user = this.getEnv('BCP_USER_CINEBOL') || 'CajaCinebol172131';
    const pass = this.getEnv('BCP_PASS_CINEBOL') || '2gXlo-BnBu';
    const loginUrl = 'https://apppro.bcp.com.bo/Multiplica/AuthIAM/Index';

    try {
      console.log(`🌐 [LOGIN-CINEBOL] Navegando a ${loginUrl}...`);
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      console.log(`📍 [LOGIN-CINEBOL] URL actual: ${page.url()}`);
      console.log(
        `📄 [LOGIN-CINEBOL] Título de página: "${await page.title()}"`,
      );

      await this.simulateHumanBehavior(page);

      console.log(
        '🔍 [LOGIN-CINEBOL] Buscando campo de usuario (#authname)...',
      );
      const userField = await page
        .waitForSelector('#authname', { timeout: 15000 })
        .catch(() => null);

      if (!userField) {
        console.error(
          '❌ [LOGIN-CINEBOL] No se encontró el selector "#authname"',
        );
        await this.saveDebugSnapshot(page, 'login_cinebol_sin_authname');
        return false;
      }

      console.log(`✍️ [LOGIN-CINEBOL] Escribiendo usuario: ${user}`);
      await this.typeWithDelay(page, '#authname', user);

      console.log(
        '🔍 [LOGIN-CINEBOL] Buscando campo de contraseña (#authpass)...',
      );
      const passField = await page
        .waitForSelector('#authpass', { timeout: 8000 })
        .catch(() => null);

      if (!passField) {
        console.error(
          '❌ [LOGIN-CINEBOL] No se encontró el selector "#authpass"',
        );
        await this.saveDebugSnapshot(page, 'login_cinebol_sin_authpass');
        return false;
      }

      console.log('✍️ [LOGIN-CINEBOL] Escribiendo contraseña...');
      await this.typeWithDelay(page, '#authpass', pass);

      console.log('🖱️ [LOGIN-CINEBOL] Buscando botón ingresar (#authbtn)...');
      const btnField = await page
        .waitForSelector('#authbtn', { timeout: 8000 })
        .catch(() => null);

      if (!btnField) {
        console.error('❌ [LOGIN-CINEBOL] No se encontró el botón "#authbtn"');
        await this.saveDebugSnapshot(page, 'login_cinebol_sin_authbtn');
        return false;
      }

      // Pausa mínima para asentar eventos de entrada
      await this.randomDelay(200, 400);

      console.log(
        '🔘 [LOGIN-CINEBOL] Presionando botón de ingreso (#authbtn)...',
      );
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 })
          .catch((err) => {
            console.log(
              '⚠️ [LOGIN-CINEBOL] Navegación tardó o finalizó:',
              err.message,
            );
          }),
        page.click('#authbtn'),
      ]);

      // Si ya navegó al dashboard o ya tiene el botón de Excel, éxito inmediato
      if (await this.isAlreadyLoggedIn(page)) {
        console.log(`📍 [LOGIN-CINEBOL] URL tras autenticación: ${page.url()}`);
        this.isLoggedInCinebol = true;
        this.currentPageUrlCinebol = page.url();
        return true;
      }

      const loginSuccess = await this.handleLoginError(page, pass);
      if (!loginSuccess) {
        console.error(
          '❌ [LOGIN-CINEBOL] No se pudo completar el login después de reintentar',
        );
        return false;
      }

      console.log(`📍 [LOGIN-CINEBOL] URL tras autenticación: ${page.url()}`);

      this.isLoggedInCinebol = true;
      this.currentPageUrlCinebol = page.url();

      return true;
    } catch (error: any) {
      console.error(
        '❌ [LOGIN-CINEBOL] Error durante el proceso de login:',
        error.message,
      );
      await this.saveDebugSnapshot(page, 'login_cinebol_error');
      return false;
    }
  }

  /* ─────────── REFRESH Y FECHA ─────────── */

  getTodayBolivia(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/La_Paz',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private async refreshPageForLatestData(page: Page) {
    const hasReportControls = await page.$('#startDate1').catch(() => null);
    if (!hasReportControls) {
      console.log(
        '🔄 [REFRESH] Controles no detectados en DOM. Recargando página...',
      );
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      await this.randomDelay(200, 400);
    } else {
      console.log(
        '⚡ [FAST] Controles de reporte listos en memoria. Continuando sin reload innecesario.',
      );
    }
  }

  private async updateReportData(
    page: Page,
    targetDate?: string,
  ): Promise<boolean> {
    const fecha = targetDate || this.getTodayBolivia();
    console.log(
      `📅 [REPORT-UPDATE] Actualizando reporte con fecha: ${fecha}...`,
    );

    try {
      console.log(
        '🔍 [REPORT-UPDATE] Buscando campo de fecha (#startDate1)...',
      );
      const inputField = await page
        .waitForSelector('#startDate1', { timeout: 10000 })
        .catch(() => null);

      if (!inputField) {
        console.error(
          '❌ [REPORT-UPDATE] No se encontró el campo "#startDate1"',
        );
        await this.saveDebugSnapshot(page, 'update_sin_startDate1');
        return false;
      }

      console.log(
        `✍️ [REPORT-UPDATE] Asignando fecha ${fecha} a #startDate1...`,
      );
      await page.evaluate((fechaValue) => {
        const input = document.getElementById('startDate1') as HTMLInputElement;
        if (input) {
          input.value = fechaValue;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, fecha);

      await this.randomDelay(100, 200);

      console.log(
        '🔘 [REPORT-UPDATE] Buscando botón "Actualizar Reporte" (#fondoreportes)...',
      );
      const btnField = await page
        .waitForSelector('#fondoreportes', { timeout: 8000 })
        .catch(() => null);

      if (!btnField) {
        console.error(
          '❌ [REPORT-UPDATE] No se encontró el botón "#fondoreportes"',
        );
        await this.saveDebugSnapshot(page, 'update_sin_fondoreportes');
        return false;
      }

      console.log(
        '🖱️ [REPORT-UPDATE] Clic en "#fondoreportes" para consultar últimos movimientos...',
      );
      await page.click('#fondoreportes');

      console.log(
        '⏳ [REPORT-UPDATE] Esperando respuesta del servidor y carga de datos...',
      );
      await Promise.race([
        page
          .waitForSelector(
            '.dataTables_processing, .blockUI, div[id*="loading"], div[class*="loading"]',
            { state: 'hidden', timeout: 8000 },
          )
          .catch(() => {}),
        page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}),
      ]);

      const exportBtn = page.locator(this.excelBtnSelector).first();
      await exportBtn
        .waitFor({ state: 'visible', timeout: 10000 })
        .catch(() => {});

      console.log('✅ [REPORT-UPDATE] Reporte actualizado exitosamente.');
      return true;
    } catch (error: any) {
      console.error(
        '❌ [REPORT-UPDATE] Error al actualizar reporte:',
        error.message,
      );
      await this.saveDebugSnapshot(page, 'update_report_error');
      return false;
    }
  }

  /* ─────────── VERIFICACIÓN DE REGISTROS EN TABLA ─────────── */

  /**
   * Verifica si la tabla de reportes contiene registros reales o si está vacía
   */
  private async hasTableRecords(
    page: Page,
    prefix: string = 'REPORT',
  ): Promise<{ hasRecords: boolean; count: number; infoText: string }> {
    try {
      // 1. Esperar a que la tabla o el indicador de info estén disponibles en el DOM
      await page
        .waitForSelector('#table, #table_info, .dataTables_info', {
          timeout: 10000,
        })
        .catch(() => null);

      // Esperar a que termine cualquier indicador de procesamiento de DataTables
      await page
        .waitForSelector(
          '.dataTables_processing, .blockUI, div[id*="loading"], div[class*="loading"]',
          { state: 'hidden', timeout: 8000 },
        )
        .catch(() => null);

      // Pausa breve para asentar la renderización de filas tras el filtro
      await this.randomDelay(400, 700);

      const result = await page.evaluate(() => {
        const infoEl = document.querySelector('#table_info, .dataTables_info');
        const infoText = infoEl ? (infoEl.textContent || '').trim() : '';

        // 1. Si el propio DataTables dice explícitamente 0 registros
        if (infoText) {
          const zeroPatterns = [
            /total de 0\b/i,
            /del 0 al 0\b/i,
            /0 a 0 de 0\b/i,
            /0 de un total de 0\b/i,
            /0 registros\b/i,
            /no entries\b/i,
          ];
          for (const pattern of zeroPatterns) {
            if (pattern.test(infoText)) {
              return { hasRecords: false, count: 0, infoText };
            }
          }
        }

        // 2. Revisar si hay celda con la clase oficial de vacío de DataTables (.dataTables_empty)
        const emptyCell = document.querySelector(
          '#table tbody td.dataTables_empty, table.dataTable tbody td.dataTables_empty, .dataTables_empty',
        );
        if (emptyCell) {
          return {
            hasRecords: false,
            count: 0,
            infoText:
              emptyCell.textContent?.trim() || 'Sin registros (dataTables_empty)',
          };
        }

        // 3. Inspeccionar directamente las filas del tbody
        const rows = Array.from(
          document.querySelectorAll(
            '#table tbody tr, table.dataTable tbody tr',
          ),
        );
        if (!rows || rows.length === 0) {
          return { hasRecords: false, count: 0, infoText: 'Tbody sin filas' };
        }

        // 4. Analizar cada fila individual para verificar si contiene DATOS REALES
        // A veces el backend/DataTables genera 1 fila pero con celdas completamente en blanco
        const emptyPhrases = [
          'ningún dato',
          'ningun dato',
          'no hay datos',
          'no se encontraron',
          'no matching records',
          'sin datos',
          'sin registros',
        ];

        const validRows = rows.filter((row) => {
          // Si tiene clase de vacío
          if (
            row.classList.contains('dataTables_empty') ||
            row.querySelector('td.dataTables_empty')
          ) {
            return false;
          }

          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length === 0) return false;

          // Concatenar el contenido de texto de todas las celdas
          const rawText = cells.map((c) => c.textContent || '').join(' ').trim();
          const cleanText = rawText.replace(/[\s\u00a0\t\r\n]/g, '');

          // Si todas las celdas están completamente en blanco (fila fantasma con celdas vacías)
          if (cleanText.length === 0) {
            return false;
          }

          // Si el texto es una frase de tabla vacía
          const lowerRaw = rawText.toLowerCase();
          for (const phrase of emptyPhrases) {
            if (lowerRaw.includes(phrase)) {
              return false;
            }
          }

          // Para que sea un registro bancario real, debe tener al menos dígitos o letras significativas
          const hasDigits = /\d/.test(cleanText);
          const hasLetters = /[a-zA-Z]/.test(cleanText);

          if (!hasDigits && !hasLetters) {
            return false;
          }

          // En una transacción real hay Cliente, Fecha, Monto, Banco, etc.
          // Comprobamos que existan al menos 2 celdas con contenido real no vacío ni guiones
          const nonEmptyCells = cells.filter((c) => {
            const t = (c.textContent || '').replace(/[\s\u00a0]/g, '');
            return t.length > 0 && t !== '-';
          });

          if (nonEmptyCells.length < 2) {
            return false;
          }

          return true;
        });

        if (validRows.length === 0) {
          return {
            hasRecords: false,
            count: 0,
            infoText: infoText
              ? `${infoText} (pero las celdas están vacías/sin datos reales)`
              : 'Fila vacía sin datos reales',
          };
        }

        return {
          hasRecords: true,
          count: validRows.length,
          infoText: infoText || `${validRows.length} registros válidos`,
        };
      });

      if (!result.hasRecords) {
        console.log(
          `ℹ️ [${prefix}] Verificación: NO existen registros válidos en la tabla. Detalle: "${result.infoText}".`,
        );
      } else {
        console.log(
          `📊 [${prefix}] Verificación: Se encontraron registros reales en la tabla (${result.count}). Info: "${result.infoText}".`,
        );
      }

      return result;
    } catch (error: any) {
      console.warn(
        `⚠️ [${prefix}] Error al verificar registros en la tabla: ${error.message}. Continuando con flujo normal.`,
      );
      return { hasRecords: true, count: -1, infoText: 'Error en verificación' };
    }
  }

  /* ─────────── DESCARGA EXCEL OPTIMIZADA ─────────── */

  private async triggerExcelDownload(
    page: Page,
    filePrefix: string,
  ): Promise<string> {
    console.log(`🔍 [${filePrefix}] Buscando botón "Exportar a Excel"...`);
    const foundBtn: Locator = page.locator(this.excelBtnSelector).first();

    try {
      await foundBtn.waitFor({ state: 'visible', timeout: 15000 });
    } catch (_e) {
      console.error(
        `❌ [${filePrefix}] No se encontró el botón "Exportar a Excel"`,
      );
      await this.saveDebugSnapshot(
        page,
        `${filePrefix.toLowerCase()}_sin_boton_excel`,
      );
      throw new Error(
        'No se encontró el botón "Exportar a Excel". Revisa la captura en descargas/ para ver qué muestra la página.',
      );
    }

    console.log(
      `⬇️ [${filePrefix}] Iniciando clic en exportar y esperando descarga...`,
    );
    await foundBtn.scrollIntoViewIfNeeded();

    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        foundBtn.click(),
      ]);

      const excelPath = path.join(
        this.downloadPath,
        `${filePrefix}_${Date.now()}.xlsx`,
      );
      await download.saveAs(excelPath);
      console.log(
        `✅ [${filePrefix}] Archivo descargado exitosamente en: ${excelPath}`,
      );
      return excelPath;
    } catch (error: any) {
      if (
        error.name === 'TimeoutError' ||
        error.message?.includes('Timeout') ||
        error.message?.includes('download')
      ) {
        console.error(
          `❌ [${filePrefix}] Timeout esperando el evento de descarga: ${error.message}. Es probable que no existan datos para exportar.`,
        );
        await this.saveDebugSnapshot(
          page,
          `${filePrefix.toLowerCase()}_download_timeout`,
        );
      }
      throw error;
    }
  }

  /* ─────────── ELIMINAR ARCHIVO ─────────── */

  private async deleteFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ [DELETE] Archivo eliminado: ${filePath}`);
      }
    } catch (error: any) {
      console.error(`❌ [DELETE] Error al eliminar archivo:`, error.message);
    }
  }

  /* ─────────── LARAVEL ─────────── */

  private async sendExcelToLaravel(excelPath: string) {
    console.log(
      `📤 [LARAVEL] Enviando ${excelPath} a ${this.laravelApiUrl}...`,
    );
    const formData = new FormData();
    formData.append('archivo_excel', fs.createReadStream(excelPath));
    formData.append('origen', 'nestjs');

    try {
      const response = await axios.post(this.laravelApiUrl, formData, {
        headers: formData.getHeaders(),
        timeout: 30000,
        maxBodyLength: Infinity,
      });

      console.log(
        `✅ [LARAVEL] Respuesta recibida (${response.status}):`,
        response.data,
      );
      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error(
          `❌ [LARAVEL] Error en respuesta de Laravel (HTTP ${error.response.status}):`,
          error.response.data,
        );
      } else {
        console.error(
          `❌ [LARAVEL] Error de conexión con Laravel:`,
          error.message,
        );
      }
      throw error;
    } finally {
      await this.deleteFile(excelPath);
    }
  }

  /* ─────────── GESTIÓN DE SESIÓN ROBUSTA (AUTO-RECUPERACIÓN) ─────────── */

  private isSessionAlive(browser: Browser | null, page: Page | null): boolean {
    if (!browser || !page) return false;
    try {
      if (!browser.isConnected()) return false;
      if (page.isClosed()) return false;
      return true;
    } catch {
      return false;
    }
  }

  private setSessionVars(
    accountType: 'MAIN' | 'ALT' | 'CINEBOL',
    browser: Browser | null,
    page: Page | null,
    isLoggedIn: boolean,
  ) {
    if (accountType === 'MAIN') {
      this.browser = browser;
      this.page = page;
      this.isLoggedIn = isLoggedIn;
      if (page && !page.isClosed()) {
        try {
          this.currentPageUrl = page.url();
        } catch {
          this.currentPageUrl = '';
        }
      }
    } else if (accountType === 'ALT') {
      this.browserAlt = browser;
      this.pageAlt = page;
      this.isLoggedInAlt = isLoggedIn;
      if (page && !page.isClosed()) {
        try {
          this.currentPageUrlAlt = page.url();
        } catch {
          this.currentPageUrlAlt = '';
        }
      }
    } else {
      this.browserCinebol = browser;
      this.pageCinebol = page;
      this.isLoggedInCinebol = isLoggedIn;
      if (page && !page.isClosed()) {
        try {
          this.currentPageUrlCinebol = page.url();
        } catch {
          this.currentPageUrlCinebol = '';
        }
      }
    }
  }

  async closeSession(accountType: 'MAIN' | 'ALT' | 'CINEBOL') {
    try {
      if (accountType === 'MAIN') {
        if (this.browser) {
          await this.browser.close().catch(() => {});
        }
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
        this.currentPageUrl = '';
      } else if (accountType === 'ALT') {
        if (this.browserAlt) {
          await this.browserAlt.close().catch(() => {});
        }
        this.browserAlt = null;
        this.pageAlt = null;
        this.isLoggedInAlt = false;
        this.currentPageUrlAlt = '';
      } else {
        if (this.browserCinebol) {
          await this.browserCinebol.close().catch(() => {});
        }
        this.browserCinebol = null;
        this.pageCinebol = null;
        this.isLoggedInCinebol = false;
        this.currentPageUrlCinebol = '';
      }
    } catch (err: any) {
      console.warn(
        `⚠️ [CLOSE-${accountType}] Error al cerrar sesión/navegador:`,
        err.message,
      );
    }
  }

  private async performLoginByType(
    accountType: 'MAIN' | 'ALT' | 'CINEBOL',
    page: Page,
  ): Promise<boolean> {
    if (accountType === 'MAIN') {
      return this.performLogin(page);
    } else if (accountType === 'ALT') {
      return this.performLoginAlt(page);
    } else {
      return this.performLoginCinebol(page);
    }
  }

  private async ensureSession(
    accountType: 'MAIN' | 'ALT' | 'CINEBOL',
  ): Promise<{ browser: Browser; page: Page }> {
    let browser: Browser | null = null;
    let page: Page | null = null;

    if (accountType === 'MAIN') {
      browser = this.browser;
      page = this.page;
    } else if (accountType === 'ALT') {
      browser = this.browserAlt;
      page = this.pageAlt;
    } else {
      browser = this.browserCinebol;
      page = this.pageCinebol;
    }

    // 1. Si no existe o se cerró la página/navegador, iniciar una nueva instancia limpia
    if (!this.isSessionAlive(browser, page)) {
      console.log(`🆕 [${accountType}] Iniciando nueva sesión del navegador...`);
      await this.closeSession(accountType);
      const init = await this.initializeBrowser();
      browser = init.browser;
      page = init.page;
      this.setSessionVars(accountType, browser, page, false);

      const loginOk = await this.performLoginByType(accountType, page);
      if (!loginOk) {
        await this.closeSession(accountType);
        throw new Error(`Falló el login con credenciales de ${accountType}`);
      }
      this.setSessionVars(accountType, browser, page, true);
      return { browser, page };
    }

    // 2. Si el navegador está vivo en memoria, verificar si la sesión sigue activa dentro del portal
    console.log(`♻️ [${accountType}] Verificando sesión de navegador existente...`);
    const loggedIn = await this.isAlreadyLoggedIn(page!);

    if (!loggedIn) {
      console.log(
        `🔑 [${accountType}] Sesión no iniciada o vencida. Limpiando y creando nueva sesión limpia...`,
      );
      await this.closeSession(accountType);
      const init = await this.initializeBrowser();
      browser = init.browser;
      page = init.page;
      this.setSessionVars(accountType, browser, page, false);

      const loginOk = await this.performLoginByType(accountType, page);
      if (!loginOk) {
        await this.closeSession(accountType);
        throw new Error(`Falló el login con credenciales de ${accountType}`);
      }
      this.setSessionVars(accountType, browser, page, true);
      return { browser, page };
    } else {
      await this.refreshPageForLatestData(page!);
      const stillLoggedIn = await this.isAlreadyLoggedIn(page!);
      if (!stillLoggedIn) {
        console.warn(
          `⚠️ [${accountType}] Tras refrescar la página se perdió la sesión (sesión bancaria caducada). Abriendo sesión limpia...`,
        );
        await this.closeSession(accountType);
        return this.ensureSession(accountType);
      }
    }

    return { browser: browser!, page: page! };
  }

  /* ─────────── MAIN PRINCIPAL ─────────── */

  async downloadExcelAndSendToLaravel(
    fecha?: string,
    skipLaravel: boolean = false,
  ) {
    return this.runWithLock('MAIN', async () => {
      try {
        const { page } = await this.ensureSession('MAIN');

        const fechaFiltro = fecha || this.getTodayBolivia();
        console.log(
          `🔄 [MAIN] Actualizando reporte antes de exportar (Fecha: ${fechaFiltro})...`,
        );
        const updated = await this.updateReportData(page, fechaFiltro);
        if (!updated) {
          console.warn(
            '⚠️ [MAIN] No se pudo actualizar el reporte con #fondoreportes, intentando exportar...',
          );
        }

        const tableStatus = await this.hasTableRecords(page, 'MAIN');
        if (!tableStatus.hasRecords) {
          console.log(
            `ℹ️ [MAIN] No existen registros en la tabla para la fecha ${fechaFiltro}. Se omite la descarga de Excel.`,
          );
          return {
            success: false,
            hasRecords: false,
            message: `No existen registros para la fecha ${fechaFiltro}`,
            fechaFiltro,
            registros: 0,
            infoTabla: tableStatus.infoText,
            laravelResponse: null,
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const excelPath = await this.triggerExcelDownload(page, 'Reporte');

        if (skipLaravel || this.getEnv('SKIP_LARAVEL') === 'true') {
          console.log(
            `💾 [MAIN] Modo prueba: Archivo conservado en ${excelPath} (no enviado a Laravel)`,
          );
          return {
            success: true,
            message:
              'Excel descargado exitosamente (modo prueba: no enviado a Laravel)',
            excelPath,
            fechaFiltro,
            laravelResponse: { skipped: true },
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const laravelResponse = await this.sendExcelToLaravel(excelPath);

        return {
          success: true,
          message: 'Excel descargado y enviado a Laravel exitosamente',
          excelPath,
          fechaFiltro,
          laravelResponse,
          timestamp: new Date().toISOString(),
          reusedSession: !this.shouldCloseBrowserAfterRun(),
        };
      } catch (error: any) {
        console.error(`❌ [MAIN] Error durante automatización:`, error.message);
        await this.closeSession('MAIN');
        throw error;
      } finally {
        if (this.shouldCloseBrowserAfterRun()) {
          await this.closeSession('MAIN');
        }
      }
    });
  }

  /* ─────────── MAIN ALTERNATIVO ─────────── */

  async downloadExcelAndSendToLaravelAlt(
    fecha?: string,
    skipLaravel: boolean = false,
  ) {
    return this.runWithLock('ALT', async () => {
      try {
        const { page } = await this.ensureSession('ALT');

        const fechaFiltro = fecha || this.getTodayBolivia();
        console.log(
          `🔄 [ALT] Actualizando reporte antes de exportar (Fecha: ${fechaFiltro})...`,
        );
        const updated = await this.updateReportData(page, fechaFiltro);
        if (!updated) {
          console.warn(
            '⚠️ [ALT] No se pudo actualizar el reporte con #fondoreportes, intentando exportar...',
          );
        }

        const tableStatus = await this.hasTableRecords(page, 'ALT');
        if (!tableStatus.hasRecords) {
          console.log(
            `ℹ️ [ALT] No existen registros en la tabla para la fecha ${fechaFiltro}. Se omite la descarga de Excel.`,
          );
          return {
            success: false,
            hasRecords: false,
            message: `No existen registros para la fecha ${fechaFiltro}`,
            fechaFiltro,
            registros: 0,
            infoTabla: tableStatus.infoText,
            laravelResponse: null,
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const excelPath = await this.triggerExcelDownload(
          page,
          'ReporteAlt',
        );

        if (skipLaravel || this.getEnv('SKIP_LARAVEL') === 'true') {
          console.log(
            `💾 [ALT] Modo prueba: Archivo conservado en ${excelPath} (no enviado a Laravel)`,
          );
          return {
            success: true,
            message:
              'Excel descargado exitosamente (modo prueba: no enviado a Laravel)',
            excelPath,
            fechaFiltro,
            laravelResponse: { skipped: true },
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const laravelResponse = await this.sendExcelToLaravel(excelPath);

        return {
          success: true,
          message:
            'Excel descargado y enviado a Laravel exitosamente (usando credenciales alternativas)',
          excelPath,
          fechaFiltro,
          laravelResponse,
          timestamp: new Date().toISOString(),
          reusedSession: !this.shouldCloseBrowserAfterRun(),
        };
      } catch (error: any) {
        console.error(`❌ [ALT] Error durante automatización:`, error.message);
        await this.closeSession('ALT');
        throw error;
      } finally {
        if (this.shouldCloseBrowserAfterRun()) {
          await this.closeSession('ALT');
        }
      }
    });
  }

  /* ─────────── MAIN CON FILTRO FECHA (CAJALIVE) ─────────── */

  async downloadExcelWithDateFilter(
    fecha: string,
    skipLaravel: boolean = false,
  ) {
    return this.runWithLock('ALT', async () => {
      try {
        const { page } = await this.ensureSession('ALT');

        console.log(`📅 [FILTER] Aplicando filtro de fecha: ${fecha}...`);
        const filterApplied = await this.updateReportData(page, fecha);
        if (!filterApplied) {
          throw new Error(
            `No se pudo aplicar el filtro de fecha "${fecha}". Revisa la captura en descargas/.`,
          );
        }

        const tableStatus = await this.hasTableRecords(page, 'ReporteFilter');
        if (!tableStatus.hasRecords) {
          console.log(
            `ℹ️ [FILTER] No existen registros en la tabla para la fecha ${fecha}. Se omite la descarga de Excel.`,
          );
          return {
            success: false,
            hasRecords: false,
            message: `No existen registros para la fecha ${fecha}`,
            fechaFiltro: fecha,
            registros: 0,
            infoTabla: tableStatus.infoText,
            laravelResponse: null,
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const excelPath = await this.triggerExcelDownload(
          page,
          'ReporteFilter',
        );

        if (skipLaravel || this.getEnv('SKIP_LARAVEL') === 'true') {
          console.log(
            `💾 [FILTER] Modo prueba: Archivo conservado en ${excelPath} (no enviado a Laravel)`,
          );
          return {
            success: true,
            message:
              'Excel descargado con filtro de fecha (modo prueba: no enviado a Laravel)',
            excelPath,
            fechaFiltro: fecha,
            laravelResponse: { skipped: true },
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const laravelResponse = await this.sendExcelToLaravel(excelPath);

        return {
          success: true,
          message:
            'Excel descargado con filtro de fecha y enviado a Laravel exitosamente',
          excelPath,
          fechaFiltro: fecha,
          laravelResponse,
          timestamp: new Date().toISOString(),
          reusedSession: !this.shouldCloseBrowserAfterRun(),
        };
      } catch (error: any) {
        console.error(
          `❌ [FILTER-ALT] Error durante automatización:`,
          error.message,
        );
        await this.closeSession('ALT');
        throw error;
      } finally {
        if (this.shouldCloseBrowserAfterRun()) {
          await this.closeSession('ALT');
        }
      }
    });
  }

  /* ─────────── MAIN CINEBOL ─────────── */

  async downloadExcelAndSendToLaravelCinebol(
    fecha?: string,
    skipLaravel: boolean = false,
  ) {
    return this.runWithLock('CINEBOL', async () => {
      try {
        const { page } = await this.ensureSession('CINEBOL');

        const fechaFiltro = fecha || this.getTodayBolivia();
        console.log(
          `🔄 [CINEBOL] Actualizando reporte antes de exportar (Fecha: ${fechaFiltro})...`,
        );
        const updated = await this.updateReportData(page, fechaFiltro);
        if (!updated) {
          console.warn(
            '⚠️ [CINEBOL] No se pudo actualizar el reporte con #fondoreportes, intentando exportar...',
          );
        }

        const tableStatus = await this.hasTableRecords(page, 'CINEBOL');
        if (!tableStatus.hasRecords) {
          console.log(
            `ℹ️ [CINEBOL] No existen registros en la tabla para la fecha ${fechaFiltro}. Se omite la descarga de Excel.`,
          );
          return {
            success: false,
            hasRecords: false,
            message: `No existen registros para la fecha ${fechaFiltro}`,
            fechaFiltro,
            registros: 0,
            infoTabla: tableStatus.infoText,
            laravelResponse: null,
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const excelPath = await this.triggerExcelDownload(
          page,
          'ReporteCinebol',
        );

        if (skipLaravel || this.getEnv('SKIP_LARAVEL') === 'true') {
          console.log(
            `💾 [CINEBOL] Modo prueba: Archivo conservado en ${excelPath} (no enviado a Laravel)`,
          );
          return {
            success: true,
            message:
              'Excel descargado exitosamente (modo prueba: no enviado a Laravel)',
            excelPath,
            fechaFiltro,
            laravelResponse: { skipped: true },
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const laravelResponse = await this.sendExcelToLaravel(excelPath);

        return {
          success: true,
          message:
            'Excel descargado y enviado a Laravel exitosamente (usando credenciales Cinebol)',
          excelPath,
          fechaFiltro,
          laravelResponse,
          timestamp: new Date().toISOString(),
          reusedSession: !this.shouldCloseBrowserAfterRun(),
        };
      } catch (error: any) {
        console.error(
          `❌ [CINEBOL] Error durante automatización:`,
          error.message,
        );
        await this.closeSession('CINEBOL');
        throw error;
      } finally {
        if (this.shouldCloseBrowserAfterRun()) {
          await this.closeSession('CINEBOL');
        }
      }
    });
  }

  /* ─────────── MAIN CON FILTRO FECHA (CINEBOL) ─────────── */

  async downloadExcelWithDateFilterCinebol(
    fecha: string,
    skipLaravel: boolean = false,
  ) {
    return this.runWithLock('CINEBOL', async () => {
      try {
        const { page } = await this.ensureSession('CINEBOL');

        console.log(`📅 [FILTER-CINEBOL] Aplicando filtro de fecha: ${fecha}...`);
        const filterApplied = await this.updateReportData(page, fecha);
        if (!filterApplied) {
          throw new Error(
            `No se pudo aplicar el filtro de fecha "${fecha}". Revisa la captura en descargas/.`,
          );
        }

        const tableStatus = await this.hasTableRecords(
          page,
          'ReporteFilterCinebol',
        );
        if (!tableStatus.hasRecords) {
          console.log(
            `ℹ️ [FILTER-CINEBOL] No existen registros en la tabla para la fecha ${fecha}. Se omite la descarga de Excel.`,
          );
          return {
            success: false,
            hasRecords: false,
            message: `No existen registros para la fecha ${fecha}`,
            fechaFiltro: fecha,
            registros: 0,
            infoTabla: tableStatus.infoText,
            laravelResponse: null,
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const excelPath = await this.triggerExcelDownload(
          page,
          'ReporteFilterCinebol',
        );

        if (skipLaravel || this.getEnv('SKIP_LARAVEL') === 'true') {
          console.log(
            `💾 [FILTER-CINEBOL] Modo prueba: Archivo conservado en ${excelPath} (no enviado a Laravel)`,
          );
          return {
            success: true,
            message:
              'Excel descargado con filtro de fecha (modo prueba: no enviado a Laravel)',
            excelPath,
            fechaFiltro: fecha,
            laravelResponse: { skipped: true },
            timestamp: new Date().toISOString(),
            reusedSession: !this.shouldCloseBrowserAfterRun(),
          };
        }

        const laravelResponse = await this.sendExcelToLaravel(excelPath);

        return {
          success: true,
          message:
            'Excel descargado con filtro de fecha y enviado a Laravel exitosamente (usando credenciales Cinebol)',
          excelPath,
          fechaFiltro: fecha,
          laravelResponse,
          timestamp: new Date().toISOString(),
          reusedSession: !this.shouldCloseBrowserAfterRun(),
        };
      } catch (error: any) {
        console.error(
          `❌ [FILTER-CINEBOL] Error durante automatización:`,
          error.message,
        );
        await this.closeSession('CINEBOL');
        throw error;
      } finally {
        if (this.shouldCloseBrowserAfterRun()) {
          await this.closeSession('CINEBOL');
        }
      }
    });
  }

  /* ─────────── RETROCOMPATIBILIDAD ─────────── */

  private async filterByDate(page: Page, fecha: string): Promise<boolean> {
    return this.updateReportData(page, fecha);
  }

  /* ─────────── API PÚBLICA ─────────── */

  setLaravelApiUrl(url: string) {
    this.laravelApiUrl = url;
  }

  getLaravelApiUrl() {
    return this.laravelApiUrl;
  }

  async closeBrowser() {
    console.log('🛑 [CLOSE] Cerrando navegadores...');
    await this.closeSession('MAIN');
    await this.closeSession('ALT');
    await this.closeSession('CINEBOL');
    console.log('✅ [CLOSE] Navegadores cerrados.');
  }

  getSessionStatus() {
    return {
      browserActive: this.browser !== null,
      pageActive: this.page !== null,
      isLoggedIn: this.isLoggedIn,
      currentPageUrl: this.currentPageUrl,
      browserAltActive: this.browserAlt !== null,
      pageAltActive: this.pageAlt !== null,
      isLoggedInAlt: this.isLoggedInAlt,
      currentPageUrlAlt: this.currentPageUrlAlt,
      browserCinebolActive: this.browserCinebol !== null,
      pageCinebolActive: this.pageCinebol !== null,
      isLoggedInCinebol: this.isLoggedInCinebol,
      currentPageUrlCinebol: this.currentPageUrlCinebol,
    };
  }
}
