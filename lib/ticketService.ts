// lib/ticketService.ts
import QRCode from "qrcode";
import { supabaseAdmin } from "./supabaseAdmin";
import { sendTicketEmail } from "./emailService";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { uploadPdfAndEnqueuePrint } from "./printService";

function makeTicketCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// helper: convert dataURL to buffer
function dataUrlToBuffer(dataUrl: string) {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid data url");
  const base64 = matches[2];
  return Buffer.from(base64, "base64");
}

// generate a simple PDF (A6-ish width) with QR image and text; returns base64 string
async function generateTicketPdfBase64(options: {
  ticketCode: string;
  attendeeName?: string | null;
  eventName?: string | null;
  qrDataUrl: string;
}) {
  const { ticketCode, attendeeName, eventName, qrDataUrl } = options;

  // create PDF
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([300, 420]); // small ticket size (points)

  // embed font
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // embed PNG image (from data URL)
  const pngBytes = dataUrlToBuffer(qrDataUrl);
  const pngImage = await pdfDoc.embedPng(pngBytes);

  // layout
  const { width, height } = page.getSize();

  // Draw header
  const headerText = eventName ?? "Event Ticket";
  page.drawText(headerText, {
    x: 14,
    y: height - 32,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });

  // Draw attendee name
  if (attendeeName) {
    page.drawText(attendeeName, {
      x: 14,
      y: height - 56,
      size: 11,
      font: fontNormal,
    });
  }

  // Draw ticket code
  page.drawText(`Code: ${ticketCode}`, {
    x: 14,
    y: height - 78,
    size: 11,
    font: fontNormal,
  });

  // Draw QR image on the right
  const qrDims = 160;
  page.drawImage(pngImage, {
    x: width - qrDims - 14,
    y: height - qrDims - 40,
    width: qrDims,
    height: qrDims,
  });

  // small note
  page.drawText("Show this QR at the entrance", {
    x: 14,
    y: 28,
    size: 9,
    font: fontNormal,
  });

  const pdfBytes = await pdfDoc.save();
  const base64 = Buffer.from(pdfBytes).toString("base64");
  return base64;
}

