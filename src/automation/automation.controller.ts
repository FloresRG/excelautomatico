import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { AuthTokenGuard } from '../auth/auth.guard';
import { 
  ApiTags, 
  ApiOperation, 
  ApiResponse, 
  ApiBody, 
  ApiBearerAuth 
} from '@nestjs/swagger';
import { AutomationService } from './automation.service';

@ApiTags('automatización')
@Controller('automation')
@UseGuards(AuthTokenGuard)
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  @Post('configure-laravel-url')
  @ApiOperation({ 
    summary: 'Configurar URL de Laravel',
    description: 'Establece la URL base del backend Laravel donde se enviarán los archivos Excel descargados'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        url: { 
          type: 'string', 
          description: 'URL completa del endpoint Laravel para recibir Excel',
          example: 'http://localhost:3000/api/movimientos/importar-desde-nestjs' 
        },
        auth_token: {
          type: 'string',
          description: 'Token de autenticación único',
          example: ''
        }
      },
      required: ['url', 'auth_token'],
    },
  })
  @ApiResponse({ 
    status: 200, 
    description: 'URL configurada exitosamente',
    schema: {
      example: { 
        success: true, 
        message: 'URL de Laravel configurada exitosamente',
        url: 'http://localhost:3000/api/movimientos/importar-desde-nestjs'
      }
    }
  })
  configureLaravelUrl(@Body() body: { url: string; auth_token: string }) {
    if (!body.url) {
      return {
        success: false,
        message: 'El campo "url" es requerido'
      };
    }

    this.automationService.setLaravelApiUrl(body.url);
    return {
      success: true,
      message: 'URL de Laravel configurada exitosamente',
      url: this.automationService.getLaravelApiUrl()
    };
  }

  @Post('download-and-send')
  @ApiOperation({ 
    summary: 'Descargar Excel y enviar a Laravel',
    description: 'Ejecuta el proceso completo de automatización: inicia sesión en BCP Bolivia, descarga archivo Excel con movimientos y lo envía al backend Laravel configurado'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        auth_token: {
          type: 'string',
          description: 'Token de autenticación único',
          example: ''
        },
        fecha: {
          type: 'string',
          description: 'Fecha opcional en formato YYYY-MM-DD. Si no se envía, usa la fecha de hoy en Bolivia.',
          example: '2026-10-08'
        }
      },
      required: ['auth_token'],
    },
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Proceso completado exitosamente',
    schema: {
      example: { 
        success: true, 
        message: 'Excel descargado y enviado a Laravel exitosamente',
        excelPath: '/ruta/descargas/Reporte_1234567890.xlsx',
        laravelResponse: {
          success: true,
          message: 'Archivo procesado correctamente',
          registros: 45
        },
        timestamp: '2024-01-15T10:30:00.000Z',
        reusedSession: true
      }
    }
  })
  async downloadAndSendToLaravel(@Body() body: { auth_token: string; fecha?: string }) {
    return this.automationService.downloadExcelAndSendToLaravel(body?.fecha);
  }

  @Get('session-status')
  @ApiOperation({ 
    summary: 'Verificar estado de sesión',
    description: 'Comprueba el estado actual de la sesión de Playwright: si el navegador está activo, si hay página abierta y si la sesión está iniciada'
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Estado actual de la sesión',
    schema: {
      example: { 
        success: true,
        browserActive: true,
        pageActive: true,
        isLoggedIn: true,
        currentPageUrl: 'https://apppro.bcp.com.bo/Multiplica/Dashboard    ',
        message: 'Sesión activa y lista para descargar'
      }
    }
  })
  getSessionStatus() {
    const status = this.automationService.getSessionStatus();
    return {
      success: true,
      ...status,
      message: status.isLoggedIn ? 'Sesión activa y lista para descargar' : 'Sesión no iniciada'
    };
  }

  @Post('close-browser')
  @ApiOperation({ 
    summary: 'Cerrar navegador manualmente',
    description: 'Cierra la instancia del navegador Playwright y limpia la sesión. Útil para liberar recursos o reiniciar la sesión'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        auth_token: {
          type: 'string',
          description: 'Token de autenticación único',
          example: ''
        }
      },
      required: ['auth_token'],
    },
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Navegador cerrado exitosamente',
    schema: {
      example: { 
        success: true, 
        message: 'Navegador cerrado exitosamente' 
      }
    }
  })
  async closeBrowser(@Body() body: { auth_token: string }) {
    await this.automationService.closeBrowser();
    return {
      success: true,
      message: 'Navegador cerrado exitosamente'
    };
  }

  // NUEVO ENDPOINT ALTERNATIVO
  @Post('download-and-send-alt')
  @ApiOperation({ 
    summary: 'Descargar Excel y enviar a Laravel (endpoint alternativo)',
    description: 'Endpoint alternativo que ejecuta el mismo proceso de automatización pero con credenciales diferentes para el login'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        auth_token: {
          type: 'string',
          description: 'Token de autenticación único',
          example: ''
        },
        fecha: {
          type: 'string',
          description: 'Fecha opcional en formato YYYY-MM-DD. Si no se envía, usa la fecha de hoy en Bolivia.',
          example: '2026-10-08'
        }
      },
      required: ['auth_token'],
    },
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Proceso completado exitosamente',
    schema: {
      example: { 
        success: true, 
        message: 'Excel descargado y enviado a Laravel exitosamente (usando credenciales alternativas)',
        excelPath: '/ruta/descargas/Reporte_1234567890.xlsx',
        laravelResponse: {
          success: true,
          message: 'Archivo procesado correctamente',
          registros: 45
        },
        timestamp: '2024-01-15T10:30:00.000Z',
        reusedSession: true
      }
    }
  })
  async downloadAndSendToLaravelAlt(@Body() body: { auth_token: string; fecha?: string }) {
    console.log('🆕 [API] Endpoint alternativo ejecutado con credenciales diferentes');
    return this.automationService.downloadExcelAndSendToLaravelAlt(body?.fecha);
  }

  // ENDPOINT CON FILTRO DE FECHA
  @Post('download-with-date-filter')
  @ApiOperation({ 
    summary: 'Descargar Excel con filtro de fecha (CajaLive)',
    description: 'Ejecuta el proceso de automatización con credenciales de CajaLive114559, filtra los datos por la fecha especificada, actualiza el reporte y luego descarga el Excel'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fecha: { 
          type: 'string', 
          description: 'Fecha para filtrar el reporte en formato YYYY-MM-DD',
          example: '2026-02-26' 
        },
        auth_token: {
          type: 'string',
          description: 'Token de autenticación único',
          example: ''
        }
      },
      required: ['fecha', 'auth_token'],
    },
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Proceso completado exitosamente con filtro de fecha',
    schema: {
      example: { 
        success: true, 
        message: 'Excel descargado con filtro de fecha y enviado a Laravel exitosamente',
        excelPath: '/ruta/descargas/ReporteFilter_1234567890.xlsx',
        fechaFiltro: '2026-02-26',
        laravelResponse: {
          success: true,
          message: 'Archivo procesado correctamente',
          registros: 45
        },
        timestamp: '2024-01-15T10:30:00.000Z',
        reusedSession: false
      }
    }
  })
  async downloadWithDateFilter(@Body() body: { fecha: string; auth_token: string }) {
    if (!body.fecha) {
      return {
        success: false,
        message: 'El campo "fecha" es requerido en formato YYYY-MM-DD'
      };
    }
    console.log('📅 [API] Descarga con filtro de fecha ejecutada');
    return this.automationService.downloadExcelWithDateFilter(body.fecha);
  }
}
