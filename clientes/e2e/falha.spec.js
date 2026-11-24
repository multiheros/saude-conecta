// Rodado pelo scripts/verificar_telas.sh com o servico de Notificacoes desligado.
import { expect, test } from '@playwright/test';
import { conferirTela, entrar, GESTORA, PACIENTE, triar } from './apoio.js';

test('a compensação aparece na tela e o horário volta a ficar livre', async ({ page }) => {
  test.setTimeout(120000);
  await entrar(page, '/', PACIENTE);
  await triar(page, 'dor de garganta há dois dias');
  const primeiro = await page.getByRole('radio').first().getAttribute('value');
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Agendar' }).click();
  await expect(page.getByRole('heading', { name: 'Não foi possível marcar' })).toBeVisible({ timeout: 90000 });
  const etapas = page.getByRole('list', { name: 'Etapas do agendamento' });
  await expect(etapas.getByText('desfeito')).toHaveCount(3);
  await expect(etapas.getByText('não deu certo')).toHaveCount(1);
  await expect(page.getByText('Nada ficou reservado')).toBeVisible();
  await conferirTela(page, 'paciente-compensacao');
  await page.getByRole('link', { name: 'Tentar de novo' }).click();
  await triar(page, 'dor de garganta há dois dias');
  await expect(page.locator(`input[value="${primeiro}"]`)).toBeVisible();
});

test('painel avisa que os dados são parciais', async ({ page }) => {
  await entrar(page, '/painel', GESTORA);
  await expect(page.getByText('Dados parciais.')).toBeVisible();
  await expect(page.locator('section', { hasText: 'Alertas de lotação' }).getByText('Indisponível agora.')).toBeVisible();
  await conferirTela(page, 'gestor-parcial');
});
