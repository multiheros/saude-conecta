-- O mesmo rate-limiting do Kong, so que ANTES do JWT (prioridade 1450): token invalido tambem consome a cota do
-- IP, e o gateway nao gasta criptografia com quem ja passou do limite. A original roda depois (910).
local RateLimiting = require "kong.plugins.rate-limiting.handler"

return { VERSION = RateLimiting.VERSION, PRIORITY = 2000, access = RateLimiting.access }
