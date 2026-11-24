local original = require "kong.plugins.rate-limiting.schema"
local copia = {}
for k, v in pairs(original) do copia[k] = v end
copia.name = "limite-antes"
return copia
