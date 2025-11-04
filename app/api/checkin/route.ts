// app/routes/checkin/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const bodySchema = z.object({
  ticketCode: z.string().min(1),
  terminalId: z.string().optional(),
  actorId: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.format() },
        { status: 400 }
      );
    }

    const { ticketCode, terminalId, actorId } = parsed.data;

    // 1) Find the ticket
    const { data: ticket, error: findErr } = await supabaseAdmin
      .from("tickets")
      .select("id, ticket_code")
      .eq("ticket_code", ticketCode)
      .maybeSingle();

    if (findErr) {
      console.error("Find ticket error:", findErr);
      return NextResponse.json(
        { ok: false, error: "server_error" },
        { status: 500 }
      );
    }

    if (!ticket) {
      return NextResponse.json(
        { ok: false, message: "Ticket not found" },
        { status: 404 }
      );
    }

    // 2) Try to insert check-in log (let DB handle uniqueness)
    const { data: checkinLog, error: insertErr } = await supabaseAdmin
      .from("checkin_log")
      .insert({
        ticket_id: ticket.id,
        ticket_code: ticketCode,
        success: true,
        message: "Checked in",
        terminal_id: terminalId ?? "web",
        actor_id: actorId ?? null,
      })
      .select()
      .maybeSingle();

    // 3) Handle duplicate check-in (unique constraint violation)
    if (insertErr?.code === "23505") {
      // Fetch existing check-in
      const { data: existingLog } = await supabaseAdmin
        .from("checkin_log")
        .select("*")
        .eq("ticket_id", ticket.id)
        .eq("success", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return NextResponse.json(
        {
          ok: false,
          message: "Ticket already checked in",
          ticket,
          checkin_log: existingLog,
        },
        { status: 409 }
      );
    }

    // 4) Handle other insert errors
    if (insertErr) {
      console.error("Insert checkin_log error:", insertErr);
      return NextResponse.json(
        { ok: false, error: "server_error" },
        { status: 500 }
      );
    }

    // 5) Trigger print job (if terminal provided and print job exists)
    if (terminalId) {
      try {
        const { data: printJob, error: printErr } = await supabaseAdmin
          .from("print_jobs")
          .update({
            status: "ready_to_print",
            terminal_id: terminalId,
            updated_at: new Date().toISOString(),
          })
          .eq("ticket_id", ticket.id)
          .eq("status", "pending") // Only update if still pending
          .select()
          .maybeSingle();

        if (printErr) {
          console.error("Error updating print job:", printErr);
          // Don't fail the check-in, just log the error
        } else if (!printJob) {
          console.warn(`No pending print job found for ticket ${ticket.id}`);
          // This is okay - maybe printing is optional or not set up yet
        }
      } catch (printError) {
        console.error("Unexpected error triggering print:", printError);
        // Don't fail the check-in for print errors
      }
    }

    // 6) Success!
    return NextResponse.json(
      {
        ok: true,
        message: "Checked in",
        ticket,
        checkin_log: checkinLog,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in checkin route:", err);
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 500 }
    );
  }
}
