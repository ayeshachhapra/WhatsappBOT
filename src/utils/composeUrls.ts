/**
 * Builds the URLs we hand back to the frontend so it can pop a pre-filled
 * compose window. We deliberately do NOT send anything ourselves — the user
 * reviews and hits Send in their own mail client. Two flavours:
 *
 *  - Gmail web compose ("view=cm&fs=1") — works for users signed into Gmail.
 *  - Plain mailto: — falls back to the OS default mail handler.
 *
 * The mailto spec does not support custom headers (Reply-To etc.), so the
 * caller must include the inbound-cc address in `cc` for the capture path
 * to work via Reply All.
 */

export interface ComposeUrlInput {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
}

const GMAIL_COMPOSE_BASE = "https://mail.google.com/mail/?view=cm&fs=1";

export function buildGmailComposeUrl(input: ComposeUrlInput): string {
  const params = new URLSearchParams();
  params.set("to", input.to);
  if (input.cc && input.cc.length > 0) params.set("cc", input.cc.join(","));
  params.set("su", input.subject);
  params.set("body", input.body);
  return `${GMAIL_COMPOSE_BASE}&${params.toString()}`;
}

export function buildMailtoUrl(input: ComposeUrlInput): string {
  const params = new URLSearchParams();
  if (input.cc && input.cc.length > 0) params.set("cc", input.cc.join(","));
  params.set("subject", input.subject);
  params.set("body", input.body);
  return `mailto:${encodeURIComponent(input.to)}?${params.toString()}`;
}
