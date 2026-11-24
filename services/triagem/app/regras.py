"""Classificacao por regras: sinais de alarme e queixas comuns.

Conservadora de proposito: na duvida, AMARELO. Nao diagnostica nem substitui o profissional.
"""

import re
import unicodedata

NIVEIS = ["VERMELHO", "LARANJA", "AMARELO", "VERDE", "AZUL"]

# (nivel, padrao, motivo). Texto ja normalizado: minusculas e sem acentos.
SINAIS = [
    ("VERMELHO", r"(nao consig\w+|dificuldade para|sem conseguir) respirar", "dificuldade respiratória grave"),
    ("VERMELHO", r"falta de ar (intensa|forte|muito forte|grave)", "falta de ar intensa"),
    # Dor no peito com irradiacao ou suor frio, em qualquer ordem: suspeita de infarto.
    ("VERMELHO", r"(dor|aperto|peso|pressao|queimacao)\b.{0,25}\bpeito\b.*(braco|queixo|mandibula|pescoco|suando|suor|suo\b)|(suando frio|suor frio|suando gelado).*(aperto|dor|peso).{0,25}peito", "dor no peito com sinais de infarto"),
    ("VERMELHO", r"(lingua|garganta|boca).{0,20}(inchando|inchad\w|fechando).*(ar|respirar|rouc\w|voz)|(rouc\w|falta de ar).*(lingua|garganta).{0,20}inchad?\w*", "reação alérgica grave"),
    ("VERMELHO", r"(tomou|tomei|engoliu|engoli|bebeu|bebi)\b.{0,40}(cartela|varios|muitos|veneno|produto de limpeza|agua sanitaria|soda).*(dorm\w+|sonolent\w|acordar|mole|desmai\w+|confus\w)|mal consigo acordar|nao (consigo acordar|acorda\b)", "intoxicação ou rebaixamento da consciência"),
    ("VERMELHO", r"espumando|se debatendo|tremendo todo no chao|revirando os olhos", "convulsão"),
    ("VERMELHO", r"inconsciente|desacordad\w|desmai\w+ e nao acord\w+", "perda de consciência"),
    ("VERMELHO", r"convuls\w+|convulsionand\w", "convulsão"),
    ("VERMELHO", r"hemorragia|sangramento (intenso|que nao para)|sangrando muito", "sangramento intenso"),
    ("VERMELHO", r"boca torta|fala (enrolada|arrastada)|fraqueza (de|em) um lado|rosto torto", "sinais de AVC"),
    ("VERMELHO", r"(quero|penso em|pensando em|vontade de) (me matar|morrer|tirar minha vida)|suicid\w+", "risco de suicídio"),
    ("LARANJA", r"dor (forte )?no peito|aperto no peito|dor toracica", "dor no peito"),
    ("LARANJA", r"falta de ar", "falta de ar"),
    ("LARANJA", r"\bchia(do|ndo)\b|cansad\w (para|pra) respirar", "chiado ou cansaço para respirar"),
    ("VERMELHO", r"pressao.*(vista|visao).{0,15}(embac\w+|turv\w)|(vista|visao).{0,15}(embac\w+|turv\w).*pressao", "pressão alta com alteração da visão"),
    ("LARANJA", r"vomit\w+ (com )?sangue|sangue nas fezes|fezes pretas", "sangramento digestivo"),
    ("LARANJA", r"gravid\w+.*sangra\w+|sangra\w+.*gravid\w+", "sangramento na gestação"),
    ("LARANJA", r"rigidez (na|de) nuca|pescoco duro", "rigidez de nuca"),
    ("LARANJA", r"confus\w+ mental|desorientad\w|\bconfus[oa]\b", "confusão mental"),
    ("LARANJA", r"peso no peito|peso no meio do peito|pressao no peito", "dor no peito"),
    ("LARANJA", r"dormen\w+ entre as (pernas|coxas)|dormente entre as|nao (consigo )?segur\w+ (mais )?(o |a )?(xixi|urina|fezes|coco)", "possível compressão de nervos da coluna"),
    ("LARANJA", r"(queim\w+|quente|fervendo).{0,40}\b(rosto|face|olho|olhos)\b|\b(rosto|face)\b.{0,40}(queim\w+|fervendo)", "queimadura no rosto"),
    ("LARANJA", r"(tomou|tomei|engoliu|engoli|bebeu|bebi)\b.{0,40}(cartela|varios comprimidos|muitos comprimidos|veneno|produto de limpeza|agua sanitaria|soda)", "possível intoxicação"),
    ("LARANJA", r"(diarreia|vomit\w+).*(molinh\w|prostrad\w|sem lagrima|nao sai lagrima|nao quer beber|olhos fundos)", "sinais de desidratação"),
    ("AMARELO", r"mordid\w|mordeu|(cao|cachorro|gato|morcego|macaco)\b.{0,30}(avancou|atacou|arranhou)", "agressão por animal"),
    ("AMARELO", r"(gravid\w|gestante|meses de gestacao).*(dor|doendo|doi)|(dor|doendo).*(gravid\w|gestante)", "dor na gestação"),
    ("AMARELO", r"(urin\w+|xixi).*(febre|calafrio)|(febre|calafrio).*(urin\w+|xixi)", "sintoma urinário com febre"),
    ("AMARELO", r"me bateu|me agrediu|apanhei|me empurrou|violencia|abus\w+ sexual", "violência"),
    ("AMARELO", r"febre (alta|de 39|de 40|ha (3|4|5|varios) dias|ha tres dias)", "febre alta ou persistente"),
    ("AMARELO", r"dor (muito )?(forte|intensa|insuportavel)", "dor intensa"),
    ("AMARELO", r"vomitando|vomitos? (persistentes?|ha|repetidos?)|desidratad\w|boca seca", "risco de desidratação"),
    ("AMARELO", r"queimadura|ferida (aberta|infeccionada)|pressao (muito )?alta", "lesão ou alteração a avaliar"),
    ("AZUL", r"renova\w+ (de |da |a |minha )*receita|check.?up|rotina|exame de rotina|atestado|preventivo|resultado de exame", "demanda administrativa ou preventiva"),
    ("VERDE", r"tosse|coriza|nariz (entupido|escorrendo)|resfriado|gripe|dor de garganta|garganta", "sintoma respiratório leve"),
    ("VERDE", r"dor (nas costas|lombar|de cabeca|muscular|no joelho|de ouvido|na barriga)|diarreia|coceira|mancha|alergia|azia|febre", "queixa sem sinal de alarme"),
]
_SINAIS = [(n, re.compile(p), m) for n, p, m in SINAIS]
# A conjuncao interrompe a negacao: "sem febre mas falta de ar" NAO nega a falta de ar.
_NEGACAO = re.compile(r"\b(sem|nem|nao tenho|nao tem|nao sinto|nao estou com|nega|nunca tive)(\s+(?!mas\b|porem\b|e\b|com\b|so\b|tenho\b|sinto\b)\w+){0,2}\s*$")

