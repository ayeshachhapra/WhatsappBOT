/**
 * End-to-end smoke test for the email follow-up feature. Run against a live
 * server (the dev process must already be up).
 *
 *   npm run smoke:email-followup
 *   npm run smoke:email-followup -- --base http://localhost:5000
 *
 * What it does:
 *   1. Creates a temporary PO with a supplier email
 *   2. Creates an email follow-up for that PO
 *   3. Verifies the response includes a Gmail compose URL with the tracking tag
 *   4. Marks it sent
 *   5. Posts a fake Postmark inbound payload (with the tag in subject) to the
 *      webhook using basic-auth from .env
 *   6. Verifies the follow-up flipped to "replied" and the reply was matched
 *      via subject_tag
 *   7. Tries the SAME payload again and verifies idempotency (no duplicate row)
 *   8. Posts an UNAUTHENTICATED webhook call and verifies 401
 *   9. Posts an unmatched payload and verifies it persists with isMatched=false
 *  10. Cleans up the temporary PO (follow-ups + replies are left for inspection)
 */

import { config } from "../config";

interface Args {
  base: string;
}

function parseArgs(): Args {
  let base = process.env.SMOKE_BASE_URL || "http://localhost:5000";
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--base" && process.argv[i + 1]) {
      base = process.argv[i + 1];
      i++;
    }
  }
  return { base: base.replace(/\/$/, "") };
}

