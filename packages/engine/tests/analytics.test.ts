import { describe, expect, it } from 'vitest';
import {
  analyticsConsentStorageKey,
  classifyAttribution,
  classifyConversion,
  createAnalyticsPayload,
  isApprovedNavigation,
  isApprovedPrimaryCta,
  parseAnalyticsConfig,
} from '../src/analytics.js';

describe('ENG-025 analytics policy', () => {
  const config = parseAnalyticsConfig({
    endpoint: 'https://collector.example/events',
    navigationPaths: '["/about"]',
    primaryCtaPaths: '["/contact"]',
  })!;
  it('fails closed for invalid configuration and limits payload fields', () => {
    expect(
      parseAnalyticsConfig({ endpoint: 'http://collector.example/events' }),
    ).toBeUndefined();
    expect(
      parseAnalyticsConfig({
        endpoint: 'https://collector.example/events',
        events: '["page_view","bad"]',
      }),
    ).toBeUndefined();
    expect(
      parseAnalyticsConfig({
        endpoint: 'https://collector.example/events',
        navigationPaths: '["/about?q=x"]',
      }),
    ).toBeUndefined();
    expect(
      createAnalyticsPayload('form_accepted', '/contact', 'search', 'inquiry'),
    ).toEqual({
      event: 'form_accepted',
      path: '/contact',
      attribution: 'search',
      form: 'inquiry',
    });
  });
  it('rejects deceptive attribution and internal referrals', () => {
    expect(
      classifyAttribution({
        search: '?utm_source=google',
        referrer: '',
        currentOrigin: 'https://site.example',
      }),
    ).toBe('search');
    expect(
      classifyAttribution({
        search: '?utm_source=google.evil',
        referrer: '',
        currentOrigin: 'https://site.example',
      }),
    ).toBeUndefined();
    expect(
      classifyAttribution({
        search: '',
        referrer: 'https://evil-google.com/x',
        currentOrigin: 'https://site.example',
      }),
    ).toBe('referral');
    expect(
      classifyAttribution({
        search: '',
        referrer: 'https://site.example/x',
        currentOrigin: 'https://site.example',
      }),
    ).toBeUndefined();
  });
  it('requires explicit destination approval and valid conversions', () => {
    expect(
      isApprovedNavigation({
        sameOrigin: true,
        inNavigation: true,
        pathname: '/about/',
        config,
      }),
    ).toBe(true);
    expect(
      isApprovedNavigation({
        sameOrigin: true,
        inNavigation: true,
        pathname: '/other',
        config,
      }),
    ).toBe(false);
    expect(
      isApprovedPrimaryCta({
        sameOrigin: false,
        markedPrimary: true,
        pathname: '/contact',
        config,
      }),
    ).toBe(false);
    expect(classifyConversion({ form: 'inquiry', accepted: false })).toEqual({
      event: 'form_failed',
      form: 'inquiry',
    });
    expect(
      classifyConversion({ form: 'inquiry', accepted: 'false' }),
    ).toBeUndefined();
    expect(analyticsConsentStorageKey('https://a.example/e')).not.toBe(
      analyticsConsentStorageKey('https://b.example/e'),
    );
  });
});

describe('ENG-025 adversarial input boundaries', () => {
  it.each([
    { endpoint: undefined },
    { endpoint: 'https://user:secret@collector.example/events' },
    { endpoint: 'https://collector.example/events', events: '{broken' },
    { endpoint: 'https://collector.example/events', events: {} },
    { endpoint: 'https://collector.example/events', events: [1] },
    {
      endpoint: 'https://collector.example/events',
      navigationPaths: ['//other.example/'],
    },
    {
      endpoint: 'https://collector.example/events',
      primaryCtaPaths: ['/contact#private'],
    },
    {
      endpoint: 'https://collector.example/events',
      primaryCtaPaths: ['/a/../contact'],
    },
  ])('disables malformed configuration %j', (input) => {
    expect(parseAnalyticsConfig(input)).toBeUndefined();
  });

  it('preserves an intentionally empty event allowlist', () => {
    expect(
      parseAnalyticsConfig({
        endpoint: 'https://collector.example/events',
        events: [],
      })?.events,
    ).toEqual([]);
  });

  it.each([
    ['unknown', '/contact', undefined, undefined],
    ['page_view', '/contact?email=private', undefined, undefined],
    ['page_view', '/contact#private', undefined, undefined],
    ['page_view', 'https://other.example/contact', undefined, undefined],
    ['page_view', '/contact', 'private campaign text', undefined],
    ['page_view', '/contact', {}, undefined],
    ['page_view', '/contact', undefined, 'inquiry'],
    ['form_accepted', '/contact', undefined, undefined],
    ['form_failed', '/contact', undefined, 'unknown'],
    ['form_failed', '/contact', undefined, { toString: () => 'inquiry' }],
  ])(
    'rejects a payload outside the public schema (%s)',
    (event, path, attribution, form) => {
      expect(
        createAnalyticsPayload(event, path, attribution, form),
      ).toBeUndefined();
    },
  );

  it.each([
    ['', '', 'direct'],
    ['?utm_source=chatgpt', '', 'ai_assistant'],
    ['?utm_source=google', '', 'search'],
    ['', 'https://www.bing.com/search?q=private', 'search'],
    ['', 'https://claude.ai/chat/private', 'ai_assistant'],
    ['', 'https://external.example/article', 'referral'],
    ['', 'https://google.com.evil.example/', 'referral'],
    ['', 'https://constructor/', 'referral'],
    ['?utm_source=constructor', '', undefined],
    ['?utm_source=__proto__', '', undefined],
    ['?utm_source=paid-search-campaign', '', undefined],
    ['?utm_source=', '', undefined],
    ['', 'not a url', undefined],
    ['', 'https://site.example/internal', undefined],
  ])(
    'classifies only supplied recognized attribution (%s %s)',
    (search, referrer, expected) => {
      expect(
        classifyAttribution({
          search: search!,
          referrer: referrer!,
          currentOrigin: 'https://site.example',
        }),
      ).toBe(expected);
    },
  );

  it('rejects non-string conversion forms without invoking coercion', () => {
    const form = {
      toString: () => {
        throw new Error('must not run');
      },
    };
    expect(classifyConversion({ form, accepted: true })).toBeUndefined();
    expect(
      classifyConversion({
        form: 'application',
        accepted: true,
        email: 'private@example.test',
        message: 'private',
      }),
    ).toEqual({ event: 'form_accepted', form: 'application' });
    expect(createAnalyticsPayload('page_view', '/', undefined)).toEqual({
      event: 'page_view',
      path: '/',
    });
  });
});
