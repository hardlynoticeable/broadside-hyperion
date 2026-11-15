/**
 * BROADSIDE HYPERION — Pure-Node X.509 v3 TLS & Certificate Manager
 *
 * Implements pure-Node RFC 5280 X.509 v3 DER certificate generation using ECDSA P-256 (prime256v1)
 * with SHA-256. Zero external dependencies, zero OpenSSL binary calls.
 *
 * Supports inline credentials, disk caching with automatic regeneration on SAN changes or expiry,
 * ephemeral in-memory credentials, and custom path resolution.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const DEFAULT_CERT_DIR = '.certs';

// ---------------------------------------------------------------------------
// DER Encoding Helpers
// ---------------------------------------------------------------------------

function derLength(len) {
  if (len < 128) {
    return Buffer.from([len]);
  } else if (len < 256) {
    return Buffer.from([0x81, len]);
  } else if (len < 65536) {
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    return Buffer.from([
      0x83,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
}

function derTag(tag, ...contents) {
  const buf = Buffer.concat(contents.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return Buffer.concat([Buffer.from([tag]), derLength(buf.length), buf]);
}

function derSeq(...contents) {
  return derTag(0x30, ...contents);
}

function derSet(...contents) {
  return derTag(0x31, ...contents);
}

function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const octets = [];
    octets.push(val & 0x7f);
    val = Math.floor(val / 128);
    while (val > 0) {
      octets.unshift((val & 0x7f) | 0x80);
      val = Math.floor(val / 128);
    }
    bytes.push(...octets);
  }
  return derTag(0x06, Buffer.from(bytes));
}

function derInteger(bufOrNum) {
  let buf;
  if (typeof bufOrNum === 'number') {
    if (bufOrNum === 0) return Buffer.from([0x02, 0x01, 0x00]);
    const bytes = [];
    let n = bufOrNum;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    }
    if (bytes[0] & 0x80) bytes.unshift(0x00);
    buf = Buffer.from(bytes);
  } else {
    buf = bufOrNum;
    while (buf.length > 1 && buf[0] === 0 && !(buf[1] & 0x80)) {
      buf = buf.subarray(1);
    }
    if (buf[0] & 0x80) {
      buf = Buffer.concat([Buffer.from([0x00]), buf]);
    }
  }
  return derTag(0x02, buf);
}

function derBitString(buf) {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derOctetString(buf) {
  return derTag(0x04, buf);
}

function derPrintableOrUtf8String(str) {
  return derTag(0x0c, Buffer.from(str, 'utf8'));
}

function derTime(date) {
  const year = date.getUTCFullYear();
  const pad = n => String(n).padStart(2, '0');
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  if (year < 2050) {
    const yy = String(year).slice(-2);
    const str = yy + mm + dd + hh + min + ss + 'Z';
    return derTag(0x17, Buffer.from(str, 'ascii'));
  } else {
    const str = String(year) + mm + dd + hh + min + ss + 'Z';
    return derTag(0x18, Buffer.from(str, 'ascii'));
  }
}

function parseIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(n => parseInt(n, 10));
    if (parts.length === 4 && parts.every(n => n >= 0 && n <= 255)) {
      return Buffer.from(parts);
    }
  } else if (version === 6) {
    let norm = ip;
    const pctIdx = norm.indexOf('%');
    if (pctIdx !== -1) norm = norm.substring(0, pctIdx);

    const parts = norm.split('::');
    let left = parts[0] ? parts[0].split(':') : [];
    let right = parts[1] ? parts[1].split(':') : [];

    let ipv4Tail = null;
    const lastPart = (right.length > 0 ? right[right.length - 1] : left[left.length - 1]) || '';
    if (lastPart.includes('.')) {
      const v4Parts = lastPart.split('.').map(n => parseInt(n, 10));
      if (v4Parts.length === 4 && v4Parts.every(n => n >= 0 && n <= 255)) {
        ipv4Tail = Buffer.from(v4Parts);
        if (right.length > 0) right.pop();
        else left.pop();
      }
    }

    const needed16Bits = ipv4Tail ? 6 : 8;
    const missing = needed16Bits - (left.length + right.length);
    const middle = [];
    for (let i = 0; i < missing; i++) middle.push('0');
    const hextets = parts.length > 1 ? [...left, ...middle, ...right] : left;

    const buf = Buffer.alloc(16);
    for (let i = 0; i < needed16Bits; i++) {
      buf.writeUInt16BE(parseInt(hextets[i] || '0', 16), i * 2);
    }
    if (ipv4Tail) {
      ipv4Tail.copy(buf, 12);
    }
    return buf;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Self-Signed X.509 v3 Certificate Generation
// ---------------------------------------------------------------------------

/**
 * Generates an RFC 5280 X.509 v3 self-signed certificate using ECDSA P-256 (prime256v1) and SHA-256.
 *
 * @param {object} [options={}]
 * @param {string} [options.commonName='BROADSIDE HYPERION LAN']
 * @param {string[]} [options.dnsNames=['localhost']]
 * @param {string[]} [options.ipAddresses=['127.0.0.1', '::1']]
 * @param {number} [options.validityDays=365]
 * @returns {{ key: string, cert: string, fingerprint256: string }}
 */
