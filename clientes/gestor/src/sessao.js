import { criarApi, criarSessao } from '../../comum/api.js';

export const sessao = criarSessao('saudeconecta-gestor');
export const api = criarApi(sessao);
