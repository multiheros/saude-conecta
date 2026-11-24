local typedefs = require "kong.db.schema.typedefs"

return {
  name = "identidade",
  fields = {
    { consumer = typedefs.no_consumer },
    { protocols = typedefs.protocols_http },
    { config = { type = "record", fields = { { audiencia = { type = "string", required = true } } } } },
  },
}