ESPECIALIDADE_GINECOLOGIA = re.compile(r"gravid\w+|gestante|menstrua\w+|preventivo|corrimento|pre.?natal")


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFD", texto.lower())
    return re.sub(r"\s+", " ", "".join(c for c in sem_acento if unicodedata.category(c) != "Mn")).strip()


def sinais(sintomas: str, idade: int | None = None) -> list[tuple[str, str]]:
    """(nivel, motivo) de cada sinal reconhecido e não negado."""
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
    return achados


def classificar(sintomas: str, idade: int | None = None) -> dict:
    achados = sinais(sintomas, idade)
    if achados:
        nivel, motivo = min(achados, key=lambda a: NIVEIS.index(a[0]))
        justificativa = f"Pelas regras de triagem: {motivo}."
        febre = re.search(r"\bfebre\b", normalizar(sintomas))
        if nivel == "VERDE" and febre and not _NEGACAO.search(normalizar(sintomas)[: febre.start()]):
            # Sem o modelo, nao da para separar a febre banal da que acompanha algo grave.
            nivel, justificativa = "AMARELO", f"Pelas regras de triagem: {motivo}, com febre."
    else:
        nivel, justificativa = "AMARELO", "Pelas regras de triagem: queixa não reconhecida, então foi usado um nível de cautela."
    return {"classificacao": nivel, "justificativa": justificativa, "especialidadeSugerida": especialidade(normalizar(sintomas), idade)}


def especialidade(texto_normalizado: str, idade: int | None) -> str:
    if idade is not None and idade < 12:
        return "Pediatria"
    if ESPECIALIDADE_GINECOLOGIA.search(texto_normalizado):
        return "Ginecologia"
    return "Clínica Geral"