export async function findTicketByAttendee(attendeeId: string) {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .select("id, ticket_code, meta")
    .eq("attendee_id", attendeeId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertTicket(
  att: any,
  ticketCode: string,
  qrDataUrl: string
) {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .insert([
      {
        event_id: att.event_id,
        attendee_id: att.id,
        ticket_code: ticketCode,
        qr_payload: ticketCode,
        meta: { qrDataUrl, importedMeta: att.meta ?? {} },
      },
    ])
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertEmailJob(
  ticketId: string | null,
  recipient: string,
  subject: string,
  body: string
) {
  const { data, error } = await supabaseAdmin
    .from("email_jobs")
    .insert([
      {
        ticket_id: ticketId,
        recipient,
        subject,
        body,
        status: "pending",
      },
    ])
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Build and send ticket for a single attendee record.
 * Returns { ok, attendeeId, ticketCode, error? }
 */
export async function buildAndSendTicketForAttendee(
  att: any,
  forceResend = false
) {
  if (!att || !att.email)
    return { ok: false, reason: "no-email", attendeeId: att?.id };

  // helpers
  function escapeHtml(str: string) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toTitleCase(s: string) {
    return String(s || "")
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  function getRecipientFirstName(att: any) {
    const first =
      att.first_name ??
      (att.name ? String(att.name).trim().split(/\s+/)[0] : "");
    return toTitleCase(first || "");
  }

  // 1) Find existing ticket
  const existing = await findTicketByAttendee(att.id);
  if (existing && !forceResend) {
    return {
      ok: false,
      reason: "ticket_exists",
      attendeeId: att.id,
      ticketCode: existing.ticket_code,
    };
  }

  // 2) Ticket code + QR (we produce both a data URL for PDF and a raw base64 buffer for CID)
  const ticketCode = existing?.ticket_code ?? makeTicketCode();
  const qrDataUrl = await QRCode.toDataURL(ticketCode, {
    width: 400,
    margin: 1,
  }); // data:image/png;base64,...
  // strip "data:image/png;base64," prefix to get pure base64
  const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const qrBuffer = Buffer.from(qrBase64, "base64");

  // 3) Insert or update ticket record
  let insertedTicket = existing ?? null;
  if (!existing) {
    insertedTicket = await insertTicket(att, ticketCode, qrDataUrl);
  } else if (forceResend) {
    const newMeta = { ...(existing.meta ?? {}), qrDataUrl };
    await supabaseAdmin
      .from("tickets")
      .update({ meta: newMeta })
      .eq("id", existing.id);
  }

  // 4) Generate PDF (base64)
  let pdfBase64: string | null = null;
  try {
    pdfBase64 = await generateTicketPdfBase64({
      ticketCode,
      attendeeName: att.name ?? null,
      eventName: undefined,
      qrDataUrl, // keep using data URL for PDF generation
    });
  } catch (e) {
    console.error("[ticketService] PDF generation failed", e);
    pdfBase64 = null;
  }

  // 5) Upload PDF & enqueue print job (best-effort; do not block email)
  if (pdfBase64) {
    try {
      const evId = att.event_id ?? process.env.EVENT_ID ?? "unknown-event";
      const printJob = await uploadPdfAndEnqueuePrint(
        evId,
        ticketCode,
        pdfBase64,
        insertedTicket?.id ?? null,
        "auto-email"
      );
      console.log("[ticketService] enqueued print job", printJob?.id ?? null);
    } catch (uplErr) {
      console.warn(
        "[ticketService] upload/enqueue print failed (continuing) ",
        String(uplErr)
      );
      // continue — email will still be sent
    }
  }

  // 6) Prepare banner and email HTML with CID QR placeholder (no plain text)
  const publicUrl = process.env.PUBLIC_URL ?? "";
  const bannerUrl = `${publicUrl}/banner.jpg`;
  const recipientFirstName = escapeHtml(getRecipientFirstName(att));

  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
    </head>
    <body style="margin:0;padding:0;font-family: Arial, Helvetica, sans-serif;background-color:#f4f6f7;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:0 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 14px rgba(7,20,11,0.08);">
              <!-- Banner -->
              <tr>
                <td style="padding:0;">
                  <img src="${bannerUrl}" alt="Event banner" style="display:block;width:100%;height:auto;" />
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:28px 36px;color:#0b2a1a;">
                  <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#0b2a1a;">Check-In Pass</h1>
                  <p style="margin:0 0 16px;font-size:14px;color:#222;">Hello ${
                    recipientFirstName || "there"
                  },</p>

                  <p style="margin:0 0 18px;font-size:15px;color:#333;">
                    We are pleased to confirm your participation in the <strong>8th Annual Convention on Impact Investing</strong>, hosted by the Impact Investors Foundation.
                  </p>

                  <p style="margin:0 0 18px;font-size:15px;color:#333;">
                    To ensure a smooth and efficient check-in, we have provided your unique QR code below. You only need to present one version at the registration desk.
                  </p>

                  <p style="margin:18px 0;text-align:center;">
                    <!-- QR displayed inline via CID -->
                    <img src="cid:ticketqr" alt="Ticket QR Code" style="max-width:300px;width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;" />
                  </p>

                  <p style="margin:8px 0 6px;font-size:13px;color:#555;">
                    For your convenience, your check-in pass (containing the same QR code) is also attached to this email as a PDF. You can save this file or print it.
                  </p>

                  <h3 style="font-size:15px;margin:16px 0 8px;color:#0b2a1a;">Event Details:</h3>
                  <ul style="margin:0 0 12px 18px;color:#333;font-size:14px;">
                    <li><strong>Event:</strong> 8th Annual Convention on Impact Investing</li>
                    <li><strong>Hosted By:</strong> Impact Investors Foundation</li>
                    <li><strong>Date:</strong> 5th - 6th November 2025</li>
                    <li><strong>Venue:</strong> Civic Centre, Lagos</li>
                    <li><strong>Time:</strong> 8am</li>
                  </ul>

                  <p style="margin:12px 0 0;color:#333;font-size:14px;">
                    If you have any questions or encounter issues viewing your QR code, please contact our team at <a href="mailto:events@swatleadershipacademy.com" style="color:#0b6b3a;text-decoration:none;">events@swatleadershipacademy.com</a>.
                  </p>

                  <div style="margin-top:22px;color:#444;font-size:13px;">
                    <p style="margin:0;">We look forward to welcoming you.</p>
                    <p style="margin-top:18px;">Best regards,<br/>The SWAT Events<br/>Registrations Management for the Impact Investors Foundation</p>
                  </div>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background:#f7f9f7;padding:14px 36px;color:#6b756f;font-size:12px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;">
                    <div>&copy; ${new Date().getFullYear()} Impact Investors Foundation</div>
                    <div style="margin-top:6px;"><a href="https://yourdomain.com" style="color:#0b6b3a;text-decoration:none;">yourdomain.com</a></div>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  // 7) Create email job record (HTML-only)
  const emailJob = await upsertEmailJob(
    insertedTicket?.id ?? null,
    att.email,
    `Check-In Pass: 8th Annual Convention on Impact Investing`,
    html
  );

  // 8) Prepare attachments:
  // - PDF as before (base64)
  // - QR image attached inline with cid 'ticketqr' so it displays in-body
  const attachments: any[] = [];

  if (pdfBase64) {
    attachments.push({
      filename: `ticket-${ticketCode}.pdf`,
      type: "application/pdf",
      base64: pdfBase64,
    });
  }

  // attach the QR as inline image (base64) with content id 'ticketqr'
  // many mailers accept { filename, type, base64, cid, disposition: 'inline' }
  attachments.push({
    filename: `ticket-${ticketCode}-qr.png`,
    type: "image/png",
    base64: qrBase64,
    cid: "ticketqr",
    disposition: "inline",
  });

  // 9) Send email including attachments
  try {
    const sendResult = await sendTicketEmail(
      att.email,
      `Check-In Pass: 8th Annual Convention on Impact Investing`,
      html,
      attachments
    );

    console.log("[ticketService] sendResult:", sendResult);

    if (sendResult.ok) {
      const sendResp = sendResult.resp;
      if (emailJob?.id) {
        await supabaseAdmin
          .from("email_jobs")
          .update({
            status: "sent",
            external_id: (sendResp as any)?.id ?? JSON.stringify(sendResp),
            updated_at: new Date().toISOString(),
          })
          .eq("id", emailJob.id);
      }
      return { ok: true, attendeeId: att.id, ticketCode, sendResp };
    } else {
      const errMsg = sendResult.error ?? "unknown";
      console.error("[ticketService] send failed:", errMsg, sendResult.raw);
      if (emailJob?.id) {
        await supabaseAdmin
          .from("email_jobs")
          .update({
            status: "failed",
            attempt_count: (emailJob.attempt_count ?? 0) + 1,
            last_error: errMsg,
            updated_at: new Date().toISOString(),
          })
          .eq("id", emailJob.id);
      }
      return {
        ok: false,
        reason: "email_failed",
        attendeeId: att.id,
        error: errMsg,
      };
    }
  } catch (err: any) {
    const errMsg = String(err?.message ?? err);
    console.error("[ticketService] send exception", errMsg);
    if (emailJob?.id) {
      await supabaseAdmin
        .from("email_jobs")
        .update({
          status: "failed",
          attempt_count: (emailJob.attempt_count ?? 0) + 1,
          last_error: errMsg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", emailJob.id);
    }
    return {
      ok: false,
      reason: "email_failed",
      attendeeId: att.id,
      error: errMsg,
    };
  }
}

/** small helper to avoid injection in attendee names */
// function escapeHtml(str: string) {
//   return String(str)
//     .replace(/&/g, "&amp;")
//     .replace(/</g, "&lt;")
//     .replace(/>/g, "&gt;")
//     .replace(/"/g, "&quot;")
//     .replace(/'/g, "&#039;");
// }
