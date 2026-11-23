// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { AuthTokenGuard } from './auth.guard';

@Module({
  providers: [AuthTokenGuard],
  exports: [AuthTokenGuard],
})
export class AuthModule {}