export function generateSelfSignedCertificate(options = {}) {
  const commonName = options.commonName || 'BROADSIDE HYPERION LAN';
  const dnsNames = options.dnsNames || ['localhost'];
  const ipAddresses = options.ipAddresses || ['127.0.0.1', '::1'];
  const validityDays = typeof options.validityDays === 'number' ? options.validityDays : 365;

  // 1. Generate ECDSA P-256 keypair
  const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spkiDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });

  // 2. Version: v3 -> [0] EXPLICIT INTEGER 2
  const version = derTag(0xa0, derInteger(2));

  // 3. Serial Number: positive 16 CSPRNG bytes with leading bit >= 1
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] = (serialBytes[0] & 0x7f) | 0x01;
  const serialNumber = derInteger(serialBytes);

  // 4. Signature Algorithm Identifier: ecdsa-with-SHA256 (1.2.840.10045.4.3.2) - NO NULL param
  const sigAlg = derSeq(derOid('1.2.840.10045.4.3.2'));

  // 5. Issuer and Subject: CN = commonName
  const name = derSeq(derSet(derSeq(derOid('2.5.4.3'), derPrintableOrUtf8String(commonName))));
  const issuer = name;
  const subject = name;

  // 6. Validity
  const now = Date.now();
  const notBefore = new Date(now - 60 * 1000);
  const notAfter = new Date(now + validityDays * 86400 * 1000);
  const validity = derSeq(derTime(notBefore), derTime(notAfter));

  // 7. Extensions
  // basicConstraints: critical: true, SEQUENCE { cA BOOLEAN FALSE }
  const extBasicConstraints = derSeq(
    derOid('2.5.29.19'),
    derTag(0x01, Buffer.from([0xff])),
    derOctetString(Buffer.from([0x30, 0x03, 0x01, 0x01, 0x00]))
  );

  // keyUsage: critical: true, BIT STRING digitalSignature (0x03 0x02 0x07 0x80)
  const extKeyUsage = derSeq(
    derOid('2.5.29.15'),
    derTag(0x01, Buffer.from([0xff])),
    derOctetString(Buffer.from([0x03, 0x02, 0x07, 0x80]))
  );

  // extKeyUsage: id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
  const extExtKeyUsage = derSeq(
    derOid('2.5.29.37'),
    derOctetString(derSeq(derOid('1.3.6.1.5.5.7.3.1')))
  );

  // subjectAltName: deduplicated DNS + IPs
  const dedupeDns = Array.from(new Set(['localhost', ...dnsNames]));
  const dedupeIps = Array.from(new Set(['127.0.0.1', '::1', ...ipAddresses]));

  const sanEntries = [];
  for (const dns of dedupeDns) {
    if (dns) {
      sanEntries.push(derTag(0x82, Buffer.from(dns, 'ascii')));
    }
  }
  for (const ip of dedupeIps) {
    if (ip) {
      const ipBuf = parseIp(ip);
      if (ipBuf) {
        sanEntries.push(derTag(0x87, ipBuf));
      }
    }
  }

  const extSubjectAltName = derSeq(
    derOid('2.5.29.17'),
    derOctetString(derSeq(...sanEntries))
  );

  const extensions = derTag(0xa3, derSeq(extBasicConstraints, extKeyUsage, extExtKeyUsage, extSubjectAltName));

  // 8. Construct TBSCertificate
  const tbsDer = derSeq(
    version,
    serialNumber,
    sigAlg,
    issuer,
    validity,
    subject,
    spkiDer,
    extensions
  );

  // 9. Sign TBSCertificate with ECDSA P-256 private key
  const signature = crypto.sign('sha256', tbsDer, keyPair.privateKey);

  // 10. Wrap in outer Certificate SEQUENCE
  const certDer = derSeq(tbsDer, sigAlg, derBitString(signature));
  const b64 = certDer.toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;

  const x509 = new crypto.X509Certificate(certPem);
  return {
    key: keyPem,
    cert: certPem,
    fingerprint256: x509.fingerprint256,
  };
}

// ---------------------------------------------------------------------------
// SAN and Validity Verification
// ---------------------------------------------------------------------------

/**
 * Checks whether an existing PEM certificate is valid (not expired within 24h)
 * and contains all required DNS names and IP addresses in its Subject Alternative Name extension.
 *
 * @param {string} certPem
 * @param {string[]} [requiredDns=['localhost']]
 * @param {string[]} [requiredIps=['127.0.0.1']]
 * @returns {boolean}
 */
