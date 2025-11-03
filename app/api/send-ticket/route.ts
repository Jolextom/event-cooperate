// app/api/send-ticket/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildAndSendTicketForAttendee } from "@/lib/ticketService";

const bodySchema = z.object({
  attendeeId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  resend: z.boolean().optional(),
});

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success)
      return NextResponse.json(
        { ok: false, error: parsed.error.format() },
        { status: 400 }
      );

    const { attendeeId, eventId, resend } = parsed.data;

    if (attendeeId) {
      const { data: att } = await supabaseAdmin
        .from("attendees")
        .select("*")
        .eq("id", attendeeId)
        .maybeSingle();
      if (!att)
        return NextResponse.json(
          { ok: false, error: "attendee not found" },
          { status: 404 }
        );
      const r = await buildAndSendTicketForAttendee(att, !!resend);
      return NextResponse.json(r);
    }

    if (eventId) {
      const { data: attendees } = await supabaseAdmin
        .from("attendees")
        .select("*")
        .eq("event_id", eventId);
      if (!attendees || attendees.length === 0)
        return NextResponse.json(
          { ok: false, error: "no attendees found" },
          { status: 404 }
        );

      const results: any[] = [];
      for (const a of attendees) {
        // skip existing unless resend requested
        const { data: existing } = await supabaseAdmin
          .from("tickets")
          .select("id")
          .eq("attendee_id", a.id)
          .limit(1)
          .maybeSingle();
        if (existing && !resend) {
          results.push({
            ok: false,
            reason: "ticket_exists",
            attendeeId: a.id,
          });
          continue;
        }
        // optionally throttle if you want: await new Promise(r => setTimeout(r, 25));
        const r = await buildAndSendTicketForAttendee(a, !!resend);
        results.push(r);
      }
      return NextResponse.json({ ok: true, results });
    }

    return NextResponse.json(
      { ok: false, error: "attendeeId or eventId required" },
      { status: 400 }
    );
  } catch (err: any) {
    console.error("send-ticket route error", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
