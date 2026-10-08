import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AutomationService } from './automation/automation.service';

async function runVisualTest() {
  console.log('====================================================');
  console.log('🚀 INICIANDO PRUEBA VISUAL DE AUTOMATIZACIÓN BCP');
  console.log('====================================================');
  console.log('👀 El navegador se abrirá MAXIMIZADO en tu pantalla.');
  console.log('🔎 Observa los campos y la navegación en vivo.\n');

  const app = await NestFactory.createApplicationContext(AppModule);
  const automationService = app.get(AutomationService);

  const testType = process.argv[2] || 'main'; // 'main', 'alt' o 'filter'

  try {
    if (testType === 'main') {
      console.log('▶️ [PRUEBA] Ejecutando Flujo Principal (CajaUno11929)...');
      const result = await automationService.downloadExcelAndSendToLaravel();
      console.log('🎉 Resultado exitoso:', result);
    } else if (testType === 'alt') {
      console.log('▶️ [PRUEBA] Ejecutando Flujo Alternativo (CajaLive114559)...');
      const result = await automationService.downloadExcelAndSendToLaravelAlt();
      console.log('🎉 Resultado exitoso:', result);
    } else if (testType === 'filter') {
      const hoy = new Date().toISOString().split('T')[0];
      console.log(`▶️ [PRUEBA] Ejecutando Flujo con Filtro de Fecha (${hoy})...`);
      const result = await automationService.downloadExcelWithDateFilter(hoy);
      console.log('🎉 Resultado exitoso:', result);
    }

    console.log('\n======================================================');
    console.log('👀 ¡ATENCIÓN! EL NAVEGADOR ESTÁ ABIERTO EN TU PANTALLA');
    console.log('👉 Puedes mirar la página, hacer clic o inspeccionar (F12).');
    console.log('⏳ Se mantendrá abierto durante 3 minutos (180 segundos)...');
    console.log('👉 Presiona Ctrl+C en cualquier momento para terminar antes.');
    console.log('======================================================\n');
    await new Promise((resolve) => setTimeout(resolve, 180000));

  } catch (error: any) {
    console.error('\n❌ [ERROR DETECTADO DURANTE LA PRUEBA]:');
    console.error(error.message);
    console.log('\n💡 El navegador permanecerá abierto para que puedas ver el error en pantalla.');
    console.log('📁 Revisa también las capturas y HTML generados en la carpeta "descargas/".');
    console.log('⏳ Se mantendrá abierto 2 minutos...');
    await new Promise((resolve) => setTimeout(resolve, 120000));
  } finally {
    console.log('\n🛑 Cerrando sesión...');
    await automationService.closeBrowser();
    await app.close();
    console.log('🏁 Proceso finalizado.');
  }
}

runVisualTest();
