// Erro de negocio com status HTTP; vira application/problem+json (RFC 7807).
class Problema extends Error {
  constructor(status, title, detail) {
    super(detail || title);
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}
module.exports = { Problema };
