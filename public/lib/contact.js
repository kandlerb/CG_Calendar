// Turning the phone number or email someone left into something an organizer
// can tap. Only organizers (and the person themselves) are ever sent one.

/**
 * A link for `contact`: a text message for something that looks like a phone
 * number, an email for an address, or null for anything else, which is then
 * shown as plain text.
 */
export function contactLink(contact) {
  const value = String(contact ?? '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { href: `mailto:${value}`, label: 'Email', kind: 'email' };
  }
  // Phone numbers come in every shape: (706) 555-0142, 706.555.0142, +1 706…
  if (/^[+\d\s().-]+$/.test(value)) {
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      const plus = value.startsWith('+') ? '+' : '';
      return { href: `sms:${plus}${digits}`, label: 'Text', kind: 'phone' };
    }
  }
  return null;
}
