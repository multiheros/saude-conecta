-- O mesmo rate-limiting do Kong, so que ANTES do JWT (prioridade 1450): token invalido tambem consome a cota do
-- IP, e o gateway nao gasta criptografia com quem ja passou do limite. A original roda depois (910).
-- Os arquivos das telas (rotas "tela-...") nao contam: sao publicos, e uma visita pede varios.
local RateLimiting = require "kong.plugins.rate-limiting.handler"

local LimiteAntes = { VERSION = RateLimiting.VERSION, PRIORITY = 2000 }

function LimiteAntes:access(conf)
  local rota = kong.router.get_route()
  if rota and rota.name and rota.name:sub(1, 5) == "tela-" then
    return
  end
  return RateLimiting.access(self, conf)
end

return LimiteAntes
