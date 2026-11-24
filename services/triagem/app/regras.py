"""Classificacao por regras: sinais de alarme e queixas comuns.

Conservadora de proposito: na duvida, AMARELO. Nao diagnostica nem substitui o profissional.
"""

import re
import unicodedata

NIVEIS = ["VERMELHO", "LARANJA", "AMARELO", "VERDE", "AZUL"]

# (nivel, padrao, motivo). Texto ja normalizado: minusculas e sem acentos.
SINAIS = [
    ("VERMELHO", r"(nao consig\w+|dificuldade para|sem conseguir) respirar", "dificuldade respiratoria grave"),
    ("VERMELHO", r"falta de ar (intensa|forte|muito forte|grave)", "falta de ar intensa"),
    ("VERMELHO", r"inconsciente|desacordad\w|desmai\w+ e nao acord\w+", "perda de consciencia"),
    ("VERMELHO", r"convuls\w+|convulsionand\w", "convulsao"),
    ("VERMELHO", r"hemorragia|sangramento (intenso|que nao para)|sangrando muito", "sangramento intenso"),
    ("VERMELHO", r"boca torta|fala (enrolada|arrastada)|fraqueza (de|em) um lado|rosto torto", "sinais de AVC"),
    ("VERMELHO", r"(quero|penso em|pensando em|vontade de) (me matar|morrer|tirar minha vida)|suicid\w+", "risco de suicidio"),
    ("LARANJA", r"dor (forte )?no peito|aperto no peito|dor toracica", "dor toracica"),
    ("LARANJA", r"falta de ar", "falta de ar"),
    ("LARANJA", r"vomit\w+ (com )?sangue|sangue nas fezes|fezes pretas", "sangramento digestivo"),
    ("LARANJA", r"gravid\w+.*sangra\w+|sangra\w+.*gravid\w+", "sangramento na gestacao"),
    ("LARANJA", r"rigidez (na|de) nuca|pescoco duro", "rigidez de nuca"),
    ("LARANJA", r"confus\w+ mental|desorientad\w", "confusao mental"),
    ("AMARELO", r"febre (alta|de 39|de 40|ha (3|4|5|varios) dias|ha tres dias)", "febre alta ou persistente"),
    ("AMARELO", r"dor (muito )?(forte|intensa|insuportavel)", "dor intensa"),
    ("AMARELO", r"vomitando|vomitos? (persistentes?|ha|repetidos?)|desidratad\w|boca seca", "risco de desidratacao"),
    ("AMARELO", r"queimadura|ferida (aberta|infeccionada)|pressao (muito )?alta", "lesao ou alteracao a avaliar"),
    ("AZUL", r"renova\w+ (de |da |a |minha )*receita|check.?up|rotina|exame de rotina|atestado|preventivo|resultado de exame", "demanda administrativa ou preventiva"),
    ("VERDE", r"tosse|coriza|nariz (entupido|escorrendo)|resfriado|gripe|dor de garganta|garganta", "sintoma respiratorio leve"),
    ("VERDE", r"dor (nas costas|lombar|de cabeca|muscular|no joelho|de ouvido|na barriga)|diarreia|coceira|mancha|alergia|azia|febre", "queixa sem sinal de alarme"),
]
_SINAIS = [(n, re.compile(p), m) for n, p, m in SINAIS]
# A conjuncao interrompe a negacao: "sem febre mas falta de ar" NAO nega a falta de ar.
_NEGACAO = re.compile(r"\b(sem|nem|nao tenho|nao tem|nao sinto|nao estou com|nega|nunca tive)(\s+(?!mas\b|porem\b|e\b|com\b|so\b|tenho\b|sinto\b)\w+){0,2}\s*$")

ESPECIALIDADE_GINECOLOGIA = re.compile(r"gravid\w+|gestante|menstrua\w+|preventivo|corrimento|pre.?natal")


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFD", texto.lower())
    return re.sub(r"\s+", " ", "".join(c for c in sem_acento if unicodedata.category(c) != "Mn")).strip()


def classificar(sintomas: str, idade: int | None = None) -> dict:
    texto = normalizar(sintomas)
    achados = []
    for nivel, padrao, motivo in _SINAIS:
        for m in padrao.finditer(texto):
            # "sem febre", "nao tenho falta de ar": a queixa foi negada.
            if nivel != "AZUL" and not m.group().startswith(("nao consig", "sem conseguir")) and _NEGACAO.search(texto[: m.start()]):
                continue
            achados.append((nivel, motivo))
            break
    if idade is not None and idade < 1 and re.search(r"febre", texto):
        achados.append(("LARANJA", "febre em menor de 1 ano"))
    if achados:
        nivel, motivo = min(achados, key=lambda a: NIVEIS.index(a[0]))
        justificativa = f"Regra: {motivo}."
    else:
        nivel, justificativa = "AMARELO", "Regra: queixa nao reconhecida; nivel conservador."
    return {"classificacao": nivel, "justificativa": justificativa, "especialidadeSugerida": especialidade(texto, idade)}


def especialidade(texto_normalizado: str, idade: int | None) -> str:
    if idade is not None and idade < 12:
        return "Pediatria"
    if ESPECIALIDADE_GINECOLOGIA.search(texto_normalizado):
        return "Ginecologia"
    return "Clínica Geral"
