// src/auth/auth.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    
    // Obtener token del header Authorization o del body
    const authHeader = request.headers.authorization;
    const tokenFromBody = request.body?.auth_token;
    
    const token = authHeader 
      ? authHeader.replace('Bearer ', '') 
      : tokenFromBody;

    const validToken = this.configService.get<string>('AUTH_TOKEN');
    
    if (validToken) {
      if (!token) {
        throw new UnauthorizedException('Token de autenticación requerido');
      }
      if (token !== validToken) {
        throw new UnauthorizedException('Token de autenticación inválido');
      }
    }

    return true;
  }
}