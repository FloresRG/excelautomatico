import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'playwright';
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
  private readonly excelBtnSelector =
    'button.buttons-excel[title="Exportar a Excel"], button[title="Exportar a Excel"], button.buttons-excel';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn = false;
  private currentPageUrl = '';

  // Variables para la sesión alternativa
  private browserAlt: Browser | null = null;
  private pageAlt: Page | null = null;
  private isLoggedInAlt = false;
  private currentPageUrlAlt = '';

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.downloadPath = path.join(process.cwd(), 'descargas');
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

  private async typeWithDelay(page: Page, selector: string, text: string) {
    await page.fill(selector, text);
  }

  private async simulateHumanBehavior(page: Page) {
    await this.randomDelay(200, 400);
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
      const hasExportBtn =
        (await page.$(this.excelBtnSelector)) !== null;
      return hasExportBtn || currentUrl.toLowerCase().includes('dashboard');
    } catch {
      return false;
    }
  }

  /* ─────────── INIT BROWSER ─────────── */

  private async initializeBrowser(): Promise<{ browser: Browser; page: Page }> {
    const isHeadless = this.getEnv('HEADLESS') === 'true';
    console.log(
      `🚀 [BROWSER] Iniciando Chromium en modo: ${
        isHeadless ? 'HEADLESS (segundo plano)' : 'VISIBLE (en tu pantalla con slowMo 300ms)'
      }`,
    );

    const browser = await chromium.launch({
      headless: isHeadless,
      slowMo: isHeadless ? 0 : 400,
      args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: isHeadless ? { width: 1366, height: 768 } : null,
      locale: 'es-ES',
      timezoneId: 'America/La_Paz',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    if (!isHeadless) {
      await page.bringToFront().catch(() => {});
    }

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
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

      // Verificar selector de usuario
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

      // Verificar selector de contraseña
      console.log('🔍 [LOGIN-MAIN] Buscando campo de contraseña (#authpass)...');
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

      // Click en botón de ingreso
      console.log('🖱️ [LOGIN-MAIN] Buscando botón ingresar (#authbtn)...');
      const btnField = await page
        .waitForSelector('#authbtn', { timeout: 8000 })
        .catch(() => null);

      if (!btnField) {
        console.error('❌ [LOGIN-MAIN] No se encontró el botón "#authbtn"');
        await this.saveDebugSnapshot(page, 'login_main_sin_authbtn');
        return false;
      }

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

      await this.randomDelay(1500, 2500);
      console.log(`📍 [LOGIN-MAIN] URL tras autenticación: ${page.url()}`);

      this.isLoggedIn = true;
      this.currentPageUrl = page.url();

      return true;
    } catch (error: any) {
      console.error('❌ [LOGIN-MAIN] Error durante el proceso de login:', error.message);
      await this.saveDebugSnapshot(page, 'login_main_error');
      return false;
    }
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

      await this.randomDelay(1500, 2500);
      console.log(`📍 [LOGIN-ALT] URL tras autenticación: ${page.url()}`);

      this.isLoggedInAlt = true;
      this.currentPageUrlAlt = page.url();

      return true;
    } catch (error: any) {
      console.error('❌ [LOGIN-ALT] Error durante el proceso de login:', error.message);
      await this.saveDebugSnapshot(page, 'login_alt_error');
      return false;
    }
  }

  /* ─────────── REFRESH ─────────── */

  private async refreshPageForLatestData(page: Page) {
    console.log('🔄 [REFRESH] Actualizando la página para cargar datos frescos...');
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await this.randomDelay(500, 1000);
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
    console.log(`📤 [LARAVEL] Enviando ${excelPath} a ${this.laravelApiUrl}...`);
    const formData = new FormData();
    formData.append('archivo_excel', fs.createReadStream(excelPath));
    formData.append('origen', 'nestjs');

    const response = await axios.post(this.laravelApiUrl, formData, {
      headers: formData.getHeaders(),
      timeout: 30000,
      maxBodyLength: Infinity,
    });

    console.log(`✅ [LARAVEL] Respuesta recibida:`, response.status, response.data);

    // Eliminar archivo después de enviar a Laravel
    await this.deleteFile(excelPath);

    return response.data;
  }

  /* ─────────── MAIN PRINCIPAL ─────────── */

  async downloadExcelAndSendToLaravel() {
    let excelPath = '';

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
        console.log('🔑 [MAIN] Sesión no iniciada o vencida. Realizando login...');
        if (!(await this.performLogin(this.page))) {
          throw new Error('Falló el login con credenciales principales');
        }
      } else {
        await this.refreshPageForLatestData(this.page);
      }
    }

    console.log('🔍 [MAIN] Buscando botón "Exportar a Excel"...');
    const excelBtn = this.excelBtnSelector;
    const foundBtn = await this.page!
      .waitForSelector(excelBtn, { timeout: 20000 })
      .catch(() => null);

    if (!foundBtn) {
      console.error('❌ [MAIN] No se encontró el botón "Exportar a Excel"');
      await this.saveDebugSnapshot(this.page!, 'main_sin_boton_excel');
      throw new Error(
        'No se encontró el botón "Exportar a Excel". Revisa la captura en descargas/ para ver qué muestra la página.',
      );
    }

    console.log('⬇️ [MAIN] Iniciando clic en exportar y esperando descarga...');
    const [download] = await Promise.all([
      this.page!.waitForEvent('download', { timeout: 30000 }),
      this.page!.click(excelBtn),
    ]);

    excelPath = path.join(
      this.downloadPath,
      `Reporte_${Date.now()}.xlsx`,
    );

    await download.saveAs(excelPath);
    console.log(`✅ [MAIN] Archivo descargado exitosamente en: ${excelPath}`);

    const laravelResponse = await this.sendExcelToLaravel(excelPath);

    return {
      success: true,
      message: 'Excel descargado y enviado a Laravel exitosamente',
      excelPath,
      laravelResponse,
      timestamp: new Date().toISOString(),
      reusedSession: this.isLoggedIn,
    };
  }

  /* ─────────── MAIN ALTERNATIVO ─────────── */

  async downloadExcelAndSendToLaravelAlt() {
    let excelPath = '';

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
        console.log('🔑 [ALT] Sesión no iniciada o vencida. Realizando login...');
        if (!(await this.performLoginAlt(this.pageAlt))) {
          throw new Error('Falló el login con credenciales alternativas');
        }
      } else {
        await this.refreshPageForLatestData(this.pageAlt);
      }
    }

    console.log('🔍 [ALT] Buscando botón "Exportar a Excel"...');
    const excelBtn = this.excelBtnSelector;
    const foundBtn = await this.pageAlt!
      .waitForSelector(excelBtn, { timeout: 20000 })
      .catch(() => null);

    if (!foundBtn) {
      console.error('❌ [ALT] No se encontró el botón "Exportar a Excel"');
      await this.saveDebugSnapshot(this.pageAlt!, 'alt_sin_boton_excel');
      throw new Error(
        'No se encontró el botón "Exportar a Excel". Revisa la captura en descargas/ para ver qué muestra la página.',
      );
    }

    console.log('⬇️ [ALT] Iniciando clic en exportar y esperando descarga...');
    const [download] = await Promise.all([
      this.pageAlt!.waitForEvent('download', { timeout: 30000 }),
      this.pageAlt!.click(excelBtn),
    ]);

    excelPath = path.join(
      this.downloadPath,
      `ReporteAlt_${Date.now()}.xlsx`,
    );

    await download.saveAs(excelPath);
    console.log(`✅ [ALT] Archivo descargado exitosamente en: ${excelPath}`);

    const laravelResponse = await this.sendExcelToLaravel(excelPath);

    return {
      success: true,
      message:
        'Excel descargado y enviado a Laravel exitosamente (usando credenciales alternativas)',
      excelPath,
      laravelResponse,
      timestamp: new Date().toISOString(),
      reusedSession: this.isLoggedInAlt,
    };
  }

  /* ─────────── MAIN CON FILTRO FECHA (CAJALIVE) ─────────── */

  async downloadExcelWithDateFilter(fecha: string) {
    let excelPath = '';

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
        console.log('🔑 [FILTER] Sesión no iniciada o vencida. Realizando login...');
        if (!(await this.performLoginAlt(this.pageAlt))) {
          throw new Error('Falló el login con credenciales alternativas');
        }
      } else {
        await this.refreshPageForLatestData(this.pageAlt);
      }
    }

    // Aplicar filtro de fecha antes de descargar
    console.log(`📅 [FILTER] Aplicando filtro de fecha: ${fecha}...`);
    const filterApplied = await this.filterByDate(this.pageAlt!, fecha);
    if (!filterApplied) {
      throw new Error(
        `No se pudo aplicar el filtro de fecha "${fecha}". Revisa la captura en descargas/.`,
      );
    }

    console.log('🔍 [FILTER] Buscando botón "Exportar a Excel"...');
    const excelBtn = this.excelBtnSelector;
    const foundBtn = await this.pageAlt!
      .waitForSelector(excelBtn, { timeout: 20000 })
      .catch(() => null);

    if (!foundBtn) {
      console.error('❌ [FILTER] No se encontró el botón "Exportar a Excel"');
      await this.saveDebugSnapshot(this.pageAlt!, 'filter_sin_boton_excel');
      throw new Error(
        'No se encontró el botón "Exportar a Excel" tras filtrar por fecha.',
      );
    }

    console.log('⬇️ [FILTER] Iniciando clic en exportar y esperando descarga...');
    const [download] = await Promise.all([
      this.pageAlt!.waitForEvent('download', { timeout: 30000 }),
      this.pageAlt!.click(excelBtn),
    ]);

    excelPath = path.join(
      this.downloadPath,
      `ReporteFilter_${Date.now()}.xlsx`,
    );

    await download.saveAs(excelPath);
    console.log(`✅ [FILTER] Archivo descargado exitosamente en: ${excelPath}`);

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

  /* ─────────── FILTRO FECHA ─────────── */

  private async filterByDate(page: Page, fecha: string): Promise<boolean> {
    try {
      console.log('🔍 [DATE] Buscando campo de fecha (#startDate1)...');
      const inputField = await page
        .waitForSelector('#startDate1', { timeout: 10000 })
        .catch(() => null);

      if (!inputField) {
        console.error('❌ [DATE] No se encontró el campo "#startDate1"');
        await this.saveDebugSnapshot(page, 'date_sin_startDate1');
        return false;
      }

      console.log(`✍️ [DATE] Asignando fecha ${fecha} a #startDate1...`);
      await page.evaluate((fechaValue) => {
        const input = document.getElementById(
          'startDate1',
        ) as HTMLInputElement;
        if (input) {
          input.value = fechaValue;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, fecha);

      await this.randomDelay(300, 600);

      console.log('🔘 [DATE] Buscando botón "Actualizar Reporte" (#fondoreportes)...');
      const btnField = await page
        .waitForSelector('#fondoreportes', { timeout: 8000 })
        .catch(() => null);

      if (!btnField) {
        console.error('❌ [DATE] No se encontró el botón "#fondoreportes"');
        await this.saveDebugSnapshot(page, 'date_sin_fondoreportes');
        return false;
      }

      console.log('🖱️ [DATE] Clic en "#fondoreportes"...');
      await page.click('#fondoreportes');

      // Esperar a que la página se actualice
      await this.randomDelay(1500, 2500);

      return true;
    } catch (error: any) {
      console.error('❌ [DATE] Error al filtrar por fecha:', error.message);
      await this.saveDebugSnapshot(page, 'date_error');
      return false;
    }
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
    };
  }
}
