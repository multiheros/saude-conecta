import { expect, test } from '@playwright/test';
import { conferirTela, entrar, GESTORA, PACIENTE, triar } from './apoio.js';

test('login: senha errada, perfil errado e entrada', async ({ page }) => {
  await page.goto('/');
  await conferirTela(page, 'paciente-login');
  await entrar(page, '/', PACIENTE, 'senha-errada');
  await expect(page.getByRole('alert')).toContainText('CPF ou senha incorretos');
  await entrar(page, '/', GESTORA);
  await expect(page.getByRole('alert')).toContainText('/painel');
  await entrar(page, '/', '100.000.001-08'); // com pontuacao
  await expect(page.getByRole('heading', { name: /^Olá/ })).toBeVisible();
  await conferirTela(page, 'paciente-inicio');
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Olá/ })).toBeVisible(); // continua logado na aba
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
});

test('fluxo completo: triagem, agendamento, confirmar, trocar e cancelar', async ({ page }) => {
  const erros = [];
  page.on('console', (m) => m.type() === 'error' && erros.push(m.text()));
  page.on('pageerror', (e) => erros.push(e.message));
  await entrar(page, '/', PACIENTE);
  await triar(page, 'dor de garganta há dois dias, sem falta de ar');
  await expect(page.getByText('Pode aguardar a consulta')).toBeVisible();
  await expect(page.getByRole('radio').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agendar' })).toBeDisabled();
  await conferirTela(page, 'paciente-triagem');
  await page.getByRole('button', { name: 'Ver mais horários' }).click();
  await expect.poll(() => page.getByRole('radio').count()).toBeGreaterThan(3);
  await page.getByRole('radio').nth(5).check();
  await page.getByRole('button', { name: 'Agendar' }).click();

  await expect(page.getByRole('heading', { name: 'Consulta marcada' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('list', { name: 'Etapas do agendamento' }).getByText('concluído')).toHaveCount(4);
  await conferirTela(page, 'paciente-andamento');
  await page.getByRole('link', { name: 'Ver a consulta' }).click();
  await expect(page.locator('.etiqueta')).toHaveText('Agendado');
  await conferirTela(page, 'paciente-detalhe');

  await page.getByRole('button', { name: 'Confirmar presença' }).click();
  await expect(page.locator('.etiqueta')).toHaveText('Presença confirmada');
  await expect(page.getByRole('button', { name: 'Confirmar presença' })).toHaveCount(0); // a acao some com o link

  const antes = await page.locator('dd').first().textContent();
  if (await page.getByRole('button', { name: 'Trocar o horário' }).count()) {
    await page.getByRole('button', { name: 'Trocar o horário' }).click();
    await page.getByRole('radio').nth(9).check();
    await page.getByRole('button', { name: 'Trocar', exact: true }).click();
    await expect(page.locator('dd').first()).not.toHaveText(antes);
  }
  await page.getByRole('button', { name: 'Cancelar consulta' }).click();
  await page.getByRole('button', { name: 'Sim, cancelar' }).click();
  await expect(page.locator('.etiqueta')).toHaveText('Cancelado');
  await expect(page.getByRole('button', { name: 'Cancelar consulta' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Consultas', exact: true }).click();
  await expect(page.locator('.consulta').first()).toContainText('Cancelado');
  expect(erros).toEqual([]);
});

test('emergência não agenda e mostra o 192', async ({ page }) => {
  await entrar(page, '/', PACIENTE);
  await triar(page, 'não consigo respirar direito desde agora');
  await expect(page.getByRole('link', { name: 'Ligar para o 192' })).toHaveAttribute('href', 'tel:192');
  await expect(page.getByRole('button', { name: 'Agendar' })).toHaveCount(0);
  await conferirTela(page, 'paciente-emergencia');
});

test('texto curto é barrado na tela e sessão inválida volta ao login', async ({ page }) => {
  await entrar(page, '/', PACIENTE);
  await triar(page, 'dor');
  await expect(page.getByLabel('O que você está sentindo?')).toBeFocused();
  await expect(page.locator('.resultado')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem('saudeconecta-paciente', 'lixo'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
});

test('clicar duas vezes em Agendar não marca duas consultas', async ({ page }) => {
  await entrar(page, '/', PACIENTE);
  await triar(page, 'tosse e coriza há dois dias');
  await page.getByRole('radio').last().check();
  const pedidos = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/web/v1/agendamentos') && pedidos.push(r.headers()['idempotency-key']));
  await page.getByRole('button', { name: 'Agendar' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Consulta marcada' })).toBeVisible({ timeout: 30000 });
  expect(new Set(pedidos).size).toBe(1);
  await page.getByRole('link', { name: 'Ver a consulta' }).click();
  await page.getByRole('button', { name: 'Cancelar consulta' }).click();
  await page.getByRole('button', { name: 'Sim, cancelar' }).click();
  await expect(page.locator('.etiqueta')).toHaveText('Cancelado');
});

for (const largura of [320, 768]) {
  test(`sem rolagem lateral em ${largura}px, e no tema escuro`, async ({ page }) => {
    await page.setViewportSize({ width: largura, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await entrar(page, '/', PACIENTE);
    await triar(page, 'dor de ouvido leve desde ontem');
    await expect(page.getByRole('radio').first()).toBeVisible();
    await conferirTela(page, `paciente-escuro-${largura}`);
  });
}
