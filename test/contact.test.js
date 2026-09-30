import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contactLink } from '../public/lib/contact.js';

describe('tapping a contact', () => {
  it('texts a phone number, whatever its punctuation', () => {
    assert.equal(contactLink('(706) 555-0142').href, 'sms:7065550142');
    assert.equal(contactLink('706.555.0142').href, 'sms:7065550142');
    assert.equal(contactLink('+1 706 555 0142').href, 'sms:+17065550142');
  });

  it('emails an email address', () => {
    assert.deepEqual(contactLink(' marisol@example.com '), {
      href: 'mailto:marisol@example.com',
      label: 'Email',
      kind: 'email',
    });
  });

  it('leaves anything else as plain text', () => {
    assert.equal(contactLink('call my wife'), null);
    assert.equal(contactLink('555'), null);
    assert.equal(contactLink(''), null);
  });
});
