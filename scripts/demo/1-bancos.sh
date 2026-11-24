#!/usr/bin/env bash
# Cena 1: bancos separados por servico, e ninguem alcanca o banco alheio.
. "$(dirname "$0")/_comum.sh"
n "Cena 1. Bancos separados por servico"
passo "Uma consulta em cada banco, com a credencial do proprio dono"
echo "  Pacientes     PostgreSQL  $(dc exec -T db-pacientes psql -qtA -U "${PACIENTES_DB_USER:-pacientes}" -d pacientes -c "SELECT count(*)||' pacientes' FROM pacientes")"
echo "  Agendamento   PostgreSQL  $(sql "SELECT count(*)||' horarios' FROM slots" -qtA)"
echo "  Agendamento   MongoDB     $(mongo "print(db.ocupacao_ubs.countDocuments()+' dias projetados')")"
echo "  Agendamento   Redis       $(dc exec -T cache-agendamento redis-cli dbsize) chave(s) de vagas"
echo "  Triagem       MongoDB     $(mongot "print(db.triagens.countDocuments()+' triagens')")"
echo "  Triagem       ChromaDB    $(dc exec -T triagem python -c "from app.rag import ingestao; from app.rag.vetores import Vetores; v=Vetores(); print(v.contar(v.colecao(ingestao.nome_colecao())['id']), 'trechos')")"
echo "  Notificacoes  Redis       $(dc exec -T db-notificacoes redis-cli dbsize) chaves"
pausa
passo "Pacientes tenta abrir conexao com cada banco dos outros"
for h in db-agendamento:5432 db-agendamento-leitura:27017 cache-agendamento:6379 db-triagem:27017 db-triagem-vetores:8000 db-notificacoes:6379; do
  r=$(dc exec -T pacientes node -e "const s=require('net').connect({host:'${h%:*}',port:${h#*:},timeout:2000});const f=(t)=>{console.log(t);process.exit()};s.on('connect',()=>f('ABERTA'));s.on('error',()=>f('bloqueada'));s.on('timeout',()=>f('bloqueada'))")
  igual "pacientes -> ${h%:*}" "$r" bloqueada
done
igual "controle, pacientes -> db-pacientes" "$(dc exec -T pacientes node -e "const s=require('net').connect({host:'db-pacientes',port:5432,timeout:2000});const f=(t)=>{console.log(t);process.exit()};s.on('connect',()=>f('ABERTA'));s.on('error',()=>f('bloqueada'))")" ABERTA
