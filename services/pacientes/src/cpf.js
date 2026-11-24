// Valida os digitos verificadores.
function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  return [9, 10].every((n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * (n + 1 - i);
    return ((soma * 10) % 11) % 10 === Number(cpf[n]);
  });
}
// Completa 9 digitos com os verificadores (usado so para dados ficticios).
function completarCpf(base) {
  let cpf = base;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * (n + 1 - i);
    cpf += ((soma * 10) % 11) % 10;
  }
  return cpf;
}
module.exports = { cpfValido, completarCpf };
