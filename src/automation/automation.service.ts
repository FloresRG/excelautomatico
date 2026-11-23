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

  /* ─────────── CHECK LOGIN ─────────── */

  private async isAlreadyLoggedIn(page: Page): Promise<boolean> {
    try {
      const currentUrl = page.url();
      const hasExportBtn = (await page.$(this.excelBtnSelector)) !== null;
      return hasExportBtn || currentUrl.toLowerCase().includes('dashboard');
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

  /* ─────────── MAIN PRINCIPAL ─────────── */

  async downloadExcelAndSendToLaravel(
    fecha?: string,
    skipLaravel: boolean = false,
  ) {
    if (!this.browser || !this.page) {
      console.log('🆕 [MAIN] Iniciando nueva sesión del navegador...');
      const init = await this.initializeBrowser();
      this.browser = init.browser;
      this.page = init.page;

      if (!(await this.performLogin(this.page))) {
        throw new Error('Falló el login con credenciales principales');
      }
    } else {
      console.log('♻️ [MAIN] Reutilizando navegador existente...');
      if (!(await this.isAlreadyLoggedIn(this.page))) {
        console.log(
          '🔑 [MAIN] Sesión no iniciada o vencida. Realizando login...',
        );
        if (!(await this.performLogin(this.page))) {
          throw new Error('Falló el login con credenciales principales');
        }
      } else {
        await this.refreshPageForLatestData(this.page);
      }
    }

    const fechaFiltro = fecha || this.getTodayBolivia();
    console.log(
      `🔄 [MAIN] Actualizando reporte antes de exportar (Fecha: ${fechaFiltro})...`,
    );
    const updated = await this.updateReportData(this.page, fechaFiltro);
    if (!updated) {
      console.warn(
        '⚠️ [MAIN] No se pudo actualizar el reporte con #fondoreportes, intentando exportar...',
      );
    }

    const excelPath = await this.triggerExcelDownload(this.page, 'Reporte');

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
        reusedSession: this.isLoggedIn,
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
      reusedSession: this.isLoggedIn,
    };
  }

  /* ─────────── MAIN ALTERNATIVO ─────────── */

  async downloadExcelAndSendToLaravelAlt(
    fecha?: string,
    skipLaravel: boolean = false,
  ) {
    if (!this.browserAlt || !this.pageAlt) {
      console.log('🆕 [ALT] Iniciando nueva sesión del navegador (Alt)...');
      const init = await this.initializeBrowser();
      this.browserAlt = init.browser;
      this.pageAlt = init.page;

      if (!(await this.performLoginAlt(this.pageAlt))) {
        throw new Error('Falló el login con credenciales alternativas');
      }
    } else {
      console.log('♻️ [ALT] Reutilizando navegador existente (Alt)...');
      if (!(await this.isAlreadyLoggedIn(this.pageAlt))) {
        console.log(
          '🔑 [ALT] Sesión no iniciada o vencida. Realizando login...',
        );
        if (!(await this.performLoginAlt(this.pageAlt))) {
          throw new Error('Falló el login con credenciales alternativas');
        }
      } else {
        await this.refreshPageForLatestData(this.pageAlt);
      }
    }

    const fechaFiltro = fecha || this.getTodayBolivia();
    console.log(
      `🔄 [ALT] Actualizando reporte antes de exportar (Fecha: ${fechaFiltro})...`,
    );
    const updated = await this.updateReportData(this.pageAlt, fechaFiltro);
    if (!updated) {
      console.warn(
        '⚠️ [ALT] No se pudo actualizar el reporte con #fondoreportes, intentando exportar...',
      );
    }

    const excelPath = await this.triggerExcelDownload(
      this.pageAlt,
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
        reusedSession: this.isLoggedInAlt,
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
      reusedSession: this.isLoggedInAlt,
    };
  }

  /* ─────────── MAIN CON FILTRO FECHA (CAJALIVE) ─────────── */

  async downloadExcelWithDateFilter(
    fecha: string,
    skipLaravel: boolean = false,
  ) {
    if (!this.browserAlt || !this.pageAlt) {
      console.log('🆕 [FILTER] Iniciando nueva sesión con filtro de fecha...');
      const init = await this.initializeBrowser();
      this.browserAlt = init.browser;
      this.pageAlt = init.page;

      if (!(await this.performLoginAlt(this.pageAlt))) {
        throw new Error('Falló el login con credenciales alternativas');
      }
    } else {
      console.log('♻️ [FILTER] Reutilizando navegador existente...');
      if (!(await this.isAlreadyLoggedIn(this.pageAlt))) {
        console.log(
          '🔑 [FILTER] Sesión no iniciada o vencida. Realizando login...',
        );
        if (!(await this.performLoginAlt(this.pageAlt))) {
          throw new Error('Falló el login con credenciales alternativas');
        }
      } else {
        await this.refreshPageForLatestData(this.pageAlt);
      }
    }

    console.log(`📅 [FILTER] Aplicando filtro de fecha: ${fecha}...`);
    const filterApplied = await this.updateReportData(this.pageAlt, fecha);
    if (!filterApplied) {
      throw new Error(
        `No se pudo aplicar el filtro de fecha "${fecha}". Revisa la captura en descargas/.`,
      );
    }

    const excelPath = await this.triggerExcelDownload(
      this.pageAlt,
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
        reusedSession: this.isLoggedInAlt,
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
      reusedSession: this.isLoggedInAlt,
    };
  }

  /* ─────────── MAIN CINEBOL ─────────── */

  async downloadExcelAndSendToLaravelCinebol(
    fecha?: string,
    skipLaravel: boolean = false,
  ) {
    if (!this.browserCinebol || !this.pageCinebol) {
      console.log(
        '🆕 [CINEBOL] Iniciando nueva sesión del navegador (Cinebol)...',
      );
      const init = await this.initializeBrowser();
      this.browserCinebol = init.browser;
      this.pageCinebol = init.page;

      if (!(await this.performLoginCinebol(this.pageCinebol))) {
        throw new Error('Falló el login con credenciales de Cinebol');
      }
    } else {
      console.log('♻️ [CINEBOL] Reutilizando navegador existente (Cinebol)...');
      if (!(await this.isAlreadyLoggedIn(this.pageCinebol))) {
        console.log(
          '🔑 [CINEBOL] Sesión no iniciada o vencida. Realizando login...',
        );
        if (!(await this.performLoginCinebol(this.pageCinebol))) {
          throw new Error('Falló el login con credenciales de Cinebol');
        }
      } else {
        await this.refreshPageForLatestData(this.pageCinebol);
      }
    }

    const fechaFiltro = fecha || this.getTodayBolivia();
    console.log(
      `🔄 [CINEBOL] Actualizando reporte antes de exportar (Fecha: ${fechaFiltro})...`,
    );
    const updated = await this.updateReportData(this.pageCinebol, fechaFiltro);
    if (!updated) {
      console.warn(
        '⚠️ [CINEBOL] No se pudo actualizar el reporte con #fondoreportes, intentando exportar...',
      );
    }

    const excelPath = await this.triggerExcelDownload(
      this.pageCinebol,
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
        reusedSession: this.isLoggedInCinebol,
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
      reusedSession: this.isLoggedInCinebol,
    };
  }

  /* ─────────── MAIN CON FILTRO FECHA (CINEBOL) ─────────── */

  async downloadExcelWithDateFilterCinebol(
    fecha: string,
    skipLaravel: boolean = false,
  ) {
    if (!this.browserCinebol || !this.pageCinebol) {
      console.log(
        '🆕 [FILTER-CINEBOL] Iniciando nueva sesión con filtro de fecha...',
      );
      const init = await this.initializeBrowser();
      this.browserCinebol = init.browser;
      this.pageCinebol = init.page;

      if (!(await this.performLoginCinebol(this.pageCinebol))) {
        throw new Error('Falló el login con credenciales de Cinebol');
      }
    } else {
      console.log('♻️ [FILTER-CINEBOL] Reutilizando navegador existente...');
      if (!(await this.isAlreadyLoggedIn(this.pageCinebol))) {
        console.log(
          '🔑 [FILTER-CINEBOL] Sesión no iniciada o vencida. Realizando login...',
        );
        if (!(await this.performLoginCinebol(this.pageCinebol))) {
          throw new Error('Falló el login con credenciales de Cinebol');
        }
      } else {
        await this.refreshPageForLatestData(this.pageCinebol);
      }
    }

    console.log(`📅 [FILTER-CINEBOL] Aplicando filtro de fecha: ${fecha}...`);
    const filterApplied = await this.updateReportData(this.pageCinebol, fecha);
    if (!filterApplied) {
      throw new Error(
        `No se pudo aplicar el filtro de fecha "${fecha}". Revisa la captura en descargas/.`,
      );
    }

    const excelPath = await this.triggerExcelDownload(
      this.pageCinebol,
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
        reusedSession: this.isLoggedInCinebol,
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
      reusedSession: this.isLoggedInCinebol,
    };
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
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      this.isLoggedIn = false;
    }

    if (this.browserAlt) {
      await this.browserAlt.close().catch(() => {});
      this.browserAlt = null;
      this.pageAlt = null;
      this.isLoggedInAlt = false;
    }

    if (this.browserCinebol) {
      await this.browserCinebol.close().catch(() => {});
      this.browserCinebol = null;
      this.pageCinebol = null;
      this.isLoggedInCinebol = false;
    }
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
