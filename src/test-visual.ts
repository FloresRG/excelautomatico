process.env.HEADLESS = 'false';
process.env.SKIP_LARAVEL = 'true'; // No enviar a Laravel ni borrar archivos durante pruebas

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AutomationService } from './automation/automation.service';

interface TestResult {
  name: string;
  success: boolean;
  file?: string;
  error?: string;
}

async function runVisualTest() {
  console.log('====================================================');
  console.log('🚀 INICIANDO BATERÍA DE PRUEBAS VISUALES BCP');
  console.log('====================================================');
  console.log('👀 El navegador se abrirá en tu pantalla (SlowMo: 400ms).');
  console.log('💡 Modo prueba activo: Los archivos Excel se conservarán en ./descargas');
  console.log('🛡️ No se enviará información al backend de Laravel.\n');

  const app = await NestFactory.createApplicationContext(AppModule);
  const automationService = app.get(AutomationService);

  const testType = process.argv[2] || 'all'; // 'all', 'main', 'alt', 'filter'
  const results: TestResult[] = [];

  try {
    // ────────── TEST 1: FLUJO PRINCIPAL ──────────
    if (testType === 'all' || testType === 'main') {
      console.log('\n====================================================');
      console.log('▶️ [PRUEBA 1/3] Flujo Principal (Usuario: CajaUno11929)');
      console.log('====================================================');
      try {
        const result = await automationService.downloadExcelAndSendToLaravel(undefined, true);
        console.log('🎉 [PRUEBA 1] Éxito:', result.message);
        console.log(`📁 Archivo generado: ${result.excelPath}`);
        results.push({ name: 'Flujo Principal (CajaUno)', success: true, file: result.excelPath });
      } catch (err: any) {
        console.error('❌ [PRUEBA 1] Error en Flujo Principal:', err.message);
        results.push({ name: 'Flujo Principal (CajaUno)', success: false, error: err.message });
      }

      console.log('⏳ Pausa de 5 segundos para visualización...');
      await new Promise((r) => setTimeout(r, 5000));
      await automationService.closeBrowser();
    }

    // ────────── TEST 2: FLUJO ALTERNATIVO ──────────
    if (testType === 'all' || testType === 'alt') {
      console.log('\n====================================================');
      console.log('▶️ [PRUEBA 2/3] Flujo Alternativo (Usuario: CajaLive114559)');
      console.log('====================================================');
      try {
        const result = await automationService.downloadExcelAndSendToLaravelAlt(undefined, true);
        console.log('🎉 [PRUEBA 2] Éxito:', result.message);
        console.log(`📁 Archivo generado: ${result.excelPath}`);
        results.push({ name: 'Flujo Alternativo (CajaLive)', success: true, file: result.excelPath });
      } catch (err: any) {
        console.error('❌ [PRUEBA 2] Error en Flujo Alternativo:', err.message);
        results.push({ name: 'Flujo Alternativo (CajaLive)', success: false, error: err.message });
      }

      console.log('⏳ Pausa de 5 segundos para visualización...');
      await new Promise((r) => setTimeout(r, 5000));
      await automationService.closeBrowser();
    }

    // ────────── TEST 3: FLUJO CON FILTRO DE FECHA ──────────
    if (testType === 'all' || testType === 'filter') {
      const hoy = automationService.getTodayBolivia();
      console.log('\n====================================================');
      console.log(`▶️ [PRUEBA 3/3] Flujo con Filtro de Fecha (${hoy}) (CajaLive)`);
      console.log('====================================================');
      try {
        const result = await automationService.downloadExcelWithDateFilter(hoy, true);
        console.log('🎉 [PRUEBA 3] Éxito:', result.message);
        console.log(`📁 Archivo generado: ${result.excelPath}`);
        results.push({ name: `Filtro de Fecha (${hoy})`, success: true, file: result.excelPath });
      } catch (err: any) {
        console.error('❌ [PRUEBA 3] Error en Flujo con Filtro de Fecha:', err.message);
        results.push({ name: `Filtro de Fecha (${hoy})`, success: false, error: err.message });
      }

      console.log('⏳ Pausa de 5 segundos para visualización...');
      await new Promise((r) => setTimeout(r, 5000));
      await automationService.closeBrowser();
    }

    // ────────── RESUMEN FINAL ──────────
    console.log('\n====================================================');
    console.log('📊 RESUMEN FINAL DE PRUEBAS VISUALES');
    console.log('====================================================');
    results.forEach((res, index) => {
      const statusIcon = res.success ? '✅ ÉXITO' : '❌ FALLÓ';
      console.log(`[${index + 1}] ${res.name}: ${statusIcon}`);
      if (res.file) console.log(`    📁 Archivo: ${res.file}`);
      if (res.error) console.log(`    ⚠️ Error: ${res.error}`);
    });
    console.log('====================================================\n');

  } catch (error: any) {
    console.error('\n❌ [ERROR CRÍTICO GENERAL]:', error.message);
  } finally {
    await automationService.closeBrowser();
    await app.close();
    console.log('🏁 Sesión y aplicación cerradas correctamente.');
  }
}

runVisualTest();
