import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 45000,
  expect: { timeout: 15000 },
  workers: 1, // os testes compartilham a agenda
  retries: 0,
  reporter: 'list',
  outputDir: '/saida/resultados',
  use: { baseURL: process.env.BASE || 'http://gateway:8000', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', screenshot: 'only-on-failure' },
  projects: [
    { name: 'paciente', testMatch: 'paciente.spec.js', use: { ...devices['Pixel 7'] } },
    { name: 'gestor', testMatch: 'gestor.spec.js', use: { ...devices['Desktop Chrome'] } },
    { name: 'falha', testMatch: 'falha.spec.js', use: { ...devices['Pixel 7'] } },
  ],
});
