import { expect, test } from '@playwright/test';
import { conferirTela, entrar, GESTORA, PACIENTE } from './apoio.js';

test('paciente não entra no painel', async ({ page }) => {
  await entrar(page, '/painel', PACIENTE);
  await expect(page.getByRole('alert')).toContainText('só para gestores');
});

test('painel: números, gráficos, filtros e nada de dado pessoal', async ({ page }) => {
  const erros = [], corpos = [];
  page.on('pageerror', (e) => erros.push(e.message));
  page.on('response', async (r) => { if (r.url().includes('/admin/v1/agendamentos')) corpos.push(await r.text().catch(() => '')); });
  await entrar(page, '/painel', GESTORA);
  await expect(page.getByText('Ocupação', { exact: true })).toBeVisible();
  for (const t of ['Agendamentos por dia', 'Por urgência', 'Por situação', 'Ocupação por especialidade', 'Saúde da triagem por IA', 'Alertas de lotação']) await expect(page.getByRole('heading', { name: t })).toBeVisible();
  await expect(page.locator('.grande').first()).toHaveText(/%$/);
  const coluna = page.locator('.coluna').first();
  await coluna.focus();
  await expect(page.locator('.dica')).toContainText('agendados'); // leitura tambem pelo teclado
  await page.getByText('Ver em tabela').click();
  expect(await page.getByRole('row').count()).toBe((await page.locator('.coluna').count()) + 1);
  await conferirTela(page, 'gestor-painel');
  const antes = await page.locator('.numero').first().textContent();
  await page.getByLabel('Unidade').selectOption({ label: 'UBS Jardim Norte' });
  await expect(page.locator('.numero').first()).not.toHaveText(antes);
  expect(corpos.join('')).not.toMatch(/cpf|email|telefone|pacienteId|pacienteNome/i);
  expect(erros).toEqual([]);
});

test('criar escala aumenta a capacidade', async ({ page }) => {
  await entrar(page, '/painel', GESTORA);
  await page.getByLabel('Dia da semana').selectOption({ label: 'Sábado' });
  await page.getByRole('button', { name: 'Criar escala' }).click();
  await expect(page.getByText(/Escala criada: \d+ horários novos|Nenhum horário novo/)).toBeVisible();
  await page.getByLabel('Início').fill('18:00'); // depois do fim
  await page.getByRole('button', { name: 'Criar escala' }).click();
  await expect(page.getByRole('alert')).toContainText('horaInicio');
});

test('tema escuro e tela estreita', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await entrar(page, '/painel', GESTORA);
  await expect(page.locator('.numero').first()).toBeVisible();
  await conferirTela(page, 'gestor-escuro');
});
