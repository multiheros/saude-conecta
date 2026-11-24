import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

export const PACIENTE = '10000000108', GESTORA = '90000000175', SENHA = process.env.SEED_SENHA || 'demo12345';
export async function entrar(page, caminho, cpf, senha = SENHA) {
  await page.goto(caminho);
  await page.getByLabel('CPF').fill(cpf);
  await page.getByLabel('Senha').fill(senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
// Sem violacao de acessibilidade grave e sem rolagem horizontal.
export async function conferirTela(page, nome) {
  await page.screenshot({ path: `/saida/${nome}.png`, fullPage: true });
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`), nome).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `rolagem em ${nome}`).toBeLessThanOrEqual(0);
}
export async function triar(page, sintomas) {
  await page.getByRole('link', { name: 'Nova consulta' }).click();
  await page.getByLabel('O que você está sentindo?').fill(sintomas);
  await page.getByRole('button', { name: 'Continuar' }).click();
}
