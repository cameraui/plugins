import crypto from 'node:crypto';

if (!crypto.getCiphers().includes('chacha20-poly1305')) {
  try {
    // Lazy-import: only load the chacha polyfill when native support is missing
    // (e.g. Electron with a stripped OpenSSL build). Avoids Buffer() deprecation
    // warning on platforms that don't need it.

    const chacha = require('chacha');

    const originalGetCiphers = crypto.getCiphers;
    const originalCreateCipheriv = crypto.createCipheriv;
    const originalCreateDecipheriv = crypto.createDecipheriv;

    crypto.getCiphers = (): string[] => {
      const ciphers = originalGetCiphers();
      ciphers.push('chacha20-poly1305');
      return ciphers;
    };

    crypto.createCipheriv = (algorithm: any, key: any, iv: any, options: any) => {
      if (algorithm !== 'chacha20-poly1305') {
        return originalCreateCipheriv(algorithm, key, iv, options);
      } else {
        return chacha.createCipher(key, iv);
      }
    };

    crypto.createDecipheriv = (algorithm: any, key: any, iv: any, options?: any) => {
      if (algorithm !== 'chacha20-poly1305') {
        return originalCreateDecipheriv(algorithm, key, iv, options);
      } else {
        return chacha.createDecipher(key, iv);
      }
    };
  } catch (error) {
    console.error('Failed to load chacha module:', error);
  }
}
