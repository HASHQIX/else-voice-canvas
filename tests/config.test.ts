import { expect, it, vi, afterEach } from 'vitest';
import { appOrigin } from '../server/config.js';

afterEach(() => vi.unstubAllEnvs());
it('rejects a missing or insecure public origin before starting the production demo', () => {
  vi.stubEnv('APP_ORIGIN', '');
  expect(() => appOrigin(true)).toThrow('Production requires APP_ORIGIN');
  expect(() => appOrigin(true,'http://demo.example')).toThrow('HTTPS');
  expect(appOrigin(false)).toBe('http://localhost:3000');
});
it('normalizes a trailing slash and accepts an explicit HTTPS port', () => {
  expect(appOrigin(true,'https://else.example/')).toBe('https://else.example');
  expect(appOrigin(true,'https://else.example:8443')).toBe('https://else.example:8443');
});
it.each(['demo.example','ftp://demo.example','https://user:password@demo.example','https://demo.example/app','https://demo.example/?test=1','https://demo.example/#app'])(
  'rejects an origin that cannot match browser Origin headers: %s', value => {
    expect(() => appOrigin(true,value)).toThrow('APP_ORIGIN');
  },
);
