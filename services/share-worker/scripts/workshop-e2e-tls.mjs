// A fresh certificate for this process's numeric-loopback rehearsal only.
// RFC 5280 v3 profile: no host input, external tools, stored key, or global trust.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  let length = Buffer.from([body.length]);
  if (body.length >= 128) {
    const hex = body.length.toString(16).padStart(Math.ceil(body.length.toString(16).length / 2) * 2, '0');
    const bytes = Buffer.from(hex, 'hex');
    length = Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts) => der(0x30, ...parts);
const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
const octets = value => der(0x04, value);
const critical = der(0x01, Buffer.from([0xff]));
const extension = (id, value, required = false) => sequence(oid(id), ...(required ? [critical] : []), octets(value));

function time(date) {
  const value = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  const utc = date.getUTCFullYear() >= 1950 && date.getUTCFullYear() < 2050;
  return der(utc ? 0x17 : 0x18, Buffer.from(utc ? value.slice(2) : value, 'ascii'));
}

export function localTlsCredentials(now = new Date()) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 1;
  const algorithm = sequence(oid('2a864886f70d01010b'), der(0x05)); // sha256WithRSAEncryption
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('DSH workshop local rehearsal')))));
  const extensions = sequence(
    extension('551d13', sequence(critical, der(0x02, Buffer.from([0]))), true), // CA, pathLen=0
    extension('551d0f', der(0x03, Buffer.from([2, 0xa4])), true), // digitalSignature, keyEncipherment, keyCertSign
    extension('551d25', sequence(oid('2b06010505070301'))), // serverAuth
    extension('551d11', sequence(der(0x87, Buffer.from([127, 0, 0, 1])))), // only this IP SAN
    extension('551d0e', octets(createHash('sha256').update(publicDer).digest().subarray(0, 20))),
  );
  const certificate = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
    sequence(time(new Date(now.getTime() - 5 * 60000)), time(new Date(now.getTime() + 24 * 60 * 60000))),
    name, publicDer, der(0xa3, extensions),
  );
  const signed = sequence(certificate, algorithm, der(0x03, Buffer.from([0]), sign('sha256', certificate, privateKey)));
  const encoded = signed.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}
