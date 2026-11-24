const { scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const deriva = promisify(scrypt);

async function gerarHash(senha) {
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('hex')}$${(await deriva(senha, sal, 32)).toString('hex')}`;
}
async function conferir(senha, guardado) {
  const [, sal, hash] = guardado.split('$');
  return timingSafeEqual(await deriva(senha, Buffer.from(sal, 'hex'), 32), Buffer.from(hash, 'hex'));
}
module.exports = { gerarHash, conferir };