async function http<T>(
  method: string,
  url: string,
  init?: { body?: unknown; headers?: Record<string, string> }
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const { base } = parseArgs();
  console.log(`Smoke test against ${base}\n`);

  const password = config.emailFollowUps.webhookPassword;
  if (!password) {
    console.error(
      "INBOUND_WEBHOOK_PASSWORD is not set in .env — webhook calls will be rejected. Aborting."
    );
    process.exit(1);
  }
  const authHeader =
    "Basic " +
    Buffer.from(
      `${config.emailFollowUps.webhookUser}:${password}`
    ).toString("base64");

  // 1. Create PO
  const poNumber = `PO-SMOKE-${Date.now()}`;
  const poCreate = await http<{ id: string }>("POST", `${base}/api/purchase-orders`, {
    body: {
      poNumber,
      productName: "Smoke product",
      companyName: "Smoke supplier",
    },
  });
  assert(poCreate.status === 200, `Created PO ${poNumber}`);
  const poId = poCreate.body.id;

  // Set supplier email via PATCH
  const supplierEmail = `supplier+smoke@example.com`;
  const poPatch = await http("PATCH", `${base}/api/purchase-orders/${poId}`, {
    body: { supplierEmail, supplierName: "Smoke Sales" },
  });
  assert(poPatch.status === 200, "Patched PO with supplier email");

  // 2. Create follow-up
  const fuCreate = await http<{
    id: string;
    trackingTag: string;
    subject: string;
    gmailComposeUrl: string;
    mailtoUrl: string;
    ccEmails: string[];
  }>("POST", `${base}/api/email-follow-ups`, {
    body: {
      purchaseOrderId: poId,
      toEmail: supplierEmail,
      toName: "Smoke Sales",
      subject: "Status update on smoke order",
      body: "Hi, please share status. Thanks.",
    },
  });
  assert(fuCreate.status === 200, "Created follow-up");
  const fu = fuCreate.body;

  // 3. URL + tag sanity
  assert(/^[a-f0-9]{8}$/.test(fu.trackingTag), "Tracking tag is 8 hex chars");
  assert(fu.subject.includes(`[FU-${fu.trackingTag}]`), "Subject has tracking tag");
  assert(
    fu.ccEmails.includes(config.emailFollowUps.inboundCcEmail),
    `Cc includes ${config.emailFollowUps.inboundCcEmail}`
  );
  assert(
    fu.gmailComposeUrl.startsWith("https://mail.google.com/mail/?view=cm&fs=1"),
    "Gmail compose URL has correct base"
  );
  assert(
    fu.gmailComposeUrl.includes(encodeURIComponent(fu.subject).replace(/%20/g, "+")) ||
      fu.gmailComposeUrl.includes(encodeURIComponent(fu.subject)),
    "Gmail URL contains URL-encoded subject"
  );

  // 4. Mark sent
  const markSent = await http("POST", `${base}/api/email-follow-ups/${fu.id}/mark-sent`);
  assert(markSent.status === 200, "Mark-sent succeeded");

  // 5. Fake Postmark inbound payload (subject-tag match)
  const postmarkPayload = makePostmarkPayload({
    messageId: `<smoke-${Date.now()}-1@example.com>`,
    fromEmail: supplierEmail,
    fromName: "Smoke Sales",
    toEmail: config.emailFollowUps.inboundCcEmail,
    subject: `RE: ${fu.subject}`,
    text: "Update: shipping on Friday.\n\n> Original message",
    stripped: "Update: shipping on Friday.",
  });
  const webhookRes = await http<{
    ok: boolean;
    matched: boolean;
    matchMethod: string;
  }>("POST", `${base}/api/webhooks/inbound-email`, {
    body: postmarkPayload,
    headers: { Authorization: authHeader },
  });
  assert(webhookRes.status === 200, "Webhook accepted authenticated payload");
  assert(webhookRes.body.matched === true, "Reply matched");
  assert(
    webhookRes.body.matchMethod === "subject_tag",
    `Match method is subject_tag (got ${webhookRes.body.matchMethod})`
  );

  // 6. Follow-up flipped to "replied"
  const list = await http<{ followUps: Array<{ status: string; replies: any[] }> }>(
    "GET",
    `${base}/api/email-follow-ups?purchaseOrderId=${poId}`
  );
  assert(list.status === 200, "List endpoint OK");
  const f = list.body.followUps.find((x) => (x as any)._id === fu.id) ||
    list.body.followUps[0];
  assert(f.status === "replied", `Follow-up status is "replied" (got "${f.status}")`);
  assert(f.replies.length === 1, "Exactly one reply linked");

  // 7. Idempotency: same MessageID twice
  const dupe = await http<{ duplicate?: boolean }>(
    "POST",
    `${base}/api/webhooks/inbound-email`,
    {
      body: postmarkPayload,
      headers: { Authorization: authHeader },
    }
  );
  assert(dupe.status === 200 && dupe.body.duplicate === true, "Duplicate webhook is idempotent");
  const list2 = await http<{ followUps: Array<{ replies: any[] }> }>(
    "GET",
    `${base}/api/email-follow-ups?purchaseOrderId=${poId}`
  );
  assert(
    list2.body.followUps[0].replies.length === 1,
    "Still exactly one reply after duplicate webhook"
  );

  // 8. Auth required
  const noAuth = await http("POST", `${base}/api/webhooks/inbound-email`, {
    body: makePostmarkPayload({
      messageId: `<smoke-${Date.now()}-noauth@example.com>`,
      fromEmail: supplierEmail,
      toEmail: config.emailFollowUps.inboundCcEmail,
      subject: "No auth",
      text: "x",
    }),
  });
  assert(noAuth.status === 401, "Unauthenticated webhook returns 401");

  // 9. Unmatched payload (no tag, unknown sender)
  const unmatched = await http<{ matched: boolean; matchMethod: string }>(
    "POST",
    `${base}/api/webhooks/inbound-email`,
    {
      body: makePostmarkPayload({
        messageId: `<smoke-${Date.now()}-unmatched@example.com>`,
        fromEmail: `unknown-${Date.now()}@example.com`,
        toEmail: config.emailFollowUps.inboundCcEmail,
        subject: "Just saying hi",
        text: "Hello",
      }),
      headers: { Authorization: authHeader },
    }
  );
  assert(
    unmatched.status === 200 && unmatched.body.matched === false,
    "Unmatched payload persisted with matched=false"
  );

  // 10. Cleanup
  await http("DELETE", `${base}/api/purchase-orders/${poId}`);
  console.log("\nAll checks passed. Temporary PO deleted; follow-ups and replies retained for inspection.");
}

function makePostmarkPayload(p: {
  messageId: string;
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  subject: string;
  text: string;
  stripped?: string;
}) {
  return {
    MessageID: p.messageId,
    From: p.fromName ? `${p.fromName} <${p.fromEmail}>` : p.fromEmail,
    FromFull: { Email: p.fromEmail, Name: p.fromName || "" },
    To: p.toEmail,
    ToFull: [{ Email: p.toEmail, Name: "" }],
    Cc: "",
    CcFull: [],
    Subject: p.subject,
    TextBody: p.text,
    HtmlBody: `<p>${p.text.replace(/\n/g, "<br>")}</p>`,
    StrippedTextReply: p.stripped || "",
    Headers: [],
    Date: new Date().toUTCString(),
  };
}

main().catch((err) => {
  console.error("Smoke run failed:", err);
  process.exit(1);
});