export function hasMatchingSanAndValidity(certPem, requiredDns = ['localhost'], requiredIps = ['127.0.0.1']) {
  try {
    if (!certPem || typeof certPem !== 'string') return false;
    const cert = new crypto.X509Certificate(certPem);
    const validToDate = new Date(cert.validTo);
    if (isNaN(validToDate.getTime())) return false;
    if (validToDate.getTime() <= Date.now() + 86400_000) {
      return false;
    }

    const sanEntriesSet = new Set(
      (cert.subjectAltName || '')
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
    );

    if (Array.isArray(requiredDns)) {
      for (const dns of requiredDns) {
        if (!dns) continue;
        if (!cert.checkHost(dns) && !sanEntriesSet.has(`DNS:${dns}`)) {
          return false;
        }
      }
    }

    if (Array.isArray(requiredIps)) {
      for (const ip of requiredIps) {
        if (!ip) continue;
        if (!cert.checkIP(ip) && !sanEntriesSet.has(`IP Address:${ip}`)) {
          return false;
        }
      }
    }

    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TLS Credentials Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves TLS credentials from inline options, custom paths, ephemeral generation,
 * or disk-cached certificate in DEFAULT_CERT_DIR.
 *
 * @param {boolean|object} [httpsOption={}]
 * @param {object} [context={}]
 * @param {string[]} [context.lanAddresses]
 * @param {object} [context.env]
 * @returns {{ key: string, cert: string, source: string, fingerprint256: string, keyPath?: string, certPath?: string }}
 */
export function ensureTlsCredentials(httpsOption = {}, context = {}) {
  const opts = typeof httpsOption === 'object' && httpsOption !== null ? httpsOption : {};
  const env = context.env || process.env;
  const lanAddresses = Array.isArray(context.lanAddresses) ? context.lanAddresses : [];

  // 1. Inline key and cert
  if (opts.key && opts.cert) {
    const certStr = String(opts.cert);
    const keyStr = String(opts.key);
    const x509 = new crypto.X509Certificate(certStr);
    return {
      key: keyStr,
      cert: certStr,
      source: 'inline',
      fingerprint256: x509.fingerprint256,
    };
  }

  // 2. Custom file paths (options or env vars)
  const customKeyPath = opts.keyPath || env.SSL_KEY_PATH;
  const customCertPath = opts.certPath || env.SSL_CERT_PATH;
  if ((customKeyPath && !customCertPath) || (!customKeyPath && customCertPath)) {
    throw new Error(
      'Incomplete TLS path configuration: both keyPath and certPath (or SSL_KEY_PATH and SSL_CERT_PATH) must be provided'
    );
  }
  if (customKeyPath && customCertPath) {
    if (!fs.existsSync(customKeyPath)) {
      throw new Error(`TLS private key file not found: ${customKeyPath}`);
    }
    if (!fs.existsSync(customCertPath)) {
      throw new Error(`TLS certificate file not found: ${customCertPath}`);
    }
    const key = fs.readFileSync(customKeyPath, 'utf8');
    const cert = fs.readFileSync(customCertPath, 'utf8');
    const x509 = new crypto.X509Certificate(cert);
    return {
      key,
      cert,
      keyPath: customKeyPath,
      certPath: customCertPath,
      source: 'custom',
      fingerprint256: x509.fingerprint256,
    };
  }

  // Common SANs for ephemeral or disk-cached generation
  const requiredDns = Array.from(new Set(['localhost', ...(opts.dnsNames || [])]));
  const requiredIps = Array.from(new Set(['127.0.0.1', '::1', ...lanAddresses, ...(opts.ipAddresses || [])]));

  // 3. Ephemeral in-memory certificate
  if (opts.persist === false) {
    const generated = generateSelfSignedCertificate({
      commonName: opts.commonName,
      dnsNames: requiredDns,
      ipAddresses: requiredIps,
      validityDays: opts.validityDays,
    });
    return {
      key: generated.key,
      cert: generated.cert,
      source: 'ephemeral',
      fingerprint256: generated.fingerprint256,
    };
  }

  // 4. Disk-cached or generated in certDir
  const certDir = opts.certDir || env.SSL_CERT_DIR || path.resolve(process.cwd(), DEFAULT_CERT_DIR);
  const keyPath = path.join(certDir, 'localhost-key.pem');
  const certPath = path.join(certDir, 'localhost-cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const existingCert = fs.readFileSync(certPath, 'utf8');
      if (hasMatchingSanAndValidity(existingCert, requiredDns, requiredIps)) {
        const existingKey = fs.readFileSync(keyPath, 'utf8');
        const x509 = new crypto.X509Certificate(existingCert);
        return {
          key: existingKey,
          cert: existingCert,
          keyPath,
          certPath,
          source: 'cached',
          fingerprint256: x509.fingerprint256,
        };
      }
    } catch (e) {
      // Fall through to regeneration on read/parse error
    }
  }

  // Generate new certificate and persist to certDir
  const generated = generateSelfSignedCertificate({
    commonName: opts.commonName,
    dnsNames: requiredDns,
    ipAddresses: requiredIps,
    validityDays: opts.validityDays,
  });

  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, generated.key, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(certPath, generated.cert, { encoding: 'utf8', mode: 0o644 });

  return {
    key: generated.key,
    cert: generated.cert,
    keyPath,
    certPath,
    source: 'generated',
    fingerprint256: generated.fingerprint256,
  };
}
