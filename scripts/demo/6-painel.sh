#!/usr/bin/env bash
# Cena 6: o mesmo dominio, duas respostas. O painel e agregado e sem dado pessoal.
. "$(dirname "$0")/_comum.sh"
n "Cena 6. Dois BFFs"
passo "bff-web: um agendamento, pronto para a tela do paciente"
pac GET /web/v1/agendamentos | bonito "(()=>{const a=j.items[0];return a?JSON.stringify({titulo:a.titulo,quando:a.quando,onde:a.onde,status:a.statusTexto,acoes:Object.keys(a._links)},null,2):'  (nenhum agendamento)'})()"
passo "bff-admin: a unidade inteira, so numeros"
R=$(ges GET "/admin/v1/agendamentos/resumo?ubsId=$UBS&periodo=$(date +%Y-%m)")
bonito "JSON.stringify({ubs:j.ubs.nome,capacidade:j.capacidade,porStatus:j.porStatus,porUrgencia:j.porUrgencia,absenteismo:j.absenteismo,alertas:(j.alertas||[]).length,parcial:j.parcial},null,2)" <<< "$R"
igual "campos pessoais no painel" "$(grep -ciE 'cpf|email|telefone|pacienteId|pacienteNome' <<< "$R")" 0
passo "Perfil trocado"
igual "paciente no painel" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PAC" "$G/admin/v1/unidades")" 403
igual "sem token" "$(curl -s -o /dev/null -w '%{http_code}' "$G/admin/v1/unidades")" 401
