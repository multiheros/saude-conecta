import { criarApi, criarSessao } from '../../comum/api.js';

export const sessao = criarSessao('saudeconecta-paciente');
export const api = criarApi(sessao);
