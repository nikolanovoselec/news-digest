// Tests for src/lib/ssrf.ts — REQ-DISC-005 (discovery prompt injection protection
// via SSRF filter) and REQ-GEN-003 (source fan-out, HTTPS-only, no private ranges).
import { describe, it, expect } from 'vitest';
import { isUrlSafe } from '~/lib/ssrf';

describe('isUrlSafe', () => {
  describe('scheme enforcement', () => {
    it('REQ-DISC-005: rejects http:// URLs', () => {
      expect(isUrlSafe('http://example.com')).toBe(false);
      expect(isUrlSafe('http://example.com/path')).toBe(false);
    });

    it('REQ-DISC-005: rejects non-https schemes (ftp, file, data, javascript)', () => {
      expect(isUrlSafe('ftp://example.com')).toBe(false);
      expect(isUrlSafe('file:///etc/passwd')).toBe(false);
      expect(isUrlSafe('data:text/plain,hello')).toBe(false);
      expect(isUrlSafe('javascript:alert(1)')).toBe(false);
    });

    it('REQ-DISC-005: accepts https:// URLs to public hosts', () => {
      expect(isUrlSafe('https://example.com')).toBe(true);
      expect(isUrlSafe('https://api.github.com')).toBe(true);
      expect(isUrlSafe('https://blog.cloudflare.com/rss/')).toBe(true);
    });
  });

  describe('hostname — localhost and metadata', () => {
    it('REQ-DISC-005: rejects localhost', () => {
      expect(isUrlSafe('https://localhost')).toBe(false);
      expect(isUrlSafe('https://localhost/path')).toBe(false);
      expect(isUrlSafe('https://localhost:8080')).toBe(false);
    });

    it('REQ-DISC-005: rejects hosts with metadata. prefix (AWS/GCP IMDS)', () => {
      expect(isUrlSafe('https://metadata.google.internal')).toBe(false);
      expect(isUrlSafe('https://metadata.aws.amazon.com')).toBe(false);
      expect(isUrlSafe('https://metadata.example.internal')).toBe(false);
    });
  });

  describe('IPv4 private ranges', () => {
    it('REQ-DISC-005: rejects loopback 127.0.0.0/8', () => {
      expect(isUrlSafe('https://127.0.0.1')).toBe(false);
      expect(isUrlSafe('https://127.0.0.1:3000')).toBe(false);
      expect(isUrlSafe('https://127.1.2.3')).toBe(false);
    });

    it('REQ-DISC-005: rejects 10/8 private range', () => {
      expect(isUrlSafe('https://10.0.0.1')).toBe(false);
      expect(isUrlSafe('https://10.255.255.255')).toBe(false);
    });

    it('REQ-DISC-005: rejects 172.16/12 private range', () => {
      expect(isUrlSafe('https://172.16.0.1')).toBe(false);
      expect(isUrlSafe('https://172.20.10.5')).toBe(false);
      expect(isUrlSafe('https://172.31.255.254')).toBe(false);
    });

    it('REQ-DISC-005: accepts 172.x outside the 16-31 private band', () => {
      expect(isUrlSafe('https://172.15.0.1')).toBe(true);
      expect(isUrlSafe('https://172.32.0.1')).toBe(true);
    });

    it('REQ-DISC-005: rejects 192.168/16 private range', () => {
      expect(isUrlSafe('https://192.168.0.1')).toBe(false);
      expect(isUrlSafe('https://192.168.1.1')).toBe(false);
      expect(isUrlSafe('https://192.168.255.255')).toBe(false);
    });

    it('REQ-DISC-005: rejects link-local 169.254/16', () => {
      expect(isUrlSafe('https://169.254.169.254')).toBe(false);
      expect(isUrlSafe('https://169.254.0.1')).toBe(false);
    });

    it('REQ-DISC-005: rejects Cloudflare internal 100.64.0.0/10', () => {
      expect(isUrlSafe('https://100.64.0.1')).toBe(false);
      expect(isUrlSafe('https://100.100.100.100')).toBe(false);
      expect(isUrlSafe('https://100.127.255.254')).toBe(false);
    });

    it('REQ-DISC-005: accepts 100.x outside the 64-127 CGNAT band', () => {
      expect(isUrlSafe('https://100.63.255.255')).toBe(true);
      expect(isUrlSafe('https://100.128.0.1')).toBe(true);
    });

    it('REQ-DISC-005: accepts public IPv4 literals', () => {
      expect(isUrlSafe('https://8.8.8.8')).toBe(true);
      expect(isUrlSafe('https://1.1.1.1')).toBe(true);
    });
  });

  describe('IPv6 private ranges', () => {
    it('REQ-DISC-005: rejects IPv6 loopback ::1', () => {
      expect(isUrlSafe('https://[::1]')).toBe(false);
      expect(isUrlSafe('https://[::1]:8080')).toBe(false);
    });

    it('REQ-DISC-005: rejects IPv6 link-local fe80::/10', () => {
      expect(isUrlSafe('https://[fe80::1]')).toBe(false);
      expect(isUrlSafe('https://[fe80::abcd:1234]')).toBe(false);
      expect(isUrlSafe('https://[febf::1]')).toBe(false);
    });

    it('REQ-DISC-005: accepts public IPv6 literals', () => {
      expect(isUrlSafe('https://[2606:4700:4700::1111]')).toBe(true);
    });
  });

  describe('userinfo component', () => {
    it('REQ-DISC-005: rejects URLs containing @ (userinfo)', () => {
      expect(isUrlSafe('https://user@example.com')).toBe(false);
      expect(isUrlSafe('https://user:password@example.com')).toBe(false);
      expect(isUrlSafe('https://user@host@example.com')).toBe(false);
    });
  });

  describe('malformed input', () => {
    it('REQ-DISC-005: rejects unparseable URLs', () => {
      expect(isUrlSafe('not a url')).toBe(false);
      expect(isUrlSafe('')).toBe(false);
      expect(isUrlSafe('http://')).toBe(false);
      expect(isUrlSafe('://example.com')).toBe(false);
    });
  });
});

describe('assertUrlSafe', () => {
  it('REQ-DISC-005: returns void for safe URLs', () => {
    expect(() => assertUrlSafe('https://example.com')).not.toThrow();
    expect(() => assertUrlSafe('https://api.github.com')).not.toThrow();
  });

  it('REQ-DISC-005: throws for unsafe URLs', () => {
    expect(() => assertUrlSafe('http://example.com')).toThrow();
    expect(() => assertUrlSafe('https://127.0.0.1')).toThrow();
    expect(() => assertUrlSafe('https://user@example.com')).toThrow();
    expect(() => assertUrlSafe('not a url')).toThrow();
  });

  it('REQ-DISC-005: thrown error mentions the URL for debuggability', () => {
    try {
      assertUrlSafe('https://127.0.0.1');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('127.0.0.1');
    }
  });
});
