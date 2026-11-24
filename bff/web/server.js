const express = require('express');
const os = require('os');

const PORT = process.env.PORT || 3001;
const PACIENTES = process.env.PACIENTES_URL || 'http://pacientes:8001';
const AGENDAMENTO = process.env.AGENDAMENTO_URL || 'http://agendamento:8002';
const UBS_PADRAO = 'a1000000-0000-4000-8000-000000000001'; // provisorio: vira a UBS do paciente logado

const app = express();

app.get(['/live', '/ready'], (_req, res) => res.json({ service: 'bff-web', status: 'ok', instance: os.hostname() }));

// BFF do paciente: dados simples, pessoais e acionaveis.
// O gateway remove o prefixo /web/v1 (strip_path), entao a rota aqui e /home.
app.get('/home', async (_req, res) => {
  try {
    const [p, s] = await Promise.all([
      fetch(`${PACIENTES}/api/v1/pacientes/1`).then((r) => r.json()),
      fetch(`${AGENDAMENTO}/api/v1/slots?ubsId=${UBS_PADRAO}`).then((r) => r.json()),
    ]);
    res.json({
      cliente: 'web',
      paciente: { nome: p.nome, ubs: p.ubs },
      horariosLivres: s.slice(0, 5),
      atendidoPor: os.hostname(),
    });
  } catch (e) {
    res.status(502).json({ title: 'Servico indisponivel', status: 502 });
  }
});

app.listen(PORT, () => console.log(`bff-web ouvindo na porta ${PORT}`));
