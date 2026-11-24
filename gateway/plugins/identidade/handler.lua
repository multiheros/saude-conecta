-- Identidade que os servicos recebem. Roda depois do JWT (1450) e do ACL (950), em toda rota:
--   1. descarta X-User-Id e X-User-Role vindos do cliente;
--   2. se houve JWT valido, confere aud e sub e injeta a identidade a partir dele.
-- Tambem deixa os erros do proprio gateway no formato RFC 7807, igual aos servicos.
local cjson = require "cjson.safe"
local jwt_parser = require "kong.plugins.jwt.jwt_parser"

local TITULOS = {
  [400] = "Requisicao invalida", [401] = "Nao autenticado", [403] = "Sem permissao", [404] = "Rota nao encontrada",
  [413] = "Corpo grande demais", [429] = "Limite de requisicoes excedido",
  [502] = "Servico indisponivel", [503] = "Servico indisponivel", [504] = "Servico nao respondeu a tempo",
}
local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

local Identidade = { VERSION = "1.0.0", PRIORITY = 900 }

function Identidade:access(conf)
  kong.service.request.clear_header("X-User-Id")
  kong.service.request.clear_header("X-User-Role")
  kong.service.request.clear_header("Authorization") -- o token nao precisa passar daqui

  local consumidor, token = kong.client.get_consumer(), kong.ctx.shared.authenticated_jwt_token
  if not consumidor or not token then
    return
  end
  local jwt = jwt_parser:new(token)
  local claims = jwt and jwt.claims or {}
  if claims.aud ~= conf.audiencia or type(claims.sub) ~= "string" or not claims.sub:match(UUID) then
    return kong.response.exit(401)
  end
  kong.service.request.set_header("X-User-Id", claims.sub:lower())
  -- O perfil vem do emissor, que escolheu a chave: nao da para trocar o perfil sem quebrar a assinatura.
  kong.service.request.set_header("X-User-Role", consumidor.username)
end

function Identidade:header_filter()
  local status = kong.response.get_status()
  if status >= 400 and kong.response.get_source() ~= "service" then
    kong.ctx.plugin.problema = cjson.encode({
      type = "about:blank", title = TITULOS[status] or "Erro", status = status,
      correlationId = kong.request.get_header("X-Correlation-Id") or kong.response.get_header("X-Correlation-Id"),
    })
    kong.response.set_header("Content-Type", "application/problem+json")
    kong.response.clear_header("Content-Length")
  end
end

function Identidade:body_filter()
  local problema = kong.ctx.plugin.problema
  if problema then
    ngx.arg[1] = ngx.arg[2] and problema or nil
  end
end

return Identidade
