import { describe, expect, it } from 'vitest';
import { compareVersions, downloadFor } from './UpdateBanner';

describe('compareVersions', () => {
  it('orders semver with or without v prefix', () => {
    expect(compareVersions('v0.4.0', '0.3.0')).toBe(1);
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.3', '0.3.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });
});

describe('downloadFor', () => {
  const rel = { tag_name: 'v0.4.0', html_url: 'https://example/rel', assets: [
    { name: 'bangdb-manager-v0.4.0-android-debug.apk', browser_download_url: 'https://example/apk' },
    { name: 'bangdb-manager-web-v0.4.0.zip', browser_download_url: 'https://example/zip' }
  ] };
  it('picks the apk on android and the page otherwise', () => {
    expect(downloadFor(rel, 'android')).toBe('https://example/apk');
    expect(downloadFor(rel, 'web')).toBe('https://example/zip');
    expect(downloadFor(rel, 'ios')).toBe('https://example/rel');
    expect(downloadFor({ tag_name: 'v1', html_url: 'https://example/rel' }, 'android')).toBe('https://example/rel');
  });
});
